const assert = require('node:assert/strict');
const test = require('node:test');
const Http = require('../../ghinbox/webapp/notifications-http.js');

function response({ status = 500, statusText = 'Server Error', body = '' } = {}) {
  return {
    status,
    statusText,
    text: async () => body,
  };
}

test('exports the UMD API and preserves fetch globals', () => {
  assert.equal(globalThis.GhinboxHttp, Http);
  assert.equal(globalThis.fetchJson, Http.fetchJson);
  assert.equal(globalThis.fetchGraphql, Http.fetchGraphql);
});

test('readErrorDetail parses string detail for fetch and action callers', async () => {
  const detail = await Http.readErrorDetail(response({
    status: 502,
    statusText: 'Bad Gateway',
    body: JSON.stringify({ detail: 'Failed to fetch from GitHub: timeout' }),
  }));

  assert.deepEqual(detail, {
    detail: 'Failed to fetch from GitHub: timeout',
    message: 'Failed to fetch from GitHub: timeout',
    responseText: '{"detail":"Failed to fetch from GitHub: timeout"}',
    sessionExpired: false,
  });
});

test('readErrorDetail parses object detail messages and session expiry', async () => {
  const body = JSON.stringify({
    detail: {
      error: 'session_expired',
      message: 'Stored browser session is expired. Log in again.',
    },
  });
  const detail = await Http.readErrorDetail(response({
    status: 401,
    statusText: 'Unauthorized',
    body,
  }));

  assert.equal(detail.detail, body);
  assert.equal(detail.message, 'Stored browser session is expired. Log in again.');
  assert.equal(detail.responseText, body);
  assert.equal(detail.sessionExpired, true);
});

test('readErrorDetail falls back to parsed message, JSON, empty body, and raw text', async () => {
  assert.deepEqual(
    await Http.readErrorDetail(response({
      status: 400,
      statusText: 'Bad Request',
      body: JSON.stringify({ message: 'Bad filter' }),
    })),
    {
      detail: '{"message":"Bad filter"}',
      message: 'Bad filter',
      responseText: '{"message":"Bad filter"}',
      sessionExpired: false,
    }
  );
  assert.deepEqual(
    await Http.readErrorDetail(response({
      status: 418,
      statusText: "I'm a Teapot",
      body: JSON.stringify({ error: 'short_and_stout' }),
    })),
    {
      detail: '{"error":"short_and_stout"}',
      message: '{"error":"short_and_stout"}',
      responseText: '{"error":"short_and_stout"}',
      sessionExpired: false,
    }
  );
  assert.deepEqual(
    await Http.readErrorDetail(response({
      status: 404,
      statusText: 'Not Found',
    })),
    {
      detail: '',
      message: 'HTTP 404 Not Found',
      responseText: '',
      sessionExpired: false,
    }
  );
  assert.deepEqual(
    await Http.readErrorDetail(response({
      status: 500,
      statusText: 'Server Error',
      body: '<html>oops</html>',
    })),
    {
      detail: '<html>oops</html>',
      message: '<html>oops</html>',
      responseText: '<html>oops</html>',
      sessionExpired: false,
    }
  );
});

test('session-expiry predicate recognizes known browser-session messages', () => {
  assert.equal(Http.SESSION_REFRESH_URL, 'login.html?session_refresh=1');
  assert.equal(
    Http.isExpiredBrowserSessionMessage(
      'GitHub redirected notifications request to login. Stored browser session is expired.'
    ),
    true
  );
  assert.equal(Http.isExpiredBrowserSessionMessage('Browser session is expired'), true);
  assert.equal(Http.isExpiredBrowserSessionMessage('Rate limit exceeded'), false);
});
