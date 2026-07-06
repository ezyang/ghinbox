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

  assert.deepEqual(result.feed_ids, ['display-review-requested']);
  assert.equal(result.classifications[0].is_review_queue, false);
  assert.equal(result.classifications[1].is_review_queue, true);
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
