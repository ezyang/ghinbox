const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractCommentIdFromAnchor,
  filterCommentsByAnchor,
  filterCommentsByLastReadAt,
  getCommentWindowComments,
  getRenderableCommentState,
  isCommentTooOld,
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

test('renderable state filters own comments before applying visibility filters', () => {
  const state = getRenderableCommentState(
    notification('Issue'),
    {
      allComments: false,
      comments: [
        comment(1, 'reviewer', 'Before'),
        comment(2, 'testuser', 'Looking now.'),
        comment(3, 'reviewer', 'Thanks for checking in.'),
      ],
    },
    {
      currentUserLogin: 'testuser',
      hideUninteresting: false,
      ageFilter: 'all',
    }
  );

  assert.equal(state.kind, 'comments');
  assert.deepEqual(ids(state.comments), [3]);
});

test('renderable empty state explains comments hidden after latest own comment', () => {
  const state = getRenderableCommentState(
    notification('PullRequest', { last_read_at: null }),
    {
      allComments: true,
      comments: [
        comment(1, 'reviewer', 'Before'),
        comment(2, 'testuser', 'Looking now.'),
      ],
    },
    {
      currentUserLogin: 'testuser',
      hideUninteresting: false,
      ageFilter: 'all',
    }
  );

  assert.deepEqual(state, {
    kind: 'empty',
    label: 'No comments found.',
    detail: 'Cached 2 comments; none remain after your latest comment.',
  });
});

test('renderable state reports hide-uninteresting and age empty labels', () => {
  const botOnlyState = getRenderableCommentState(
    notification('Issue'),
    {
      allComments: false,
      lastReadAt: '2025-01-01T00:00:00Z',
      comments: [comment(1, 'dependabot[bot]', 'Bump dependency')],
    },
    {
      currentUserLogin: 'testuser',
      hideUninteresting: true,
      ageFilter: 'all',
    }
  );
  assert.deepEqual(botOnlyState, {
    kind: 'empty',
    label: 'No interesting unread comments found.',
  });

  const ageState = getRenderableCommentState(
    notification('Issue'),
    {
      allComments: false,
      comments: [comment(1, 'alice', 'Old but interesting')],
    },
    {
      currentUserLogin: 'testuser',
      hideUninteresting: false,
      ageFilter: '1day',
      now: '2025-01-04T00:00:00Z',
    }
  );
  assert.deepEqual(ageState, {
    kind: 'empty',
    label: 'All comments filtered by age.',
  });
});

test('age filtering is deterministic with an injected clock', () => {
  const now = '2025-03-01T00:00:00Z';
  const cases = [
    {
      filter: 'all',
      comments: [
        comment(1, 'alice', 'Current', { created_at: '2025-03-01T00:00:00Z' }),
        comment(2, 'bob', 'Two months old', { created_at: '2025-01-01T00:00:00Z' }),
      ],
      expectedTooOld: [false, false],
    },
    {
      filter: '1day',
      comments: [
        comment(1, 'alice', 'One hour old', { created_at: '2025-02-28T23:00:00Z' }),
        comment(2, 'bob', 'Two days old', { created_at: '2025-02-27T00:00:00Z' }),
      ],
      expectedTooOld: [false, true],
    },
    {
      filter: '3days',
      comments: [
        comment(1, 'alice', 'Two days old', { created_at: '2025-02-27T00:00:00Z' }),
        comment(2, 'bob', 'Five days old', { created_at: '2025-02-24T00:00:00Z' }),
      ],
      expectedTooOld: [false, true],
    },
    {
      filter: '1week',
      comments: [
        comment(1, 'alice', 'Five days old', { created_at: '2025-02-24T00:00:00Z' }),
        comment(2, 'bob', 'Two weeks old', { created_at: '2025-02-15T00:00:00Z' }),
      ],
      expectedTooOld: [false, true],
    },
    {
      filter: '1month',
      comments: [
        comment(1, 'alice', 'Two weeks old', { created_at: '2025-02-15T00:00:00Z' }),
        comment(2, 'bob', 'Two months old', { created_at: '2025-01-01T00:00:00Z' }),
      ],
      expectedTooOld: [false, true],
    },
  ];

  cases.forEach(({ filter, comments, expectedTooOld }) => {
    assert.deepEqual(
      comments.map((item) => isCommentTooOld(item, filter, now)),
      expectedTooOld,
      filter
    );
  });
});
