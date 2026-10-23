const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractCommentIdFromAnchor,
  filterCommentsByAnchor,
  filterCommentsByLastReadAt,
  getCommentWindowComments,
} = require('../../ghinbox/webapp/notifications-comment-window.js');

function comment(id, login, body, extra = {}) {
  return {
    id,
    body,
    user: { login },
    created_at: `2025-01-0${Math.min(id, 9)}T00:00:00Z`,
    updated_at: `2025-01-0${Math.min(id, 9)}T00:00:00Z`,
    ...extra,
  };
}

function notification(type = 'Issue', extra = {}) {
  return {
    reason: 'subscribed',
    last_read_at: '2025-01-01T00:00:00Z',
    subject: {
      type,
      title: `${type} notification`,
      ...extra.subject,
    },
    ...extra,
  };
}

function ids(comments) {
  return comments.map((item) => item.id);
}

test('extracts supported GitHub comment anchors', () => {
  assert.deepEqual(extractCommentIdFromAnchor('issuecomment-123'), {
    id: 123,
    type: 'issue',
  });
  assert.deepEqual(extractCommentIdFromAnchor('discussion_r456'), {
    id: 456,
    type: 'discussion',
  });
  assert.deepEqual(extractCommentIdFromAnchor('pullrequestreview-789'), {
    id: 789,
    type: 'review',
  });
  assert.deepEqual(extractCommentIdFromAnchor('r321'), {
    id: 321,
    type: 'review_comment',
  });
  assert.equal(extractCommentIdFromAnchor('unknown-1'), null);
});

test('filters all-comments cache to the unread anchor window', () => {
  const comments = [
    comment(1, 'alice', 'Old comment'),
    comment(2, 'bob', 'First unread'),
    comment(3, 'carol', 'Later comment'),
  ];

  assert.deepEqual(ids(filterCommentsByAnchor(comments, 'issuecomment-2')), [2, 3]);
  assert.deepEqual(ids(filterCommentsByAnchor(comments, 'issuecomment-404')), [1, 2, 3]);
  assert.deepEqual(ids(filterCommentsByAnchor(comments, 'not-a-comment-anchor')), [1, 2, 3]);
});

test('review-comment anchors match the existing first comment id behavior', () => {
  const comments = [
    comment(7, 'alice', 'Issue comment with same id'),
    comment(7, 'bob', 'Review comment', { isReviewComment: true }),
    comment(8, 'carol', 'Later review comment', { isReviewComment: true }),
  ];

  const filtered = filterCommentsByAnchor(comments, 'r7');
  assert.deepEqual(ids(filtered), [7, 7, 8]);
  assert.equal(filtered[0].body, 'Issue comment with same id');
});

test('uses anchor slicing only when cached comments include all comments', () => {
  const notif = notification('Issue', { subject: { anchor: 'issuecomment-2' } });
  const comments = [
    comment(1, 'alice', 'Old comment'),
    comment(2, 'bob', 'Unread comment'),
  ];

  assert.deepEqual(
    ids(getCommentWindowComments(notif, { allComments: true, comments })),
    [2]
  );
  assert.deepEqual(
    ids(getCommentWindowComments(notif, { allComments: false, comments })),
    [1, 2]
  );
});

test('uses last-read slicing when all-comments cache has no anchor', () => {
  const notif = notification('PullRequest', {
    last_read_at: '2025-01-03T00:00:00Z',
  });
  const comments = [
    comment(1, 'alice', 'Already read comment', {
      updated_at: '2025-01-02T00:00:00Z',
    }),
    comment(2, 'bob', 'Unread comment', {
      updated_at: '2025-01-03T00:00:01Z',
    }),
  ];

  assert.deepEqual(ids(filterCommentsByLastReadAt(comments, notif.last_read_at)), [2]);
  assert.deepEqual(
    ids(getCommentWindowComments(notif, { allComments: true, comments })),
    [2]
  );
});

// getReplyContext: what the Replies view shows under a row.
const { getReplyContext, getCommentDisplayText } =
  require('../../ghinbox/webapp/notifications-comment-window.js');

function at(minute) {
  return `2025-02-01T00:${String(minute).padStart(2, '0')}:00Z`;
}

function timed(id, login, body, minute, extra = {}) {
  return comment(id, login, body, { created_at: at(minute), updated_at: at(minute), ...extra });
}

