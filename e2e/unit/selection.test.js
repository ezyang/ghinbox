const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ensureActiveId,
  getActiveIdAfterRemoval,
  getMarkDoneTargets,
  getNextActiveId,
  getOpenAllTargets,
  getRangeIds,
  getUnsubscribeAllTargets,
} = require('../../ghinbox/webapp/notifications-selection.js');

const IDS = ['a', 'b', 'c', 'd'];

test('getRangeIds covers the inclusive range in either direction', () => {
  const cases = [
    { from: 'a', to: 'c', expected: ['a', 'b', 'c'] },
    { from: 'c', to: 'a', expected: ['a', 'b', 'c'] },
    { from: 'b', to: 'b', expected: ['b'] },
    { from: 'a', to: 'missing', expected: null },
    { from: 'missing', to: 'a', expected: null },
  ];
  for (const { from, to, expected } of cases) {
    assert.deepEqual(getRangeIds(from, to, IDS), expected, `${from}->${to}`);
  }
});

test('getNextActiveId moves and clamps the cursor', () => {
  const cases = [
    { active: 'b', delta: 1, expected: 'c' },
    { active: 'b', delta: -1, expected: 'a' },
    { active: 'a', delta: -1, expected: 'a' },
    { active: 'd', delta: 1, expected: 'd' },
    // A missing cursor enters from the top going down, bottom going up.
    { active: null, delta: 1, expected: 'a' },
    { active: null, delta: -1, expected: 'd' },
    { active: 'missing', delta: 1, expected: 'a' },
    { active: 'missing', delta: -1, expected: 'd' },
  ];
  for (const { active, delta, expected } of cases) {
    assert.equal(getNextActiveId(IDS, active, delta), expected, `${active} by ${delta}`);
  }
  assert.equal(getNextActiveId([], 'a', 1), null);
});

test('ensureActiveId repairs the cursor after the list changed', () => {
  assert.equal(ensureActiveId([], 'a'), null);
  assert.equal(ensureActiveId(IDS, null), null);
  assert.equal(ensureActiveId(IDS, 'c'), 'c');
  assert.equal(ensureActiveId(IDS, 'missing'), 'a');
});

test('getActiveIdAfterRemoval prefers next, then previous, else clears', () => {
  const cases = [
    { removed: 'b', active: 'b', expected: 'c' },
    { removed: 'd', active: 'd', expected: 'c' },
    { removed: 'b', active: 'a', expected: 'a' },
    { removed: 'missing', active: 'missing', expected: 'missing' },
  ];
  for (const { removed, active, expected } of cases) {
    assert.equal(getActiveIdAfterRemoval(IDS, removed, active), expected, `remove ${removed}`);
  }
  assert.equal(getActiveIdAfterRemoval(['only'], 'only', 'only'), null);
});

function notif(id, { archivable = true, url = `https://github.com/o/r/pull/1` } = {}) {
  return { id, archivable, subject: { url } };
}

const canArchive = (n) => n.archivable;

test('getMarkDoneTargets acts on the actionable selection when one exists', () => {
  const notifications = [notif('a'), notif('b', { archivable: false }), notif('c')];
  assert.deepEqual(
    getMarkDoneTargets({ view: 'issues', selectedIds: ['c', 'b', 'x'], notifications, canArchive }),
    { ids: ['c'], label: 'Mark selected as done', show: true }
  );
  // Selection with nothing actionable hides the button.
  assert.deepEqual(
    getMarkDoneTargets({ view: 'issues', selectedIds: ['b'], notifications, canArchive }),
    { ids: [], label: 'Mark selected as done', show: false }
  );
});

test('getMarkDoneTargets falls back to all actionable notifications', () => {
  const notifications = [notif('a'), notif('b', { archivable: false }), notif('c')];
  assert.deepEqual(
    getMarkDoneTargets({ view: 'issues', selectedIds: [], notifications, canArchive }),
    { ids: ['a', 'c'], label: 'Mark all as done', show: true }
  );
  assert.deepEqual(
    getMarkDoneTargets({
      view: 'issues',
      selectedIds: [],
      notifications: [notif('b', { archivable: false })],
      canArchive,
    }),
    { ids: [], label: 'Mark selected as done', show: false }
  );
});

test('getMarkDoneTargets never offers actions in the cleaned view', () => {
  assert.deepEqual(
    getMarkDoneTargets({ view: 'cleaned', selectedIds: ['a'], notifications: [notif('a')], canArchive }),
    { ids: [], label: 'Mark selected as done', show: false }
  );
});

test('getUnsubscribeAllTargets requires the approved filter and no selection', () => {
  const notifications = [notif('a'), notif('b')];
  assert.deepEqual(
    getUnsubscribeAllTargets({
      view: 'others-prs', hasSelection: false, stateFilter: 'approved', notifications,
    }),
    { ids: ['a', 'b'], show: true }
  );
  for (const input of [
    { view: 'cleaned', hasSelection: false, stateFilter: 'approved', notifications },
    { view: 'others-prs', hasSelection: true, stateFilter: 'approved', notifications },
    { view: 'others-prs', hasSelection: false, stateFilter: 'all', notifications },
    { view: 'others-prs', hasSelection: false, stateFilter: 'approved', notifications: [] },
  ]) {
    assert.deepEqual(getUnsubscribeAllTargets(input), { ids: [], show: false });
  }
});

test('getOpenAllTargets keeps only notifications with a subject url', () => {
  const withUrl = notif('a');
  const withoutUrl = { id: 'b', subject: { url: '' } };
  assert.deepEqual(getOpenAllTargets([withUrl, withoutUrl]), {
    notifications: [withUrl],
    show: true,
  });
  assert.deepEqual(getOpenAllTargets([withoutUrl]), { notifications: [], show: false });
});
