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
});
