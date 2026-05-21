const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getCommentStatus,
  getUninterestingReason,
  hasUnresolvedApprovalQualificationFailure,
  isApproved,
  isChangesRequested,
  isNeedsReview,
  isReviewResponsibility,
} = require('../../ghinbox/webapp/notifications-comment-status.js');

function notification(type = 'Issue', extra = {}) {
  return {
    id: `${type}-1`,
    reason: 'subscribed',
    updated_at: '2025-01-02T00:00:00Z',
    last_read_at: '2025-01-01T00:00:00Z',
    subject: {
      type,
      title: `${type} notification`,
      number: 1,
      state: 'open',
      ...extra.subject,
    },
    ...extra,
  };
}

function comment(id, login, body, extra = {}) {
  return {
    id,
    user: { login },
    body,
    created_at: `2025-01-01T0${Math.min(id, 9)}:00:00Z`,
    updated_at: `2025-01-01T0${Math.min(id, 9)}:00:00Z`,
    ...extra,
  };
}

function cached(extra = {}) {
  return {
    notificationUpdatedAt: '2025-01-02T00:00:00Z',
    lastReadAt: '2025-01-01T00:00:00Z',
    allComments: false,
    fetchedAt: '2025-01-02T00:00:00Z',
    comments: [comment(1, 'human', 'Please take a look.')],
    ...extra,
  };
}

test('reports pending and error status before comment data is renderable', () => {
  const notif = notification();
  assert.deepEqual(getCommentStatus(notif, null), {
    label: 'Comments: pending',
    className: 'pending',
  });
  assert.deepEqual(getCommentStatus(notif, cached({ error: 'boom' })), {
    label: 'Comments: error',
    className: 'error',
  });
});

test('approved review responsibilities are approved instead of needs-review', () => {
  const pr = notification('PullRequest', { reason: 'review_requested' });
  const approved = cached({ reviewDecision: 'APPROVED' });
  const changes = cached({ reviewDecision: 'CHANGES_REQUESTED' });

  assert.equal(isApproved(pr, approved), true);
  assert.deepEqual(getCommentStatus(pr, approved), {
    label: 'Approved',
    className: 'approved',
  });
  assert.equal(isNeedsReview(pr, approved), false);
  assert.equal(isChangesRequested(pr, changes), true);
  assert.equal(isNeedsReview(pr, changes), true);

  const mention = notification('PullRequest', { reason: 'mention' });
  assert.deepEqual(getCommentStatus(mention, approved), {
    label: 'Approved',
    className: 'approved',
  });

  const closed = notification('PullRequest', {
    reason: 'review_requested',
    subject: { state: 'closed' },
  });
  assert.equal(isApproved(closed, approved), false);
  assert.equal(isChangesRequested(closed, changes), false);
  assert.equal(isNeedsReview(closed, cached()), false);
});

test('mergedog-labeled PRs are neither approved nor needs-review', () => {
  const pr = notification('PullRequest', { reason: 'review_requested' });
  const approved = cached({
    reviewDecision: 'APPROVED',
    labelNames: ['mergedog'],
  });

  assert.equal(isApproved(pr, approved), false);
  assert.equal(isNeedsReview(pr, approved), false);
  assert.deepEqual(getCommentStatus(pr, approved), {
    label: 'Interesting (1)',
    className: 'interesting',
  });
});

test('approval-required PyTorch merge failures block approved status', () => {
  const pr = notification('PullRequest', { reason: 'review_requested' });
  const blocked = cached({
    reviewDecision: 'APPROVED',
    comments: [
      comment(
        1,
        'pytorchmergebot',
        [
          '## Merge failed',
          '**Reason**: Approvers from one of the following sets are needed:',
          '- superuser (pytorch/metamates)',
          '- Core Reviewers (mruberry, lezcano, Skylion007, ngimel, peterbell10, ...)',
          '- Core Maintainers (soumith, gchanan, ezyang, malfet, albanD, ...)',
        ].join('\n')
      ),
    ],
  });

  assert.equal(hasUnresolvedApprovalQualificationFailure(blocked), true);
  assert.equal(isApproved(pr, blocked), false);
  assert.equal(isNeedsReview(pr, blocked), true);
  assert.deepEqual(getCommentStatus(pr, blocked), {
    label: 'Needs review',
    className: 'needs-review',
  });
});

