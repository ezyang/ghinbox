const assert = require('node:assert/strict');
const test = require('node:test');
const {
  UNDO_EXPIRY_MS,
  getCompletionStatus,
  getUndoAction,
  groupByToken,
  insertByUpdatedAt,
  isExpired,
  pushEntry,
  removeEntry,
  updateEntry,
} = require('../../ghinbox/webapp/notifications-undo.js');

function notif(id, updatedAt, token) {
  const n = { id, updated_at: updatedAt };
  if (token !== undefined) {
    n.ui = { action_tokens: { unarchive: token } };
  }
  return n;
}

test('pushEntry normalizes a single notification and stamps the entry', () => {
  const stack = [];
  const entry = pushEntry(stack, 'done', notif('a', '2025-01-01T00:00:00Z'), 1000);
  assert.equal(stack.length, 1);
  assert.equal(entry.action, 'done');
  assert.equal(entry.timestamp, 1000);
  assert.deepEqual(entry.notifications.map((n) => n.id), ['a']);
});

test('pushEntry returns null for empty input and leaves the stack alone', () => {
  const stack = [];
  pushEntry(stack, 'done', [notif('a', '2025-01-01T00:00:00Z')], 1000);
  assert.equal(pushEntry(stack, 'done', [], 2000), null);
  assert.equal(stack.length, 1);
  assert.equal(stack[0].timestamp, 1000);
});

test('pushEntry keeps only the most recent entry', () => {
  const stack = [];
  pushEntry(stack, 'done', [notif('a', '2025-01-01T00:00:00Z')], 1000);
  const second = pushEntry(stack, 'unsubscribe', [notif('b', '2025-01-02T00:00:00Z')], 2000);
  assert.equal(stack.length, 1);
  assert.equal(stack[0], second);
});

test('removeEntry removes only the matching entry and tolerates null', () => {
  const stack = [];
  const entry = pushEntry(stack, 'done', [notif('a', '2025-01-01T00:00:00Z')], 1000);
  removeEntry(stack, null);
  assert.equal(stack.length, 1);
  removeEntry(stack, { other: true });
  assert.equal(stack.length, 1);
  removeEntry(stack, entry);
  assert.equal(stack.length, 0);
});

test('updateEntry replaces notifications, removing the entry when emptied', () => {
  const stack = [];
  const entry = pushEntry(
    stack,
    'done',
    [notif('a', '2025-01-01T00:00:00Z'), notif('b', '2025-01-02T00:00:00Z')],
    1000
  );

  updateEntry(stack, entry, [notif('b', '2025-01-02T00:00:00Z')]);
  assert.deepEqual(entry.notifications.map((n) => n.id), ['b']);
  assert.equal(stack.length, 1);

  updateEntry(stack, entry, []);
  assert.equal(stack.length, 0);
});

test('isExpired uses the 30 second window', () => {
  const entry = { timestamp: 10000 };
  assert.equal(isExpired(entry, 10000 + UNDO_EXPIRY_MS), false);
  assert.equal(isExpired(entry, 10000 + UNDO_EXPIRY_MS + 1), true);
});

test('getUndoAction maps done to unarchive and everything else to subscribe', () => {
  assert.equal(getUndoAction('done'), 'unarchive');
  assert.equal(getUndoAction('unsubscribe'), 'subscribe');
  assert.equal(getUndoAction('remove_reviewer'), 'subscribe');
});

test('groupByToken groups by per-notification token with fallback', () => {
  const notifications = [
    notif('a', '2025-01-01T00:00:00Z', 'tok1'),
    notif('b', '2025-01-02T00:00:00Z', 'tok1'),
    notif('c', '2025-01-03T00:00:00Z', 'tok2'),
    notif('d', '2025-01-04T00:00:00Z'), // no token -> fallback
  ];
  const { groups, missingToken } = groupByToken(notifications, 'unarchive', 'fallback');
  assert.equal(missingToken, false);
  assert.deepEqual(groups.get('tok1').map((n) => n.id), ['a', 'b']);
  assert.deepEqual(groups.get('tok2').map((n) => n.id), ['c']);
  assert.deepEqual(groups.get('fallback').map((n) => n.id), ['d']);
});

test('groupByToken flags missing tokens when there is no fallback', () => {
  const notifications = [
    notif('a', '2025-01-01T00:00:00Z', 'tok1'),
    notif('b', '2025-01-02T00:00:00Z'),
  ];
  const { groups, missingToken } = groupByToken(notifications, 'unarchive', null);
  assert.equal(missingToken, true);
  assert.deepEqual(groups.get('tok1').map((n) => n.id), ['a']);
  assert.equal(groups.size, 1);
});

const COMPLETION_CASES = [
  {
    name: 'single restore',
    input: { restoredCount: 1, failedCount: 0, errorDetail: null },
    expected: {
      message: 'Undo successful: restored 1 notification',
      type: 'success',
      autoDismiss: true,
    },
  },
  {
    name: 'multiple restores pluralize',
    input: { restoredCount: 3, failedCount: 0, errorDetail: null },
    expected: {
      message: 'Undo successful: restored 3 notifications',
      type: 'success',
      autoDismiss: true,
    },
  },
  {
    name: 'partial failure with detail',
    input: { restoredCount: 1, failedCount: 2, errorDetail: 'HTTP 500' },
    expected: {
      message: 'Undo failed: restored 1, failed 2 (HTTP 500)',
      type: 'error',
      autoDismiss: false,
    },
  },
  {
    name: 'failure without detail',
    input: { restoredCount: 0, failedCount: 1, errorDetail: null },
    expected: {
      message: 'Undo failed: restored 0, failed 1',
      type: 'error',
      autoDismiss: false,
    },
  },
];

for (const c of COMPLETION_CASES) {
  test(`getCompletionStatus: ${c.name}`, () => {
    assert.deepEqual(getCompletionStatus(c.input), c.expected);
  });
}

test('insertByUpdatedAt inserts into descending updated_at order', () => {
  const list = [
    notif('newest', '2025-01-05T00:00:00Z'),
    notif('middle', '2025-01-03T00:00:00Z'),
    notif('oldest', '2025-01-01T00:00:00Z'),
  ];
  insertByUpdatedAt(list, [
    notif('restored-old', '2025-01-02T00:00:00Z'),
    notif('restored-new', '2025-01-04T00:00:00Z'),
  ]);
  assert.deepEqual(
    list.map((n) => n.id),
    ['newest', 'restored-new', 'middle', 'restored-old', 'oldest']
  );
});

test('insertByUpdatedAt appends items older than everything', () => {
  const list = [notif('a', '2025-01-05T00:00:00Z')];
  insertByUpdatedAt(list, [notif('ancient', '2024-01-01T00:00:00Z')]);
  assert.deepEqual(list.map((n) => n.id), ['a', 'ancient']);
});

test('insertByUpdatedAt prepends items newer than everything and keeps batch order', () => {
  const list = [notif('a', '2025-01-05T00:00:00Z')];
  insertByUpdatedAt(list, [
    notif('newer', '2025-01-06T00:00:00Z'),
    notif('newest', '2025-01-07T00:00:00Z'),
  ]);
  assert.deepEqual(list.map((n) => n.id), ['newest', 'newer', 'a']);
});
