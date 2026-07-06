import { test, expect } from '@playwright/test';

test.describe('Observability endpoints @smoke', () => {
  test('records recent API requests with request IDs', async ({ request }) => {
    const clearResponse = await request.post('/debug/requests/clear');
    expect(clearResponse.status()).toBe(200);

    const healthResponse = await request.get('/health');
    expect(healthResponse.status()).toBe(200);
    const requestId = healthResponse.headers()['x-ghinbox-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const recentResponse = await request.get('/debug/requests');
    expect(recentResponse.status()).toBe(200);
    const body = await recentResponse.json();

    expect(body.max_recent_requests).toBe(200);
    expect(body.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'GET',
          path: '/health',
          status_code: 200,
          request_id: requestId,
        }),
      ]),
    );
  });

  test('reports safe server state', async ({ request }) => {
    const response = await request.get('/debug/state');
    expect(response.status()).toBe(200);
    const body = await response.json();

    expect(body.status).toBe('ok');
    expect(body.test_mode).toBe(true);
    expect(body.live_fetching).toBe(false);
    expect(body).not.toHaveProperty('GHINBOX_SITE_PASSWORD');
  });

  test('records sanitized notification action audits', async ({ request }) => {
    const clearResponse = await request.post('/debug/notification-actions/clear');
    expect(clearResponse.status()).toBe(200);

    const actionResponse = await request.post('/notifications/html/action', {
      data: {
        action: 'archive',
        notification_ids: ['notif-e2e-1', 'notif-e2e-2'],
        authenticity_token: 'secret-e2e-token',
      },
    });
    expect(actionResponse.status()).toBe(503);
    const requestId = actionResponse.headers()['x-ghinbox-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const auditResponse = await request.get('/debug/notification-actions');
    expect(auditResponse.status()).toBe(200);
    const body = await auditResponse.json();

    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toEqual(
      expect.objectContaining({
        event: 'notification_action',
        request_id: requestId,
        action: 'archive',
        notification_count: 2,
        token_present: true,
        status: 'error',
        github_status_code: null,
      }),
    );
    expect(body.actions[0].notification_ids[0]).toEqual(
      expect.objectContaining({
        prefix: 'notif-e2e-1',
        suffix: 'notif-e2e-1',
      }),
    );
    expect(JSON.stringify(body.actions[0])).not.toContain('secret-e2e-token');
  });

  test('reports outbound GitHub API audit buffer', async ({ request }) => {
    const clearResponse = await request.post('/debug/github-api-calls/clear');
    expect(clearResponse.status()).toBe(200);

    const auditResponse = await request.get('/debug/github-api-calls');
    expect(auditResponse.status()).toBe(200);
    const body = await auditResponse.json();

    expect(body.max_recent_calls).toBe(200);
    expect(body.calls).toEqual([]);
  });
});
