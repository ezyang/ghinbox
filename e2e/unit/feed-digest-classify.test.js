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

test('profile digest routes repositories outside PyTorch orgs out of Feed', () => {
  const result = classifyNotifications({
    currentUserLogin: 'ezyang',
    routeOutsidePytorchToReplies: true,
    notifications: [
      notification('pytorch-item', 'subscribed', {
        repository: { owner: 'pytorch', name: 'pytorch', full_name: 'pytorch/pytorch' },
        subject: { title: 'PyTorch issue', type: 'Issue', number: 1, state: 'open' },
      }),
      notification('outside-item', 'subscribed', {
        repository: { owner: 'acme', name: 'widgets', full_name: 'acme/widgets' },
        subject: { title: 'Outside issue', type: 'Issue', number: 2, state: 'open' },
      }),
    ],
    commentThreads: {},
  });

  assert.deepEqual(result.feed_ids, ['pytorch-item']);
  assert.equal(result.classifications[1].is_directed_at_current_user, true);
  assert.equal(result.classifications[1].is_trash, false);
});

test('feed digest keeps other people PRs the user is participating in', () => {
  const result = classifyNotifications({
    currentUserLogin: 'ezyang',
    notifications: [
      notification('participating-pr', 'comment'),
      notification('untouched-pr', 'comment'),
    ],
    commentThreads: {
      'participating-pr': {
        comments: [
          {
            id: 1,
            created_at: '2026-07-01T12:01:00Z',
            body: 'This needs a guard for MSVC.',
            user: { login: 'ezyang' },
          },
          {
            id: 2,
            created_at: '2026-07-01T12:02:00Z',
            body: 'Added the guard, PTAL.',
            user: { login: 'contributor' },
          },
        ],
        stateEvents: [],
      },
      'untouched-pr': {
        comments: [
          {
            id: 3,
            created_at: '2026-07-01T12:01:00Z',
            body: 'Rebased onto main.',
            user: { login: 'contributor' },
          },
        ],
        stateEvents: [],
      },
    },
  });

  // Matches the webapp's isNotificationForCurrentUser: a reply after the
  // user's own comment keeps the PR in the Feed rather than in trash.
  assert.deepEqual(result.feed_ids, ['participating-pr']);
  assert.deepEqual(result.trash_ids, ['untouched-pr']);
});

test('feed digest reports real threads for PRs waiting in Reviews as duplicates', () => {
  const result = classifyNotifications({
    currentUserLogin: 'ezyang',
    notifications: [
      notification('review-request:test/repo#200', 'review_requested', {
        responsibility_source: 'review-requested',
        repository: { full_name: 'test/repo' },
      }),
      notification('reply-on-reviewed-pr', 'comment', {
        repository: { full_name: 'test/repo' },
      }),
      notification('reply-elsewhere', 'comment', {
        repository: { full_name: 'test/other' },
      }),
    ],
    commentThreads: {
      'reply-on-reviewed-pr': {
        authorLogin: 'alice',
        comments: [
          {
            id: 1,
            created_at: '2026-07-01T12:01:00Z',
            body: '@ezyang addressed your comments',
            user: { login: 'alice' },
          },
        ],
      },
    },
  });

  assert.deepEqual(result.review_duplicate_ids, ['reply-on-reviewed-pr']);
  assert.equal(result.classifications[1].is_directed_at_current_user, true);
  assert.equal(result.classifications[1].is_feed, false);
  assert.equal(result.classifications[2].is_review_duplicate, false);
});

test('feed digest lists Replies candidates and applies FYI demotions', () => {
  const issue = (id) => notification(id, 'mention', {
    subject: { title: id, type: 'Issue', number: 300, state: 'open' },
  });
  const mention = (id, login, body) => ({
    id,
    created_at: '2026-07-01T11:00:00Z',
    body,
    user: { login },
  });
  const payload = {
    currentUserLogin: 'ezyang',
    notifications: [issue('asks'), issue('thanks'), issue('claude-done'), issue('ambient')],
    commentThreads: {
      asks: { comments: [mention(1, 'alice', '@ezyang can you look?')] },
      thanks: { comments: [mention(2, 'bob', 'thanks @ezyang, that worked')] },
      'claude-done': {
        comments: [mention(3, 'claude[bot]', "Claude finished @ezyang's task")],
      },
    },
  };

  const before = classifyNotifications(payload);
  assert.deepEqual(before.reply_candidates, [
    { id: 'asks', unread_comment_ids: [1] },
    { id: 'thanks', unread_comment_ids: [2] },
  ]);
  assert.deepEqual(before.feed_ids, ['ambient']);

  const after = classifyNotifications({
    ...payload,
    replyDemotions: { thanks: '2026-07-01T12:00:00Z', asks: '2026-06-01T00:00:00Z' },
  });
  assert.deepEqual(after.feed_ids, ['thanks', 'ambient']);
  assert.deepEqual(after.reply_candidates, before.reply_candidates);
  assert.equal(after.classifications[1].is_reply_demoted, true);
});
