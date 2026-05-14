const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_COMMENT_CACHE_TTL_MS,
  getPendingReviewMetadataNotifications,
  getReviewMetadataNeeds,
  isAuthorAssociationFresh,
  isAuthorLoginFresh,
  isAuthorPermissionFresh,
  isCommentCacheFresh,
  isDiffstatFresh,
  isReviewDecisionFresh,
  shouldPrefetchNotificationComments,
  shouldPrefetchReviewMetadata,
} = require('../../ghinbox/webapp/notifications-comment-cache-policy.js');

const nowMs = Date.parse('2026-05-14T12:00:00Z');
const freshIso = new Date(nowMs - 60 * 1000).toISOString();
const staleIso = new Date(nowMs - DEFAULT_COMMENT_CACHE_TTL_MS - 60 * 1000).toISOString();

function notification(id, extra = {}) {
  return {
    id,
    updated_at: '2026-05-14T11:00:00Z',
    subject: {
      type: 'Issue',
      number: 1,
      ...extra.subject,
    },
    ...extra,
  };
}

function cached(extra = {}) {
  return {
    notificationUpdatedAt: '2026-05-14T11:00:00Z',
    fetchedAt: freshIso,
    allComments: true,
    comments: [],
    ...extra,
  };
}

test('freshness helpers accept explicit null metadata and reject stale or absent fields', () => {
  const cache = cached({
    reviewDecision: null,
    authorAssociation: 'CONTRIBUTOR',
    authorPermission: 'read',
    authorLogin: 'alice',
    additions: 0,
    deletions: 3,
  });

  assert.equal(isCommentCacheFresh(cache, { nowMs }), true);
  assert.equal(isReviewDecisionFresh(cache, { nowMs }), true);
  assert.equal(isAuthorAssociationFresh(cache, { nowMs }), true);
  assert.equal(isAuthorPermissionFresh(cache, { nowMs }), true);
  assert.equal(isAuthorLoginFresh(cache, { nowMs }), true);
  assert.equal(isDiffstatFresh(cache, { nowMs }), true);

  assert.equal(isCommentCacheFresh(cached({ fetchedAt: staleIso }), { nowMs }), false);
  assert.equal(isReviewDecisionFresh(cached(), { nowMs }), false);
  assert.equal(isAuthorAssociationFresh(cached(), { nowMs }), false);
  assert.equal(isAuthorPermissionFresh(cached(), { nowMs }), false);
  assert.equal(isAuthorLoginFresh(cached(), { nowMs }), false);
  assert.equal(isDiffstatFresh(cached({ additions: 1 }), { nowMs }), false);
});

[
  {
    name: 'missing cache',
    cache: null,
    expected: true,
  },
  {
    name: 'same notification with all comments',
    cache: cached(),
    expected: false,
  },
  {
    name: 'changed notification updated time',
    cache: cached({ notificationUpdatedAt: '2026-05-14T10:00:00Z' }),
    expected: true,
  },
  {
    name: 'stale cache',
    cache: cached({ fetchedAt: staleIso }),
    expected: true,
  },
  {
    name: 'unfiltered notification without all comments',
    cache: cached({ allComments: false }),
    expected: true,
  },
  {
    name: 'matching anchor and last read window',
    notification: notification('anchor', {
      last_read_at: '2026-05-14T10:30:00Z',
      subject: { anchor: 'issuecomment-12' },
    }),
    cache: cached({
      anchor: 'issuecomment-12',
      lastReadAt: '2026-05-14T10:30:00Z',
      allComments: false,
    }),
    expected: false,
  },
  {
    name: 'changed last read window',
    notification: notification('anchor', {
      last_read_at: '2026-05-14T10:31:00Z',
      subject: { anchor: 'issuecomment-12' },
    }),
    cache: cached({
      anchor: 'issuecomment-12',
      lastReadAt: '2026-05-14T10:30:00Z',
      allComments: false,
    }),
    expected: true,
  },
].forEach((entry) => {
  test(`comment prefetch: ${entry.name}`, () => {
    assert.equal(
      shouldPrefetchNotificationComments(entry.notification || notification('issue'), entry.cache, {
        nowMs,
      }),
      entry.expected
    );
  });
});

test('review metadata needs are gated by requested fields', () => {
  const cache = cached({
    reviewDecision: null,
    authorLogin: 'alice',
    additions: 5,
    deletions: 1,
  });

  assert.deepEqual(getReviewMetadataNeeds(cache, { nowMs }), {
    reviewDecision: false,
    authorAssociation: false,
    authorPermission: false,
    authorLogin: false,
    diffstat: false,
  });
  assert.deepEqual(getReviewMetadataNeeds(cache, { nowMs, includeAuthorAssociation: true }), {
    reviewDecision: false,
    authorAssociation: true,
    authorPermission: false,
    authorLogin: false,
    diffstat: false,
  });
  assert.deepEqual(getReviewMetadataNeeds(cache, { nowMs, includeAuthorPermission: true }), {
    reviewDecision: false,
    authorAssociation: false,
    authorPermission: true,
    authorLogin: false,
    diffstat: false,
  });
});

test('review metadata prefetch selects only PRs with missing requested metadata', () => {
  const issue = notification('issue');
  const freshPr = notification('fresh-pr', { subject: { type: 'PullRequest' } });
  const stalePr = notification('stale-pr', { subject: { type: 'PullRequest' } });
  const missingAssociationPr = notification('assoc-pr', { subject: { type: 'PullRequest' } });
  const cacheThreads = {
    'fresh-pr': cached({
      reviewDecision: 'APPROVED',
      authorAssociation: 'MEMBER',
      authorPermission: 'write',
      authorLogin: 'alice',
      additions: 1,
      deletions: 2,
    }),
    'stale-pr': cached({
      fetchedAt: staleIso,
      reviewDecision: null,
      authorAssociation: 'CONTRIBUTOR',
      authorPermission: 'read',
      authorLogin: 'bob',
      additions: 1,
      deletions: 2,
    }),
    'assoc-pr': cached({
      reviewDecision: null,
      authorPermission: 'read',
      authorLogin: 'carol',
      additions: 1,
      deletions: 2,
    }),
  };

  assert.equal(shouldPrefetchReviewMetadata(issue, null, { nowMs }), false);
  assert.equal(shouldPrefetchReviewMetadata(freshPr, cacheThreads['fresh-pr'], { nowMs }), false);

  assert.deepEqual(
    getPendingReviewMetadataNotifications(
      [issue, freshPr, stalePr, missingAssociationPr],
      cacheThreads,
      { nowMs, includeAuthorAssociation: true }
    ).map((item) => item.id),
    ['stale-pr', 'assoc-pr']
  );

  assert.deepEqual(
    getPendingReviewMetadataNotifications([issue, freshPr], cacheThreads, {
      force: true,
      nowMs,
    }).map((item) => item.id),
    ['fresh-pr']
  );
});
