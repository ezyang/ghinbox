const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LOG_MAX,
  appendLogEntry,
  buildLogEntry,
  extractGraphqlSummary,
  formatRateLimit,
  getLogStatusMessage,
  getPreservedLogEntries,
  getRequestKind,
  shouldLogRequest,
} = require('../../ghinbox/webapp/notifications-rate-limit.js');

test('shouldLogRequest gates on proxied GitHub and app HTML endpoints', () => {
  const cases = [
    { url: '/github/rest/rate_limit', expected: true },
    { url: '/github/graphql', expected: true },
    { url: '/notifications/html/repo/a/b', expected: true },
    { url: '/api/snapshots/a/b', expected: false },
    { url: 'https://example.com/github/x', expected: false },
    { url: '', expected: false },
    { url: null, expected: false },
  ];
  for (const { url, expected } of cases) {
    assert.equal(shouldLogRequest(url), expected, `url=${url}`);
  }
});

test('getRequestKind classifies GraphQL, App, and REST requests', () => {
  const cases = [
    { url: '/github/graphql', expected: 'GraphQL' },
    { url: '/notifications/html/query?query=x', expected: 'App' },
    { url: '/github/rest/notifications', expected: 'REST' },
  ];
  for (const { url, expected } of cases) {
    assert.equal(getRequestKind(url), expected, `url=${url}`);
  }
});

test('extractGraphqlSummary summarizes operation, root field, and variables', () => {
  const cases = [
    { body: null, expected: null },
    { body: 'not json', expected: null },
    { body: JSON.stringify({ query: '' }), expected: null },
    {
      body: JSON.stringify({
        query: 'query Foo($owner: String!) { repository(owner: $owner) { id } }',
        variables: { owner: 'a', name: 'b' },
      }),
      expected: 'query Foo root=repository vars=owner,name',
    },
    {
      body: JSON.stringify({ query: 'query { rateLimit { remaining } }' }),
      expected: 'query root=rateLimit',
    },
    {
      body: JSON.stringify({ query: 'mutation { markDone { ok } }' }),
      expected: 'mutation root=markDone',
    },
    {
      // No query/mutation keyword: only the first brace's field is reported.
      body: JSON.stringify({ query: 'fragment F on Repo { id }' }),
      expected: 'root=id',
    },
  ];
  for (const { body, expected } of cases) {
    assert.equal(extractGraphqlSummary(body), expected, `body=${body}`);
  }
});

test('buildLogEntry uppercases the method and derives the detail', () => {
  const base = { id: 7, startedAt: 0, action: 'Quick Sync', durationMs: 12 };
  const rest = buildLogEntry({ ...base, method: 'get', url: '/github/rest/user', status: 200 });
  assert.equal(rest.method, 'GET');
  assert.equal(rest.kind, 'REST');
  assert.equal(rest.detail, null);
  assert.equal(rest.timestamp, 0);

  const graphql = buildLogEntry({
    ...base,
    method: 'POST',
    url: '/github/graphql',
    status: 200,
    requestBody: JSON.stringify({ query: 'query { rateLimit { remaining } }' }),
  });
  assert.equal(graphql.kind, 'GraphQL');
  assert.equal(graphql.detail, 'query root=rateLimit');

  const failed = buildLogEntry({
    ...base,
    method: null,
    url: '/github/rest/user',
    status: 'error',
    errorMessage: 'fetch failed',
  });
  assert.equal(failed.method, 'GET');
  assert.equal(failed.detail, 'fetch failed');
});

test('appendLogEntry trims the log to the cap from the front', () => {
  const log = [];
  for (let i = 0; i < LOG_MAX + 5; i++) {
    appendLogEntry(log, { id: i });
  }
  assert.equal(log.length, LOG_MAX);
  assert.equal(log[0].id, 5);
  assert.equal(log[log.length - 1].id, LOG_MAX + 4);
});

test('getPreservedLogEntries applies since, latest, or clears everything', () => {
  const log = [{ id: 1, timestamp: 10 }, { id: 2, timestamp: 20 }, { id: 3, timestamp: 30 }];
  assert.deepEqual(getPreservedLogEntries(log, { preserveSince: 20 }).map((e) => e.id), [2, 3]);
  assert.deepEqual(getPreservedLogEntries(log, { preserveLatest: true }).map((e) => e.id), [3]);
  // preserveSince wins over preserveLatest, matching the pre-extraction order.
  assert.deepEqual(
    getPreservedLogEntries(log, { preserveSince: 30, preserveLatest: true }).map((e) => e.id),
    [3]
  );
  assert.deepEqual(getPreservedLogEntries(log), []);
  assert.deepEqual(getPreservedLogEntries([], { preserveLatest: true }), []);
});

test('getLogStatusMessage pluralizes and handles a missing reset time', () => {
  assert.equal(getLogStatusMessage(0, null), 'No rate limit requests logged yet.');
  assert.match(getLogStatusMessage(1, null), /^Logged 1 request until core resets @ unknown\.$/);
  assert.match(getLogStatusMessage(2, null), /^Logged 2 requests until core resets @ unknown\.$/);
  assert.match(getLogStatusMessage(2, 1700000000), /^Logged 2 requests until core resets @ .+\.$/);
});

test('formatRateLimit reports core and graphql states independently', () => {
  assert.equal(
    formatRateLimit(null, null, null, null),
    'Rate limit: core unknown | graphql unknown'
  );
  assert.equal(
    formatRateLimit(null, 'boom', null, 'gql down'),
    'Rate limit: core error: boom | graphql error: gql down'
  );
  const withCore = formatRateLimit(
    { resources: { core: { remaining: 42, limit: 5000, reset: 1700000000 } } },
    null,
    { remaining: 9, limit: 10, resetAt: '2023-11-14T00:00:00Z' },
    null
  );
  assert.match(withCore, /^Rate limit: core 42\/5000 reset @ .+ \| graphql 9\/10 reset @ .+$/);
  const noReset = formatRateLimit(
    { resources: { core: { remaining: 1, limit: 2, reset: 0 } } },
    null,
    { remaining: 3, limit: 4, resetAt: null },
    null
  );
  assert.equal(noReset, 'Rate limit: core 1/2 reset @ unknown | graphql 3/4 reset @ unknown');
});
