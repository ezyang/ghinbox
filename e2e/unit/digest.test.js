const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatDigestStatus,
  isClientBusy,
  selectVisibleDigest,
  shouldApplyBackgroundSnapshot,
  shouldShowDigestPanel,
} = require('../../ghinbox/webapp/notifications-digest.js');

const digest = {
  status: 'idle',
  composed_at: '2026-09-23T11:50:00Z',
  pending_count: 0,
  counts: { feed_count: 40, direct_count: 3, broadcast_count: 30 },
  look_at: [
    { id: 'a', title: 'A', why: 'ping' },
    { id: 'done', title: 'Done', why: 'gone' },
  ],
  vibe: [
    { title: 'Dynamo', text: 'Busy.', examples: [{ id: 'b' }, { id: 'done' }] },
    { title: 'Empty', text: '', examples: [] },
  ],
};

test('selectVisibleDigest drops items no longer in the live list', () => {
  const visible = selectVisibleDigest(digest, new Set(['a', 'b']));
  assert.deepEqual(visible.lookAt.map((item) => item.id), ['a']);
  assert.deepEqual(visible.vibe, [
    { title: 'Dynamo', text: 'Busy.', examples: [{ id: 'b' }] },
  ]);
  assert.deepEqual(selectVisibleDigest(null, []), { lookAt: [], vibe: [] });
});

test('shouldShowDigestPanel decision table', () => {
  const visible = selectVisibleDigest(digest, ['a', 'b']);
  const empty = { lookAt: [], vibe: [] };
  const cases = [
    ['Feed with a composed digest', { view: 'issues', digest, visible }, true],
    ['other views hide it', { view: 'others-prs', digest, visible }, false],
    ['no digest loaded', { view: 'issues', digest: null, visible: empty }, false],
    ['everything marked done', { view: 'issues', digest, visible: empty }, false],
    [
      'never composed (digest disabled)',
      { view: 'issues', digest: { status: 'idle' }, visible: empty },
      false,
    ],
    [
      'first digest still running',
      { view: 'issues', digest: { status: 'running' }, visible: empty },
      true,
    ],
    [
      'errors stay visible',
      { view: 'issues', digest: { status: 'error', error: 'x' }, visible: empty },
      true,
    ],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(shouldShowDigestPanel(input), expected, name);
  }
});

test('formatDigestStatus summarizes freshness, split, and queue', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const visible = selectVisibleDigest(digest, ['a', 'b']);
  assert.equal(
    formatDigestStatus(digest, visible, now),
    'updated 10m ago · 1 of 40 worth a look (3 direct, 30 broadcast cc)'
  );
  assert.equal(
    formatDigestStatus({ ...digest, status: 'running', pending_count: 5 }, visible, now),
    'updated 10m ago · 1 of 40 worth a look (3 direct, 30 broadcast cc) · ' +
      'digesting 5 new items…'
  );
  assert.equal(
    formatDigestStatus({ status: 'error', error: 'boom' }, visible, now),
    'last update failed: boom'
  );
});

test('shouldApplyBackgroundSnapshot decision table', () => {
  const snapshot = { notifications: [], synced_at: '2026-09-23T12:10:00Z' };
  const sync = { status: 'success', started_at: '2026-09-23T12:05:00Z' };
  const base = { snapshot, sync, localSyncedAt: '2026-09-23T11:55:00Z' };
  const cases = [
    ['newer snapshot, no local mutations', {}, true],
    ['same snapshot already applied', { localSyncedAt: snapshot.synced_at }, false],
    ['no snapshot', { snapshot: null }, false],
    ['client busy', { busy: true }, false],
    ['sync still running', { sync: { status: 'running' } }, false],
    [
      'sync started after the last mark-done',
      { lastLocalMutationAt: Date.parse('2026-09-23T12:00:00Z') },
      true,
    ],
    [
      'sync started before the last mark-done would resurrect it',
      { lastLocalMutationAt: Date.parse('2026-09-23T12:07:00Z') },
      false,
    ],
  ];
  for (const [name, overrides, expected] of cases) {
    assert.equal(
      shouldApplyBackgroundSnapshot({ ...base, ...overrides }),
      expected,
      name
    );
  }
});

test('isClientBusy flags in-flight user work', () => {
  assert.equal(isClientBusy({}), false);
  assert.equal(isClientBusy({ doneQueueActive: true }), true);
  assert.equal(isClientBusy({ selectionCount: 2 }), true);
  assert.equal(isClientBusy({ loading: true }), true);
});
