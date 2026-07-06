const assert = require('node:assert/strict');
const test = require('node:test');
const ViewState = require('../../ghinbox/webapp/notifications-view-state.js');

test('normalizeViewFilters accepts legacy strings and normalizes invalid values', () => {
  const filters = ViewState.normalizeViewFilters({
    issues: 'closed',
    'others-prs': {
      state: 'draft',
      author: 'unknown-author',
      interest: 'has-new',
    },
    'pr-notifications': {
      state: 'missing',
      audience: 'for-you',
    },
    cleaned: {
      state: 'closed',
    },
  });

  assert.deepEqual(filters.issues, {
    state: 'closed',
    bookmark: 'new',
    type: 'all',
    interest: 'all',
  });
  assert.deepEqual(filters['others-prs'], {
    state: 'done',
    author: 'all',
    interest: 'has-new',
  });
  assert.deepEqual(filters['pr-notifications'], {
    state: 'all',
    audience: 'for-you',
    interest: 'all',
  });
  assert.deepEqual(filters.cleaned, { state: 'all' });
});

test('normalizeViewOrders keeps valid per-view orders and defaults invalid values', () => {
  assert.deepEqual(
    ViewState.normalizeViewOrders({
      issues: 'size',
      'my-prs': 'invalid',
      'others-prs': 'recent',
      unknown: 'size',
    }),
    {
      issues: 'size',
      'my-prs': 'recent',
      'pr-notifications': 'recent',
      'others-prs': 'recent',
      cleaned: 'recent',
    }
  );
});

test('normalizeStateFilter maps legacy review states and falls back by view', () => {
  assert.equal(ViewState.normalizeStateFilter('others-prs', 'draft'), 'done');
  assert.equal(ViewState.normalizeStateFilter('others-prs', 'closed'), 'done');
  assert.equal(ViewState.normalizeStateFilter('issues', 'open'), 'open');
  assert.equal(ViewState.normalizeStateFilter('issues', 'needs-review'), 'all');
});

test('count-key helpers resolve configured view and filter count keys', () => {
  assert.equal(ViewState.getViewCountKey('issues'), 'issues');
  assert.equal(ViewState.getViewCountKey('others-prs'), 'othersPrs');
  assert.equal(ViewState.getViewCountKey('trash'), 'trash');
  assert.equal(ViewState.getFilterCountKey('others-prs', 'state', 'needs-review'), 'needsReview');
  assert.equal(ViewState.getFilterCountKey('issues', 'interest', 'has-new'), 'hasNew');
  assert.equal(ViewState.getFilterCountKey('issues', 'state', 'closed'), 'closed');
});

test('getMobileFilterOptions follows the configured primary group', () => {
  assert.deepEqual(ViewState.getMobileFilterOptions('issues'), [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
  ]);
  assert.deepEqual(ViewState.getMobileFilterOptions('others-prs'), [
    { value: 'all', label: 'All' },
    { value: 'needs-review', label: 'Needs review' },
    { value: 'approved', label: 'Approved' },
    { value: 'done', label: 'Done' },
  ]);
});

test('cloneDefaultViewFilters returns an isolated deep clone', () => {
  const first = ViewState.cloneDefaultViewFilters();
  const second = ViewState.cloneDefaultViewFilters();

  first.issues.state = 'closed';
  first['others-prs'].author = 'ai';

  assert.equal(second.issues.state, 'all');
  assert.equal(second['others-prs'].author, 'all');
  assert.equal(ViewState.DEFAULT_VIEW_FILTERS.issues.state, 'all');
  assert.equal(ViewState.DEFAULT_VIEW_FILTERS['others-prs'].author, 'all');
});
