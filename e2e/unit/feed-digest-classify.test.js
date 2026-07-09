const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyNotifications } = require('../../scripts/feed_digest_classify.js');

function notification(id, reason, extra = {}) {
  return {
    id,
    reason,
    updated_at: '2026-07-01T12:00:00Z',
    subject: {
      title: id,
      type: 'PullRequest',
      number: 200,
      state: 'open',
    },
    ...extra,
  };
}

test('feed digest helper delegates queue classification to webapp modules', () => {
  const result = classifyNotifications({
    currentUserLogin: 'ezyang',
    notifications: [
      notification('display-review-requested', 'review requested'),
      notification('api-review-requested', 'review_requested'),
    ],
    commentThreads: {},
  });

  // `display-review-requested` matches the feed view but is a non-directed
  // other's PR, so the webapp treats it as trash and auto-cleans it on sync;
  // the digest mirrors that and excludes trash from feed_ids.
  assert.deepEqual(result.feed_ids, []);
  assert.equal(result.classifications[0].is_feed, true);
  assert.equal(result.classifications[0].is_trash, true);
  assert.equal(result.classifications[0].is_review_queue, false);
  assert.equal(result.classifications[1].is_review_queue, true);
});

test('feed digest excludes merge-machinery chatter on the user own PRs', () => {
  const result = classifyNotifications({
    currentUserLogin: 'ezyang',
    notifications: [
      notification('my-pr-bot-only', 'author'),
      notification('my-pr-human-reply', 'author'),
    ],
    commentThreads: {
      'my-pr-bot-only': {
        authorLogin: 'ezyang',
        comments: [
          {
            id: 1,
            created_at: '2026-07-01T12:01:00Z',
            body: '### Merge started\nYour change will be merged once all checks pass.',
            user: { login: 'pytorchmergebot' },
          },
        ],
        stateEvents: [],
      },
      'my-pr-human-reply': {
        authorLogin: 'ezyang',
        comments: [
          {
            id: 2,
            created_at: '2026-07-01T12:02:00Z',
            body: 'Can you rebase this and address my comment?',
            user: { login: 'reviewer1' },
          },
        ],
        stateEvents: [],
      },
    },
  });

  // Own PR with only bot/merge-machinery comments is low-priority trash; own PR
  // with a genuine human reply must survive.
  assert.ok(result.trash_ids.includes('my-pr-bot-only'));
  assert.ok(!result.feed_ids.includes('my-pr-bot-only'));
  assert.ok(!result.trash_ids.includes('my-pr-human-reply'));
});

test('feed digest helper passes cached lastReadAt to directed classification', () => {
  const result = classifyNotifications({
    currentUserLogin: 'ezyang',
    notifications: [notification('read-directed-mention', 'mention')],
    commentThreads: {
      'read-directed-mention': {
        lastReadAt: '2026-07-01T12:03:00Z',
        comments: [
          {
            id: 1,
            created_at: '2026-07-01T12:01:00Z',
            body: '@claude summarize this',
            user: { login: 'ezyang' },
          },
          {
            id: 2,
            created_at: '2026-07-01T12:02:00Z',
            body: "Claude finished @ezyang's task.",
            user: { login: 'claude[bot]' },
          },
        ],
        stateEvents: [],
      },
    },
  });

  assert.deepEqual(result.feed_ids, ['read-directed-mention']);
  assert.equal(result.classifications[0].is_directed_at_current_user, false);
});
