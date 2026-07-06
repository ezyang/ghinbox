const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildIncrementalRestLookupKeys,
  buildNotificationMatchKeySet,
  buildPreviousMatchMap,
  findIncrementalOverlapIndex,
  getUpdatedAtSignature,
  mergeIncrementalNotifications,
} = require('../../ghinbox/webapp/notifications-sync-merge.js');

function notif(id, number, updatedAt, extra = {}) {
  return {
    id,
    updated_at: updatedAt,
    repository: { full_name: 'owner/repo' },
    subject: {
      type: 'Issue',
      title: `Issue #${number}`,
      url: `https://github.com/owner/repo/issues/${number}`,
      number,
      state: 'open',
      state_reason: null,
      ...extra.subject,
    },
    ...extra,
  };
}

test('getUpdatedAtSignature normalizes equivalent timestamps', () => {
  assert.equal(
    getUpdatedAtSignature('2025-01-02T03:04:05Z'),
    getUpdatedAtSignature('2025-01-02T03:04:05.000Z')
  );
  assert.notEqual(
    getUpdatedAtSignature('2025-01-02T03:04:05Z'),
    getUpdatedAtSignature('2025-01-02T03:04:06Z')
  );
});

test('getUpdatedAtSignature falls back to string for unparseable input', () => {
  assert.equal(getUpdatedAtSignature('not-a-date'), 'not-a-date');
  assert.equal(getUpdatedAtSignature(null), '');
});

test('buildPreviousMatchMap keeps first index for duplicate match keys', () => {
  const previous = [
    notif('a', 1, '2025-01-03T00:00:00Z'),
    notif('b', 2, '2025-01-02T00:00:00Z'),
    notif('a2', 1, '2025-01-01T00:00:00Z'),
  ];
  const map = buildPreviousMatchMap(previous);
  assert.equal(map.size, 2);
  assert.equal(map.get('owner/repo:Issue:1').index, 0);
  assert.equal(
    map.get('owner/repo:Issue:1').updatedAt,
    getUpdatedAtSignature('2025-01-03T00:00:00Z')
  );
});

test('findIncrementalOverlapIndex returns previous index of first unchanged notification', () => {
  const previous = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    notif('b', 2, '2025-01-04T00:00:00Z'),
    notif('c', 3, '2025-01-03T00:00:00Z'),
  ];
  const map = buildPreviousMatchMap(previous);
  const page = [
    notif('d', 4, '2025-01-06T00:00:00Z'), // new
    notif('a', 1, '2025-01-05T12:00:00Z'), // updated -> not overlap
    notif('b', 2, '2025-01-04T00:00:00Z'), // unchanged -> overlap at previous index 1
  ];
  assert.equal(findIncrementalOverlapIndex(page, map), 1);
});

test('findIncrementalOverlapIndex returns null when everything changed', () => {
  const previous = [notif('a', 1, '2025-01-05T00:00:00Z')];
  const map = buildPreviousMatchMap(previous);
  const page = [
    notif('a', 1, '2025-01-05T12:00:00Z'),
    notif('b', 2, '2025-01-04T00:00:00Z'),
  ];
  assert.equal(findIncrementalOverlapIndex(page, map), null);
});

test('findIncrementalOverlapIndex treats equivalent timestamp formats as unchanged', () => {
  const previous = [notif('a', 1, '2025-01-05T00:00:00Z')];
  const map = buildPreviousMatchMap(previous);
  const page = [notif('a', 1, '2025-01-05T00:00:00.000Z')];
  assert.equal(findIncrementalOverlapIndex(page, map), 0);
});

test('mergeIncrementalNotifications appends previous tail from startIndex', () => {
  const previous = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    notif('b', 2, '2025-01-04T00:00:00Z'),
    notif('c', 3, '2025-01-03T00:00:00Z'),
  ];
  const fresh = [
    notif('d', 4, '2025-01-06T00:00:00Z'),
    notif('a', 1, '2025-01-05T00:00:00Z'),
  ];
  // Overlap at previous index 0 -> tail starts at 1.
  const merged = mergeIncrementalNotifications(fresh, previous, 1);
  assert.deepEqual(
    merged.map((n) => n.id),
    ['d', 'a', 'b', 'c']
  );
});

test('mergeIncrementalNotifications dedups previous tail against fresh page by match key', () => {
  const previous = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    notif('b-old', 2, '2025-01-04T00:00:00Z'),
    notif('c', 3, '2025-01-03T00:00:00Z'),
  ];
  const fresh = [
    notif('b-new', 2, '2025-01-06T00:00:00Z'), // same issue as b-old, updated
    notif('a', 1, '2025-01-05T00:00:00Z'),
  ];
  const merged = mergeIncrementalNotifications(fresh, previous, 1);
  assert.deepEqual(
    merged.map((n) => n.id),
    ['b-new', 'a', 'c']
  );
});

test('mergeIncrementalNotifications with startIndex 0 never duplicates the overlap item', () => {
  const previous = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    notif('b', 2, '2025-01-04T00:00:00Z'),
  ];
  const fresh = [notif('a', 1, '2025-01-05T00:00:00Z')];
  const merged = mergeIncrementalNotifications(fresh, previous, 0);
  assert.deepEqual(
    merged.map((n) => n.id),
    ['a', 'b']
  );
});

test('buildIncrementalRestLookupKeys selects only new or changed notifications', () => {
  const previous = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    notif('b', 2, '2025-01-04T00:00:00Z'),
  ];
  const map = buildPreviousMatchMap(previous);
  const fetched = [
    notif('a', 1, '2025-01-05T00:00:00Z'), // unchanged -> excluded
    notif('b', 2, '2025-01-04T12:00:00Z'), // changed -> included
    notif('c', 3, '2025-01-06T00:00:00Z'), // new -> included
  ];
  const keys = buildIncrementalRestLookupKeys(fetched, map);
  assert.deepEqual(
    [...keys].sort(),
    ['owner/repo:Issue:2', 'owner/repo:Issue:3']
  );
});

test('buildNotificationMatchKeySet resolves repo from notification or explicit repo', () => {
  const items = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    notif('b', 2, '2025-01-04T00:00:00Z'),
  ];
  const implicit = buildNotificationMatchKeySet(items);
  assert.deepEqual(
    [...implicit].sort(),
    ['owner/repo:Issue:1', 'owner/repo:Issue:2']
  );

  const bare = [
    {
      id: 'x',
      updated_at: '2025-01-05T00:00:00Z',
      subject: { type: 'Issue', number: 7, url: '' },
    },
  ];
  const explicit = buildNotificationMatchKeySet(bare, {
    owner: 'other',
    repo: 'place',
  });
  assert.deepEqual([...explicit], ['other/place:Issue:7']);
});

test('notifications without numbers fall back to id-based keys and still merge safely', () => {
  const previous = [
    notif('a', 1, '2025-01-05T00:00:00Z'),
    {
      id: 'weird',
      updated_at: '2025-01-04T00:00:00Z',
      subject: { type: 'CheckSuite', title: 'CI run', url: '', number: null },
    },
  ];
  const map = buildPreviousMatchMap(previous);
  assert.ok(map.has('id:weird'));

  const fresh = [notif('a', 1, '2025-01-05T00:00:00Z')];
  const merged = mergeIncrementalNotifications(fresh, previous, 1);
  assert.deepEqual(
    merged.map((n) => n.id),
    ['a', 'weird']
  );
});