function describeContext(context) {
  return {
    kind: context.kind,
    items: context.items.map((item) => {
      if (item.kind === 'comment') {
        return `${item.directed ? '>>' : ''}${item.comment.user.login}#${item.comment.id}`;
      }
      if (item.kind === 'bots') {
        return `bots(${item.authors.join(',')})x${item.comments.length}`;
      }
      return `${item.event}@${item.created_at}`;
    }),
  };
}

const replyContextCases = [
  {
    name: 'starts at the mention and keeps everything after it',
    notification: notification('Issue', { reason: 'mention', last_read_at: at(2) }),
    comments: [
      timed(1, 'alice', 'background', 1),
      timed(2, 'bob', 'more background', 3),
      timed(3, 'carol', '@me can you route this?', 4),
      timed(4, 'dave', 'I can take it', 5),
      timed(5, 'carol', 'thanks dave!', 6),
    ],
    expected: { kind: 'reply', items: ['>>carol#3', 'dave#4', 'carol#5'] },
  },
  {
    name: 'shows my own comment elsewhere in the PR after a review-thread reply',
    notification: notification('PullRequest', { reason: 'comment', last_read_at: at(0) }),
    comments: [
      timed(1, 'me', 'why this?', 1, { isReviewComment: true }),
      timed(2, 'alice', 'because of X', 2, { isReviewComment: true, in_reply_to_id: 1 }),
      timed(3, 'me', 'pushed a fix for the other thing', 3),
      timed(4, 'alice', 'looks good', 4),
    ],
    expected: { kind: 'reply', items: ['>>alice#2', 'me#3', 'alice#4'] },
  },
  {
    name: 'collapses a run of bot comments after the reply into one item',
    notification: notification('PullRequest', { reason: 'mention', last_read_at: at(0) }),
    comments: [
      timed(1, 'alice', '@me PTAL', 1),
      timed(2, 'github-actions[bot]', 'lint failed', 2),
      timed(3, 'pytorch-bot[bot]', 'needs a label', 3),
      timed(4, 'github-actions[bot]', 'still failing', 4),
      timed(5, 'alice', 'fixed lint', 5),
    ],
    expected: {
      kind: 'reply',
      items: ['>>alice#1', 'bots(github-actions[bot],pytorch-bot[bot])x3', 'alice#5'],
    },
  },
  {
    name: 'keeps a finished delegated @claude task as a full comment',
    notification: notification('PullRequest', { reason: 'mention', last_read_at: at(0) }),
    comments: [
      timed(1, 'alice', '@me PTAL', 1),
      timed(2, 'claude[bot]', 'Claude finished @me\'s task', 2),
    ],
    expected: { kind: 'reply', items: ['>>alice#1', 'claude[bot]#2'] },
  },
  {
    name: 'without a directed comment shows the unread comments and a later close',
    notification: notification('Issue', {
      reason: 'subscribed',
      last_read_at: at(2),
      subject: { type: 'Issue', state: 'closed' },
    }),
    comments: [
      timed(1, 'alice', 'old discussion', 1),
      timed(2, 'maintainer', 'private API, will not fix', 4),
    ],
    stateEvents: [
      { id: 'issue-1-closed-at', event: 'closed', created_at: at(5) },
      { id: 99, event: 'closed', created_at: at(5), actor: { login: 'maintainer' } },
    ],
    expected: { kind: 'unread', items: ['maintainer#2', `closed@${at(5)}`] },
  },
  {
    name: 'a close before the shown activity is not repeated',
    notification: notification('Issue', { reason: 'mention', last_read_at: at(0) }),
    comments: [timed(1, 'alice', '@me reopen?', 3)],
    stateEvents: [{ id: 'x', event: 'closed', created_at: at(2) }],
    expected: { kind: 'reply', items: ['>>alice#1'] },
  },
  {
    name: 'nothing unread and nothing directed is empty',
    notification: notification('Issue', { reason: 'subscribed', last_read_at: at(9) }),
    comments: [timed(1, 'alice', 'old', 1)],
    expected: { kind: 'unread', items: [] },
  },
];

for (const testCase of replyContextCases) {
  test(`getReplyContext ${testCase.name}`, () => {
    const context = getReplyContext(testCase.notification, {
      comments: testCase.comments,
      currentUserLogin: 'me',
      stateEvents: testCase.stateEvents,
    });
    assert.deepEqual(describeContext(context), testCase.expected);
  });
}

test('getCommentDisplayText drops HTML comments bot templates hide markup in', () => {
  assert.equal(
    getCommentDisplayText('<!-- drci-comment-start -->\n## CI status\n<!-- end -->'),
    '## CI status'
  );
});
