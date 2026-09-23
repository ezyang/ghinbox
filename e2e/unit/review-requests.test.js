const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REVIEW_AUTO_RELOAD_MIN_INTERVAL_MS,
  shouldAutoReloadReviews,
} = require('../../ghinbox/webapp/notifications-review-requests.js');

const NOW = Date.parse('2026-09-23T12:00:00Z');
const base = {
  view: 'others-prs',
  hasProfileEntries: true,
  reloading: false,
  loading: false,
  lastReloadedAt: null,
  nowMs: NOW,
};

test('shouldAutoReloadReviews decision table', () => {
  const cases = [
    ['first entry into Reviews', {}, true],
    ['other views never reload', { view: 'issues' }, false],
    ['Replies view never reloads', { view: 'pr-notifications' }, false],
    ['no profile entries configured', { hasProfileEntries: false }, false],
    ['reload already in flight', { reloading: true }, false],
    ['full sync in progress', { loading: true }, false],
    ['reloaded moments ago', { lastReloadedAt: NOW - 30 * 1000 }, false],
    [
      'just inside the guard window',
      { lastReloadedAt: NOW - REVIEW_AUTO_RELOAD_MIN_INTERVAL_MS + 1 },
      false,
    ],
    [
      'guard window elapsed',
      { lastReloadedAt: NOW - REVIEW_AUTO_RELOAD_MIN_INTERVAL_MS },
      true,
    ],
    ['clock moved backwards', { lastReloadedAt: NOW + 60 * 1000 }, true],
    ['non-numeric timestamp treated as never', { lastReloadedAt: 'yesterday' }, true],
    ['custom interval', { lastReloadedAt: NOW - 5000, minIntervalMs: 1000 }, true],
  ];
  for (const [name, overrides, expected] of cases) {
    assert.equal(shouldAutoReloadReviews({ ...base, ...overrides }), expected, name);
  }
});
