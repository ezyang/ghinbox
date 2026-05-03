/**
 * Custom Playwright fixtures that provide per-worker server isolation.
 *
 * Each Playwright worker gets its own server instance with a unique
 * SQLite database, preventing cross-test state contamination.
 */
import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export { expect };

/** Find a free port by briefly binding to port 0. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

/** Poll a URL until it returns 200 or timeout. */
async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

type WorkerServer = {
  port: number;
  baseURL: string;
  process: ChildProcess;
  dbPath: string;
};

export const test = base.extend<{}, { workerServer: WorkerServer }>({
  workerServer: [
    async ({}, use, workerInfo) => {
      const port = await getFreePort();
      const dbPath = path.join(
        os.tmpdir(),
        `ghinbox_test_worker_${workerInfo.workerIndex}.db`
      );

      // Clean up any stale DB from a previous run
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suffix);
        } catch {
          // File doesn't exist, fine
        }
      }

      const serverProcess = spawn(
        'uv',
        [
          'run',
          'python',
          '-m',
          'ghinbox.api.server',
          '--test',
          '--no-reload',
          '--port',
          String(port),
          '--db-path',
          dbPath,
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          stdio: 'pipe',
          env: { ...process.env },
        }
      );

      // Log server stderr for debugging
      serverProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          // Only log errors, not routine "needs_login check" spam
          if (!msg.includes('needs_login check')) {
            process.stderr.write(`[Worker ${workerInfo.workerIndex}] ${msg}\n`);
          }
        }
      });

      const baseURL = `http://localhost:${port}/app/`;

      await waitForServer(`http://localhost:${port}/health/test`);

      await use({ port, baseURL, process: serverProcess, dbPath });

      // Teardown: kill server and clean up DB
      serverProcess.kill('SIGTERM');
      // Wait briefly for graceful shutdown
      await new Promise((r) => setTimeout(r, 500));
      if (serverProcess.exitCode === null) {
        serverProcess.kill('SIGKILL');
      }

      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suffix);
        } catch {
          // Already cleaned up
        }
      }
    },
    { scope: 'worker', auto: true },
  ],

  // Override baseURL to use the worker's server
  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },
});
