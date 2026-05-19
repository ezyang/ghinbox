const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cloneDefaultViewFilters,
  getFilteredNotifications,
  getSubfilterCounts,
  getViewCounts,
  normalizeViewFilters,
} = require('../../ghinbox/webapp/notifications-filtering.js');

function notification(id, type, state, reason = 'subscribed', extra = {}) {
  return {
    id,
    reason,
    updated_at: `2025-01-01T00:00:0${id.length % 10}Z`,
    subject: {
      type,
      state,
      title: id,
      url: `https://github.com/test/repo/${type === 'Issue' ? 'issues' : 'pull'}/${id}`,
    },
    ui: { saved: false, done: false },
    ...extra,
  };
}

const fixtures = [
  notification('issue-open', 'Issue', 'open'),
  notification('issue-closed', 'Issue', 'closed'),
  notification('my-pr', 'PullRequest', 'open', 'author'),
  notification('review-pr', 'PullRequest', 'open', 'review_requested'),
  notification('draft-pr', 'PullRequest', 'draft', 'review_requested'),
  notification('merged-pr', 'PullRequest', 'merged', 'review_requested'),
  notification('approved-pr', 'PullRequest', 'open'),
  notification('changes-requested-pr', 'PullRequest', 'open'),
  notification('reply-pr', 'PullRequest', 'open'),
  notification('external-pr', 'PullRequest', 'open', 'review_requested'),
];

const baseDeps = {
  isNotificationDirectedAtCurrentUser: (notification) => notification.id === 'reply-pr',
  isNotificationApproved: (notification) => notification.id === 'approved-pr',
  isNotificationChangesRequested: (notification) => notification.id === 'changes-requested-pr',
  isNotificationReviewResponsibility: (notification) =>
    notification.reason === 'review_requested',
  isNotificationFromCommitter: (notification) => notification.id === 'review-pr',
  hasNotificationAuthorPermission: (notification) =>
    notification.id === 'review-pr' || notification.id === 'external-pr',
  getUninterestingReason: (notification) =>
    notification.id === 'issue-closed' || notification.id === 'merged-pr'
      ? 'no-comments'
      : null,
  getNotificationSize: (notification) =>
    ({
      'review-pr': 30,
      'approved-pr': 10,
      'external-pr': null,
    })[notification.id] ?? null,
};

function input(overrides = {}) {
  return {
    notifications: fixtures,
    trashNotifications: [],
    view: 'issues',
    viewFilters: cloneDefaultViewFilters(),
    orderBy: 'recent',
    currentUserLogin: 'testuser',
    deps: baseDeps,
    ...overrides,
  };
}

function ids(notifications) {
  return notifications.map((notification) => notification.id);
}

test('normalizes persisted legacy and partial view filters', () => {
  assert.deepEqual(normalizeViewFilters({ issues: 'closed' }).issues, {
    state: 'closed',
    interest: 'all',
  });
  assert.deepEqual(normalizeViewFilters({ 'others-prs': { author: 'external' } })['others-prs'], {
    state: 'all',
    author: 'external',
    interest: 'all',
  });
  assert.equal(normalizeViewFilters({ 'others-prs': 'closed' })['others-prs'].state, 'done');
  assert.equal(normalizeViewFilters({ 'others-prs': { state: 'draft' } })['others-prs'].state, 'done');
});

test('classifies notifications into view counts', () => {
  assert.deepEqual(getViewCounts(input()), {
    issues: 5,
    myPrs: 1,
    prNotifications: 1,
    othersPrs: 4,
    trash: 0,
  });
});

[
  {
    name: 'feed hides review responsibility and replies',
    view: 'issues',
    filters: {},
    expected: ['issue-open', 'issue-closed', 'my-pr', 'approved-pr', 'changes-requested-pr'],
  },
  {
    name: 'feed open filter includes open issues and own open PRs',
    view: 'issues',
    filters: { issues: { state: 'open' } },
    expected: ['issue-open', 'my-pr', 'approved-pr', 'changes-requested-pr'],
  },
  {
    name: 'feed closed filter includes closed issues',
    view: 'issues',
    filters: { issues: { state: 'closed' } },
    expected: ['issue-closed'],
  },
  {
    name: 'reviews needs-review follows active review responsibility, not aggregate review decision',
    view: 'others-prs',
    filters: { 'others-prs': { state: 'needs-review' } },
    expected: ['review-pr', 'external-pr'],
  },
  {
    name: 'reviews done filter matches draft and closed review requests',
    view: 'others-prs',
    filters: { 'others-prs': { state: 'done' } },
    expected: ['draft-pr', 'merged-pr'],
  },
  {
    name: 'reviews author filter separates committers',
    view: 'others-prs',
    filters: { 'others-prs': { author: 'committer' } },
    expected: ['review-pr'],
  },
  {
    name: 'reviews author filter separates external authors with permissions loaded',
    view: 'others-prs',
    filters: { 'others-prs': { author: 'external' } },
    expected: ['external-pr'],
  },
  {
    name: 'interest no-new keeps uninteresting feed items',
    view: 'issues',
    filters: { issues: { interest: 'no-new' } },
    expected: ['issue-closed'],
  },
  {
    name: 'replies view keeps directed notifications',
    view: 'pr-notifications',
    filters: {},
    expected: ['reply-pr'],
  },
].forEach(({ name, view, filters, expected }) => {
  test(name, () => {
    assert.deepEqual(
      ids(getFilteredNotifications(input({
        view,
        viewFilters: normalizeViewFilters(filters),
      }))),
      expected
    );
  });
});

test('sorts review notifications by size with stable nulls last', () => {
  assert.deepEqual(
    ids(getFilteredNotifications(input({
      view: 'others-prs',
      viewFilters: normalizeViewFilters({ 'others-prs': { state: 'all' } }),
      orderBy: 'size',
    }))),
    ['review-pr', 'draft-pr', 'merged-pr', 'external-pr']
  );
});

test('computes subfilter counts after cross-filters', () => {
  const counts = getSubfilterCounts(input({
    view: 'others-prs',
    viewFilters: normalizeViewFilters({ 'others-prs': { author: 'committer' } }),
  }));

  assert.deepEqual(counts.state, {
    all: 1,
    open: 1,
    closed: 0,
    draft: 0,
    done: 0,
    needsReview: 1,
    approved: 0,
  });
  assert.deepEqual(counts.author, {
    all: 4,
    committer: 1,
    external: 1,
  });
});
