import * as fs from 'fs';

// Remove the per-run snapshot DB created for the test server (see
// playwright.config.ts). The server process is killed by Playwright, so it
// cannot clean up after itself.
export default function globalTeardown(): void {
  const dbPath = process.env.GHINBOX_SNAPSHOT_DB_PATH;
  if (!dbPath || !dbPath.includes('ghinbox_snapshot_e2e_')) {
    return;
  }
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}
