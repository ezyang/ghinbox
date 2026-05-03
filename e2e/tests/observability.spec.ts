import { test, expect } from '@playwright/test';

test.describe('Observability endpoints', () => {
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
});