test('later PyTorch merge attempt clears stale approval-required failure', () => {
  const pr = notification('PullRequest', { reason: 'review_requested' });
  const approved = cached({
    reviewDecision: 'APPROVED',
    comments: [
      comment(
        1,
        'pytorchmergebot',
        [
          '## Merge failed',
          '**Reason**: Approvers from one of the following sets are needed:',
        ].join('\n'),
        { created_at: '2025-01-01T01:00:00Z', updated_at: '2025-01-01T01:00:00Z' }
      ),
      comment(2, 'pytorchmergebot', '### Merge started', {
        created_at: '2025-01-01T02:00:00Z',
        updated_at: '2025-01-01T02:00:00Z',
      }),
    ],
  });

  assert.equal(hasUnresolvedApprovalQualificationFailure(approved), false);
  assert.equal(isApproved(pr, approved), true);
});

test('labels uninteresting statuses with reason-specific copy and counts', () => {
  const notif = notification();
  const cases = [
    {
      cached: cached({ comments: [] }),
      reason: 'no-comments',
      status: { label: 'No new comments', className: 'uninteresting' },
    },
    {
      cached: cached({
        comments: [
          comment(1, 'dependabot[bot]', 'Bump dependency'),
          comment(2, 'github-actions[bot]', 'CI passed'),
        ],
      }),
      reason: 'bot-only',
      status: { label: 'Bot comments only (2)', className: 'uninteresting' },
    },
    {
      cached: cached({
        comments: [
          comment(1, 'alice', '@pytorchbot label feature'),
          comment(2, 'bob', '/merge'),
        ],
      }),
      reason: 'bot-commands',
      status: { label: 'Bot commands only (2)', className: 'uninteresting' },
    },
  ];

  cases.forEach((entry) => {
    assert.equal(getUninterestingReason(notif, entry.cached), entry.reason);
    assert.deepEqual(getCommentStatus(notif, entry.cached), entry.status);
  });
});

test('labels direct review-thread replies before generic needs-review status', () => {
  const pr = notification('PullRequest', { reason: 'review_requested' });
  const cache = cached({
    comments: [
      comment(1, 'testuser', 'I left a note.', {
        isReviewComment: true,
        id: 101,
        path: 'app.py',
        line: 10,
        pull_request_review_id: 101,
      }),
      comment(2, 'reviewer', 'I pushed a simplification here.', {
        isReviewComment: true,
        id: 102,
        in_reply_to_id: 101,
        path: 'app.py',
        line: 10,
        pull_request_review_id: 101,
      }),
      comment(3, 'reviewer', 'Separate note on another thread.', {
        isReviewComment: true,
        id: 201,
        path: 'other.py',
        line: 20,
        pull_request_review_id: 102,
      }),
    ],
  });

  assert.deepEqual(getCommentStatus(pr, cache, { currentUserLogin: 'testuser' }), {
    label: 'Reply to you',
    className: 'interesting',
  });
});

test('labels open review-requested PRs as needs review when not approved or changed-requested', () => {
  const pr = notification('PullRequest', { reason: 'review_requested' });
  assert.equal(isReviewResponsibility(pr), true);
  assert.equal(isNeedsReview(pr, cached()), true);
  assert.deepEqual(getCommentStatus(pr, cached()), {
    label: 'Needs review',
    className: 'needs-review',
  });

  const synthetic = notification('PullRequest', {
    reason: 'subscribed',
    responsibility_source: 'review-requested',
  });
  assert.equal(isReviewResponsibility(synthetic), true);
  assert.equal(isNeedsReview(synthetic, cached()), true);
});

test('uses anchor-windowed comments for counts', () => {
  const notif = notification('Issue', {
    subject: { anchor: 'issuecomment-2' },
  });
  const status = getCommentStatus(
    notif,
    cached({
      allComments: true,
      anchor: 'issuecomment-2',
      comments: [
        comment(1, 'dependabot[bot]', 'Old bot note'),
        comment(2, 'dependabot[bot]', 'Unread bot note'),
        comment(3, 'github-actions[bot]', 'Later bot note'),
      ],
    })
  );

  assert.deepEqual(status, {
    label: 'Bot comments only (2)',
    className: 'uninteresting',
  });
});

test('uses last-read-windowed all-comments cache for counts', () => {
  const notif = notification('PullRequest', {
    last_read_at: '2025-01-03T00:00:00Z',
  });
  const status = getCommentStatus(
    notif,
    cached({
      allComments: true,
      lastReadAt: '2025-01-03T00:00:00Z',
      comments: [
        comment(1, 'alice', 'Old human comment', {
          updated_at: '2025-01-02T00:00:00Z',
        }),
        comment(2, 'dependabot[bot]', 'Unread bot note', {
          updated_at: '2025-01-03T00:00:01Z',
        }),
      ],
    })
  );

  assert.deepEqual(status, {
    label: 'Bot comments only (1)',
    className: 'uninteresting',
  });
});
