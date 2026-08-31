const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatReason,
  formatRelativeTime,
  getDiffstatHue,
  getIconStateClass,
  getNotificationIconName,
  getStateBadgeInfo,
} = require('../../ghinbox/webapp/notifications-format.js');

const NOW = Date.parse('2026-06-15T12:00:00Z');

test('formatRelativeTime buckets by seconds through years', () => {
  const cases = [
    { at: '2026-06-15T11:59:30Z', expected: 'just now' },
    { at: '2026-06-15T11:15:00Z', expected: '45m ago' },
    { at: '2026-06-15T09:00:00Z', expected: '3h ago' },
    { at: '2026-06-13T12:00:00Z', expected: '2d ago' },
    { at: '2026-06-01T12:00:00Z', expected: '2w ago' },
    { at: '2026-03-15T12:00:00Z', expected: '3mo ago' },
    { at: '2024-06-01T12:00:00Z', expected: '2y ago' },
  ];
  for (const { at, expected } of cases) {
    assert.equal(formatRelativeTime(at, NOW), expected, at);
  }
});

test('formatReason maps known reasons and passes through unknown ones', () => {
  assert.equal(formatReason('review_requested'), 'Review requested');
  assert.equal(formatReason('ci_activity'), 'CI activity');
  assert.equal(formatReason('some_new_reason'), 'some_new_reason');
});

test('getStateBadgeInfo derives label and class from subject state', () => {
  const cases = [
    { subject: { type: 'Issue', state: null }, expected: null },
    { subject: { type: 'Issue' }, expected: null },
    {
      subject: { type: 'Issue', state: 'open' },
      expected: { label: 'Open', cssClass: 'open', state: 'open' },
    },
    {
      subject: { type: 'Issue', state: 'closed', state_reason: 'completed' },
      expected: { label: 'Closed', cssClass: 'closed completed', state: 'closed' },
    },
    {
      subject: { type: 'Issue', state: 'closed', state_reason: 'not_planned' },
      expected: { label: 'Closed', cssClass: 'closed', state: 'closed' },
    },
    {
      subject: { type: 'PullRequest', state: 'merged' },
      expected: { label: 'Merged', cssClass: 'merged', state: 'merged' },
    },
  ];
  for (const { subject, expected } of cases) {
    assert.deepEqual(getStateBadgeInfo(subject), expected, JSON.stringify(subject));
  }
});

test('getNotificationIconName selects by type, state, and state_reason', () => {
  const cases = [
    { subject: { type: 'Issue', state: 'open' }, expected: 'issue' },
    { subject: { type: 'Issue', state: 'closed' }, expected: 'issueClosed' },
    {
      subject: { type: 'Issue', state: 'closed', state_reason: 'not_planned' },
      expected: 'issueNotPlanned',
    },
    { subject: { type: 'PullRequest', state: 'open' }, expected: 'pr' },
    { subject: { type: 'PullRequest', state: 'merged' }, expected: 'prMerged' },
    { subject: { type: 'PullRequest', state: 'closed' }, expected: 'prClosed' },
    { subject: { type: 'PullRequest', state: 'draft' }, expected: 'prDraft' },
    { subject: { type: 'Discussion' }, expected: 'discussion' },
    { subject: { type: 'Commit' }, expected: 'commit' },
    { subject: { type: 'Release' }, expected: 'release' },
    { subject: { type: 'SomethingElse' }, expected: 'issue' },
  ];
  for (const { subject, expected } of cases) {
    assert.equal(getNotificationIconName(subject), expected, JSON.stringify(subject));
  }
});

test('getIconStateClass falls back to open', () => {
  assert.equal(getIconStateClass({ state: 'merged' }), 'merged');
  assert.equal(getIconStateClass({ state: 'closed' }), 'closed');
  assert.equal(getIconStateClass({ state: 'draft' }), 'draft');
  assert.equal(getIconStateClass({ state: 'open' }), 'open');
  assert.equal(getIconStateClass({}), 'open');
});

test('getDiffstatHue scales from green to red across the range', () => {
  assert.equal(getDiffstatHue(10, null), null);
  assert.equal(getDiffstatHue(10, { min: null, max: null }), null);
  assert.equal(getDiffstatHue(10, { min: 10, max: 10 }), 60);
  assert.equal(getDiffstatHue(0, { min: 0, max: 100 }), 120);
  assert.equal(getDiffstatHue(100, { min: 0, max: 100 }), 0);
  assert.equal(getDiffstatHue(50, { min: 0, max: 100 }), 60);
});
