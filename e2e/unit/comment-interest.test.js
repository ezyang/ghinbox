const assert = require('node:assert/strict');
const test = require('node:test');
const {
  filterCommentsAfterOwnComment,
  filterRelevantCommentsForNotification,
  getDirectReviewThreadReplies,
  getUninterestingReason,
  hasActionableCurrentUserMention,
  isNotificationDirectedAtCurrentUser,
  isNotificationForCurrentUser,
  isUninterestingComment,
} = require('../../ghinbox/webapp/notifications-comment-interest.js');

function comment(id, login, body, extra = {}) {
  return {
    id,
    body,
    user: { login },
    created_at: `2025-01-01T00:${String(id).padStart(2, '0')}:00Z`,
    updated_at: `2025-01-01T00:${String(id).padStart(2, '0')}:00Z`,
    ...extra,
  };
}

function notification(type = 'PullRequest', reason = 'comment', extra = {}) {
  return {
    reason,
    last_read_at: '2025-01-01T00:05:00Z',
    subject: {
      type,
      state: 'open',
      title: `${type} notification`,
    },
    ...extra,
  };
}

function ids(comments) {
  return comments.map((item) => item.id);
}

test('actionable mentions ignore issue body cc-only lines', () => {
  assert.equal(
    hasActionableCurrentUserMention(
      comment(1, 'alice', 'Summary\n\ncc @testuser', { isIssue: true }),
      'testuser'
    ),
    false
  );
  assert.equal(
    hasActionableCurrentUserMention(
      comment(2, 'alice', 'cc: @testuser\n\n@testuser please look', { isIssue: true }),
      'testuser'
    ),
    true
  );
  assert.equal(
    hasActionableCurrentUserMention(comment(3, 'alice', 'cc @testuser'), 'testuser'),
    true
  );
});

test('direct review thread replies include only replies after the user in each thread', () => {
  const comments = [
    comment(1, 'testuser', 'Can this be simpler?', { isReviewComment: true }),
    comment(2, 'alice', 'Done.', { isReviewComment: true, in_reply_to_id: 1 }),
    comment(3, 'bob', 'Unrelated thread.', { isReviewComment: true }),
    comment(4, 'testuser', 'Follow-up.', { isReviewComment: true, in_reply_to_id: 3 }),
    comment(5, 'carol', 'Answered.', { isReviewComment: true, in_reply_to_id: 3 }),
  ];

  assert.deepEqual(ids(getDirectReviewThreadReplies(comments, 'testuser')), [2, 5]);
  assert.deepEqual(
    ids(filterRelevantCommentsForNotification(notification(), comments, 'testuser')),
    [2, 5]
  );
});

test('directed PR replies must be unread and interesting', () => {
  const comments = [
    comment(1, 'testuser', 'Could you check this?', { isReviewComment: true }),
    comment(2, 'alice', 'Already handled.', { isReviewComment: true, in_reply_to_id: 1 }),
    comment(6, 'testuser', 'I rechecked this.', { isReviewComment: true }),
    comment(7, 'github-actions[bot]', 'CI passed.', { isReviewComment: true, in_reply_to_id: 1 }),
  ];

  assert.equal(
    isNotificationDirectedAtCurrentUser(notification(), {
      comments,
      currentUserLogin: 'testuser',
      lastReadAt: '2025-01-01T00:05:00Z',
    }),
    false
  );
});

test('main-thread comments after the user are directed at the current user', () => {
  const comments = [
    comment(1, 'testuser', 'I am looking.'),
    comment(6, 'alice', 'Could you also check this?'),
  ];

  assert.equal(
    isNotificationDirectedAtCurrentUser(notification('Issue'), {
      comments,
      currentUserLogin: 'testuser',
      lastReadAt: '2025-01-01T00:05:00Z',
    }),
    true
  );
});

test('top-level PR comments after the user are not directed replies', () => {
  const comments = [
    comment(1, 'testuser', 'Some tests would be nice.'),
    comment(6, 'alice', 'I checked the runtime estimation path.'),
  ];

  assert.equal(
    isNotificationDirectedAtCurrentUser(notification('PullRequest'), {
      comments,
      currentUserLogin: 'testuser',
      lastReadAt: '2025-01-01T00:05:00Z',
    }),
    false
  );
});

