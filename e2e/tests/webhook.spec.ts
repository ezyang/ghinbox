import { createHmac } from 'crypto';
import { test, expect } from '@playwright/test';

test.describe('GitHub deployment webhook', () => {
  test('accepts a signed non-main push without deploying @smoke', async ({ request }) => {
    const payload = JSON.stringify({
      ref: 'refs/heads/feature',
      repository: { full_name: 'ezyang/ghinbox' },
    });
    const signature = createHmac('sha256', 'e2e-webhook-secret')
      .update(payload)
      .digest('hex');

    const response = await request.post('/webhooks/github/push', {
      data: payload,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': `sha256=${signature}`,
      },
    });

    expect(response.status()).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: 'ignored',
      reason: 'not main',
    });
  });

  test('accepts GitHub form-encoded ping delivery without deploying @smoke', async ({ request }) => {
    const event = JSON.stringify({
      zen: 'Keep it logically awesome.',
      repository: { full_name: 'ezyang/ghinbox' },
    });
    const payload = new URLSearchParams({ payload: event }).toString();
    const signature = createHmac('sha256', 'e2e-webhook-secret')
      .update(payload)
      .digest('hex');

    const response = await request.post('/webhooks/github/push', {
      data: payload,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': `sha256=${signature}`,
      },
    });

    expect(response.status()).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: 'ignored',
      reason: 'not push',
    });

    const requestId = response.headers()['x-ghinbox-request-id'];
    const auditResponse = await request.get('/debug/deployments');
    expect(auditResponse.status()).toBe(200);
    const deployments = (await auditResponse.json()).deployments;
    const audit = deployments.find((entry: { request_id: string }) => entry.request_id === requestId);
    expect(audit).toEqual(expect.objectContaining({
      github_event: 'ping',
      repository: 'ezyang/ghinbox',
      status: 'ignored',
      reason: 'not push',
    }));
  });
});
