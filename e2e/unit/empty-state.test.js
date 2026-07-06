const assert = require('node:assert/strict');
const test = require('node:test');
const { cloneDefaultViewFilters } = require('../../ghinbox/webapp/notifications-view-state.js');
const { getEmptyStateMessage } = require('../../ghinbox/webapp/notifications-empty-state.js');

const FULL_VIEW_COUNTS = {
  issues: 3,
  myPrs: 2,
  prNotifications: 4,
  othersPrs: 5,
  trash: 1,
};

function input(overrides = {}) {
  return {
    view: 'issues',
    viewFilters: cloneDefaultViewFilters(),
    viewCounts: { ...FULL_VIEW_COUNTS },
    notificationCount: 10,
    trashNotificationCount: 1,
    ...overrides,
  };
}

function withFilter(view, filters) {
  return {
    ...cloneDefaultViewFilters(),
    [view]: {
      ...cloneDefaultViewFilters()[view],
      ...filters,
    },
  };
}

[
  {
    name: 'cleaned view with no cleaned notifications',
    input: input({ view: 'cleaned', trashNotificationCount: 0 }),
    expected: {
      title: 'No cleaned notifications',
      message: 'Cleaned low-priority notifications will appear here until the next sync.',
    },
  },
  {
    name: 'empty repository before any notifications are loaded',
    input: input({ notificationCount: 0, trashNotificationCount: 0 }),
    expected: {
      title: 'No notifications',
      message: 'Enter a repository and click Quick Sync to load notifications.',
    },
  },
  {
    name: 'feed view has no notifications',
    input: input({ viewCounts: { ...FULL_VIEW_COUNTS, issues: 0 } }),
    expected: {
      title: 'No feed notifications',
      message: 'No awareness notifications in this repository.',
    },
  },
  {
    name: 'my PRs view uses the shared view count key',
    input: input({ view: 'my-prs', viewCounts: { ...FULL_VIEW_COUNTS, myPrs: 0 } }),
    expected: {
      title: 'No notifications for your PRs',
      message: 'No notifications for pull requests you authored.',
    },
  },
  {
    name: 'reviews view has no notifications',
    input: input({ view: 'others-prs', viewCounts: { ...FULL_VIEW_COUNTS, othersPrs: 0 } }),
    expected: {
      title: 'No reviews',
      message: 'No pull requests need your review right now.',
    },
  },
  {
    name: 'replies view has no notifications',
    input: input({
      view: 'pr-notifications',
      viewCounts: { ...FULL_VIEW_COUNTS, prNotifications: 0 },
    }),
    expected: {
      title: 'No replies',
      message: 'No notifications look like someone is talking to you.',
    },
  },
  {
    name: 'cleaned view count is empty',
    input: input({ view: 'cleaned', viewCounts: { ...FULL_VIEW_COUNTS, trash: 0 } }),
    expected: {
      title: 'No cleaned notifications',
      message: 'Cleaned low-priority notifications will appear here until the next sync.',
    },
  },
  {
    name: 'open state filter has no matches',
    input: input({ viewFilters: withFilter('issues', { state: 'open' }) }),
    expected: {
      title: 'No open feed notifications',
      message: 'All feed notifications in this view are closed or merged.',
    },
  },
  {
    name: 'closed state filter has no matches',
    input: input({ viewFilters: withFilter('issues', { state: 'closed' }) }),
    expected: {
      title: 'No closed feed notifications',
      message: 'All feed notifications in this view are still open.',
    },
  },
  {
    name: 'draft state filter has no matches',
    input: input({ view: 'others-prs', viewFilters: withFilter('others-prs', { state: 'draft' }) }),
    expected: {
      title: 'No draft review notifications',
      message: 'All review notifications in this view are ready for review.',
    },
  },
  {
    name: 'needs review state filter has no matches',
    input: input({
      view: 'others-prs',
      viewFilters: withFilter('others-prs', { state: 'needs-review' }),
    }),
    expected: {
      title: 'No PRs need review',
      message: 'No PRs need your review right now.',
    },
  },
  {
    name: 'approved state filter has no matches',
    input: input({
      view: 'others-prs',
      viewFilters: withFilter('others-prs', { state: 'approved' }),
    }),
    expected: {
      title: 'No approved PRs',
      message: 'No approved PR notifications are pending.',
    },
  },
  {
    name: 'committer author filter has no matches',
    input: input({
      view: 'others-prs',
      viewFilters: withFilter('others-prs', { author: 'committer' }),
    }),
    expected: {
      title: 'No committer PRs',
      message: 'No pull requests from repository committers match this view.',
    },
  },
  {
    name: 'AI author filter has no matches',
    input: input({
      view: 'others-prs',
      viewFilters: withFilter('others-prs', { author: 'ai' }),
    }),
    expected: {
      title: 'No AI PRs',
      message: 'No pull requests from AI authors match this view.',
    },
  },
  {
    name: 'external author filter has no matches',
    input: input({
      view: 'others-prs',
      viewFilters: withFilter('others-prs', { author: 'external' }),
    }),
    expected: {
      title: 'No external PRs',
      message: 'No pull requests from external contributors match this view.',
    },
  },
  {
    name: 'for-you audience filter has no matches',
    input: input({
      view: 'pr-notifications',
      viewFilters: withFilter('pr-notifications', { audience: 'for-you' }),
    }),
    expected: {
      title: 'No replies',
      message: 'No notifications look like someone is talking to you.',
    },
  },
  {
    name: 'for-others audience filter has no matches',
    input: input({
      view: 'pr-notifications',
      viewFilters: withFilter('pr-notifications', { audience: 'for-others' }),
    }),
    expected: {
      title: 'No PR notifications for others',
      message: 'All matching pull request notifications are for you.',
    },
  },
  {
    name: 'generic filter fallback',
    input: input(),
    expected: {
      title: 'No notifications',
      message: 'No notifications match the current filter.',
    },
  },
].forEach(({ name, input: testInput, expected }) => {
  test(name, () => {
    assert.deepEqual(getEmptyStateMessage(testInput), expected);
  });
});