test('muted participation replies still allow explicit mentions', () => {
  const genericReply = [
    comment(1, 'testuser', 'I am looking.'),
    comment(6, 'alice', 'Could you also check this?'),
  ];
  const explicitMention = [
    comment(1, 'testuser', 'I am looking.'),
    comment(6, 'alice', '@testuser could you also check this?'),
  ];

  assert.equal(
    isNotificationDirectedAtCurrentUser(notification('Issue'), {
      comments: genericReply,
      currentUserLogin: 'testuser',
      lastReadAt: '2025-01-01T00:05:00Z',
      suppressParticipationReplies: true,
    }),
    false
  );
  assert.equal(
    isNotificationDirectedAtCurrentUser(notification('Issue'), {
      comments: explicitMention,
      currentUserLogin: 'testuser',
      lastReadAt: '2025-01-01T00:05:00Z',
      suppressParticipationReplies: true,
    }),
    true
  );
});

test('notification-for-current-user follows author, reason, mention, and participation signals', () => {
  assert.equal(
    isNotificationForCurrentUser(notification(), {
      authorLogin: 'testuser',
      comments: [],
      currentUserLogin: 'testuser',
    }),
    true
  );
  assert.equal(
    isNotificationForCurrentUser(notification('PullRequest', 'mention'), {
      authorLogin: 'alice',
      comments: [],
      currentUserLogin: 'testuser',
    }),
    true
  );
  assert.equal(
    isNotificationForCurrentUser(notification(), {
      authorLogin: 'alice',
      comments: [
        comment(1, 'testuser', 'I can review.'),
        comment(2, 'alice', 'Thanks for reviewing.'),
      ],
      currentUserLogin: 'testuser',
    }),
    true
  );
  assert.equal(
    isNotificationForCurrentUser(notification(), {
      authorLogin: 'alice',
      comments: [comment(2, 'alice', 'General update.')],
      currentUserLogin: 'testuser',
    }),
    false
  );
});

test('own comment filtering keeps only comments after the latest user comment', () => {
  const comments = [
    comment(1, 'alice', 'Before.'),
    comment(2, 'testuser', 'Looking now.'),
    comment(3, 'bob', 'One reply.'),
    comment(4, 'testuser', 'Thanks.'),
    comment(5, 'carol', 'Final reply.'),
  ];

  assert.deepEqual(ids(filterCommentsAfterOwnComment(comments, 'testuser')), [5]);
});

[
  {
    name: 'empty issue thread',
    type: 'Issue',
    comments: [],
    expected: 'no-comments',
  },
  {
    name: 'bot-authored comments',
    type: 'Issue',
    comments: [comment(1, 'dependabot[bot]', 'Bump dependency')],
    expected: 'bot-only',
  },
  {
    name: 'human bot commands',
    type: 'Issue',
    comments: [comment(1, 'alice', '@pytorchbot label feature')],
    expected: 'bot-commands',
  },
  {
    name: 'PR with only current-user and bot comments',
    type: 'PullRequest',
    comments: [
      comment(1, 'testuser', 'I pushed an update.'),
      comment(2, 'github-actions[bot]', 'CI passed.'),
    ],
    expected: 'own-or-bot-only',
  },
  {
    name: 'PR with direct replies stays interesting',
    type: 'PullRequest',
    comments: [
      comment(1, 'testuser', 'Question.', { isReviewComment: true }),
      comment(2, 'alice', 'Answer.', { isReviewComment: true, in_reply_to_id: 1 }),
    ],
    expected: null,
  },
].forEach(({ name, type, comments, expected }) => {
  test(`uninteresting reason: ${name}`, () => {
    assert.equal(
      getUninterestingReason(notification(type), {
        comments,
        currentUserLogin: 'testuser',
        isApproved: false,
      }),
      expected
    );
  });
});

test('revert-related bot-looking comments are interesting', () => {
  assert.equal(isUninterestingComment(comment(1, 'alice', '@pytorchbot revert this')), false);
});
