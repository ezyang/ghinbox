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
