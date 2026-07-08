const assert = require('node:assert/strict');
const test = require('node:test');
const Pagination = require('../../ghinbox/webapp/notifications-pagination.js');

test('pagination decision stops when there is no next page', () => {
  assert.deepEqual(
    Pagination.getNextNotificationPage({
      pagination: { has_next: false, after_cursor: 'ignored' },
      currentCursor: null,
      pagesFetched: 1,
    }),
    { shouldFetchNext: false, nextCursor: null, error: null }
  );
});

test('pagination decision continues with a fresh cursor under the cap', () => {
  assert.deepEqual(
    Pagination.getNextNotificationPage({
      pagination: { has_next: true, after_cursor: 'cursor-2' },
      currentCursor: 'cursor-1',
      pagesFetched: 2,
      maxPages: 50,
    }),
    { shouldFetchNext: true, nextCursor: 'cursor-2', error: null }
  );
});

test('pagination decision errors when the cursor does not advance', () => {
  const decision = Pagination.getNextNotificationPage({
    pagination: { has_next: true, after_cursor: 'cursor-1' },
    currentCursor: 'cursor-1',
    pagesFetched: 2,
  });

  assert.equal(decision.shouldFetchNext, false);
  assert.equal(decision.nextCursor, null);
  assert.match(decision.error, /did not advance/);
});

test('pagination decision errors when has_next omits the cursor', () => {
  const decision = Pagination.getNextNotificationPage({
    pagination: { has_next: true, after_cursor: null },
    currentCursor: null,
    pagesFetched: 1,
  });

  assert.equal(decision.shouldFetchNext, false);
  assert.equal(decision.nextCursor, null);
  assert.match(decision.error, /no after cursor/);
});

test('pagination decision errors when another page would exceed the cap', () => {
  const decision = Pagination.getNextNotificationPage({
    pagination: { has_next: true, after_cursor: 'cursor-51' },
    currentCursor: 'cursor-50',
    pagesFetched: 50,
    maxPages: 50,
  });

  assert.equal(decision.shouldFetchNext, false);
  assert.equal(decision.nextCursor, null);
  assert.match(decision.error, /exceeded 50 notification pages/);
});

test('pagination decision allows the capped page when it is terminal', () => {
  assert.deepEqual(
    Pagination.getNextNotificationPage({
      pagination: { has_next: false, after_cursor: null },
      currentCursor: 'cursor-49',
      pagesFetched: 50,
      maxPages: 50,
    }),
    { shouldFetchNext: false, nextCursor: null, error: null }
  );
});
