const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cloneDefaultViewFilters,
  getFilteredNotifications,
  getSubfilterCounts,
  getViewCounts,
  isNotificationOutsidePytorchOrgs,
  isPytorchCoreNotification,
  makeClassifier,
  normalizeViewFilters,
} = require('../../ghinbox/webapp/notifications-filtering.js');

function notification(id, type, state, reason = 'subscribed', extra = {}) {
  return {
    id,
    reason,
    updated_at: `2025-01-01T00:00:0${id.length % 10}Z`,
    subject: {
      type,
      state,
      title: id,
      url: `https://github.com/test/repo/${type === 'Issue' ? 'issues' : 'pull'}/${id}`,
    },
    ui: { saved: false, done: false },
    ...extra,
  };
}

const fixtures = [
  notification('issue-open', 'Issue', 'open'),
  notification('issue-closed', 'Issue', 'closed'),
  notification('my-pr', 'PullRequest', 'open', 'author'),
  notification('review-pr', 'PullRequest', 'open', 'review_requested'),
  notification('draft-pr', 'PullRequest', 'draft', 'review_requested'),
  notification('merged-pr', 'PullRequest', 'merged', 'review_requested'),
  notification('approved-pr', 'PullRequest', 'open'),
  notification('approved-review-pr', 'PullRequest', 'open', 'review_requested'),
  notification('mergedog-pr', 'PullRequest', 'open', 'review_requested', {
    labels: [{ name: 'mergedog' }],
  }),
  notification('changes-requested-pr', 'PullRequest', 'open'),
  notification('reply-pr', 'PullRequest', 'open'),
  notification('external-pr', 'PullRequest', 'open', 'review_requested'),
  notification('ai-pr', 'PullRequest', 'open', 'review_requested'),
];

const baseDeps = {
  isNotificationDirectedAtCurrentUser: (notification) => notification.id === 'reply-pr',
  isNotificationApproved: (notification) =>
    notification.id === 'approved-review-pr' || notification.id === 'mergedog-pr',
  isNotificationChangesRequested: (notification) => notification.id === 'changes-requested-pr',
  isNotificationReviewResponsibility: (notification) =>
    notification.reason === 'review_requested',
  isNotificationFromCommitter: (notification) =>
    notification.id === 'review-pr' || notification.id === 'ai-pr',
  isNotificationFromAiAuthor: (notification) => notification.id === 'ai-pr',
  hasNotificationAuthorPermission: (notification) =>
    notification.id === 'review-pr' || notification.id === 'external-pr',
  getUninterestingReason: (notification) =>
    notification.id === 'issue-closed' || notification.id === 'merged-pr'
      ? 'no-comments'
      : null,
  getNotificationSize: (notification) =>
    ({
      'review-pr': 30,
      'approved-review-pr': 10,
      'external-pr': null,
    })[notification.id] ?? null,
};

function input(overrides = {}) {
  return {
    notifications: fixtures,
    trashNotifications: [],
    view: 'issues',
    viewFilters: cloneDefaultViewFilters(),
    orderBy: 'recent',
    currentUserLogin: 'testuser',
    deps: baseDeps,
    ...overrides,
  };
}

function ids(notifications) {
  return notifications.map((notification) => notification.id);
}

test('normalizes persisted legacy and partial view filters', () => {
  assert.deepEqual(normalizeViewFilters({ issues: 'closed' }).issues, {
    state: 'closed',
    bookmark: 'new',
    type: 'all',
    interest: 'all',
  });
  assert.deepEqual(normalizeViewFilters({ 'others-prs': { author: 'external' } })['others-prs'], {
    state: 'all',
    author: 'external',
    interest: 'all',
  });
  assert.deepEqual(normalizeViewFilters({ 'others-prs': { author: 'ai' } })['others-prs'], {
    state: 'all',
    author: 'ai',
    interest: 'all',
  });
  assert.equal(normalizeViewFilters({ 'others-prs': 'closed' })['others-prs'].state, 'done');
  assert.equal(normalizeViewFilters({ 'others-prs': { state: 'draft' } })['others-prs'].state, 'done');
});

test('classifies notifications into view counts', () => {
  assert.deepEqual(getViewCounts(input()), {
    issues: 5,
    myPrs: 1,
    prNotifications: 1,
    othersPrs: 7,
    trash: 0,
  });
});

[
  {
    name: 'feed hides review responsibility and replies',
    view: 'issues',
    filters: {},
    expected: ['issue-open', 'issue-closed', 'my-pr', 'approved-pr', 'changes-requested-pr'],
  },
  {
    name: 'feed open filter includes open issues and own open PRs',
    view: 'issues',
    filters: { issues: { state: 'open' } },
    expected: ['issue-open', 'my-pr', 'approved-pr', 'changes-requested-pr'],
  },
  {
    name: 'feed closed filter includes closed issues',
    view: 'issues',
    filters: { issues: { state: 'closed' } },
    expected: ['issue-closed'],
  },
  {
    name: 'reviews needs-review follows active review responsibility, not aggregate review decision',
    view: 'others-prs',
    filters: { 'others-prs': { state: 'needs-review' } },
    expected: ['review-pr', 'external-pr', 'ai-pr'],
  },
  {
    name: 'reviews approved excludes mergedog PRs',
    view: 'others-prs',
    filters: { 'others-prs': { state: 'approved' } },
    expected: ['approved-review-pr'],
  },
  {
    name: 'reviews done filter matches draft, closed, and mergedog review requests',
    view: 'others-prs',
    filters: { 'others-prs': { state: 'done' } },
    expected: ['draft-pr', 'merged-pr', 'mergedog-pr'],
  },
  {
    name: 'reviews importance filter keeps all non-AI work outside pytorch/pytorch',
    view: 'others-prs',
    filters: { 'others-prs': { author: 'committer' } },
    expected: [
      'review-pr',
      'draft-pr',
      'merged-pr',
      'approved-review-pr',
      'mergedog-pr',
      'external-pr',
    ],
  },
  {
    name: 'reviews external filter ignores lower-volume repositories',
    view: 'others-prs',
    filters: { 'others-prs': { author: 'external' } },
    expected: [],
  },
  {
    name: 'reviews author filter separates AI authors by login',
    view: 'others-prs',
    filters: { 'others-prs': { author: 'ai' } },
    expected: ['ai-pr'],
  },
  {
    name: 'interest no-new keeps uninteresting feed items',
    view: 'issues',
    filters: { issues: { interest: 'no-new' } },
    expected: ['issue-closed'],
  },
  {
    name: 'interest has-new keeps interesting feed items',
    view: 'issues',
    filters: { issues: { interest: 'has-new' } },
    expected: ['issue-open', 'my-pr', 'approved-pr', 'changes-requested-pr'],
  },
  {
    name: 'replies view keeps directed notifications',
    view: 'pr-notifications',
    filters: {},
    expected: ['reply-pr'],
  },
].forEach(({ name, view, filters, expected }) => {
  test(name, () => {
    assert.deepEqual(
      ids(getFilteredNotifications(input({
        view,
        viewFilters: normalizeViewFilters(filters),
      }))),
      expected
    );
  });
});

test('sorts review notifications by size with stable nulls last', () => {
  assert.deepEqual(
    ids(getFilteredNotifications(input({
      view: 'others-prs',
      viewFilters: normalizeViewFilters({ 'others-prs': { state: 'all' } }),
      orderBy: 'size',
    }))),
    ['approved-review-pr', 'review-pr', 'draft-pr', 'merged-pr', 'mergedog-pr', 'external-pr', 'ai-pr']
  );
});

test('computes subfilter counts after cross-filters', () => {
  const counts = getSubfilterCounts(input({
    view: 'others-prs',
    viewFilters: normalizeViewFilters({ 'others-prs': { author: 'committer' } }),
  }));

  assert.deepEqual(counts.state, {
    all: 6,
    open: 5,
    closed: 1,
    draft: 1,
    done: 3,
    needsReview: 2,
    approved: 1,
  });
  assert.deepEqual(counts.author, {
    all: 7,
    committer: 6,
    ai: 1,
    external: 0,
  });
});

test('computes feed interest subfilter counts', () => {
  const interestNotifications = [
    notification('thread-interesting', 'Issue', 'open'),
    notification('thread-bot-only', 'Issue', 'open'),
    notification('thread-bot-commands', 'Issue', 'open'),
    notification('thread-no-comments', 'Issue', 'open'),
  ];
  const counts = getSubfilterCounts(input({
    notifications: interestNotifications,
    deps: {
      ...baseDeps,
      getUninterestingReason: (notification) =>
        notification.id === 'thread-interesting' ? null : 'no-comments',
    },
  }));

  assert.deepEqual(counts.interest, {
    all: 4,
    hasNew: 1,
    noNew: 3,
  });
});

test('identifies repositories outside the PyTorch-family orgs', () => {
  const from = (owner) => notification('org-item', 'Issue', 'open', 'subscribed', {
    repository: { owner, name: 'repo', full_name: `${owner}/repo` },
  });

  assert.equal(isNotificationOutsidePytorchOrgs(from('pytorch')), false);
  assert.equal(isNotificationOutsidePytorchOrgs(from('meta-pytorch')), false);
  assert.equal(isNotificationOutsidePytorchOrgs(from('Google-PyTorch')), false);
  assert.equal(isNotificationOutsidePytorchOrgs(from('acme')), true);
  assert.equal(isNotificationOutsidePytorchOrgs(notification('unknown', 'Issue', 'open')), false);
});

test('all-notifications policy keeps outside-org review responsibility in Reviews', () => {
  const outsideReview = notification(
    'outside-review',
    'PullRequest',
    'open',
    'review_requested',
    { repository: { owner: 'acme', name: 'widgets', full_name: 'acme/widgets' } }
  );
  const classifier = makeClassifier({
    routeOutsidePytorchToReplies: true,
    deps: baseDeps,
  });

  assert.equal(classifier.matchesView(outsideReview, 'issues'), false);
  assert.equal(classifier.matchesView(outsideReview, 'others-prs'), true);
  assert.equal(classifier.matchesView(outsideReview, 'pr-notifications'), false);
  assert.equal(classifier.isTrashNotification(outsideReview), false);
});

test('muted repositories never surface review requests in any view', () => {
  const repoFields = (repo) => ({
    owner: repo.split('/')[0],
    name: repo.split('/')[1],
    full_name: repo,
  });
  const syntheticReview = (repo) => notification(
    `review-request:${repo}#1`,
    'PullRequest',
    'open',
    'review_requested',
    {
      repository: repoFields(repo),
      responsibility_source: 'review-requested',
    }
  );
  const inboxReview = (repo) => notification(
    `inbox-${repo}`,
    'PullRequest',
    'open',
    'review_requested',
    { repository: repoFields(repo) }
  );
  const mutedRepos = [
    'conda-forge/onnx-feedstock',
    'pytorch/pytorch-canary',
    'facebookresearch/fairscale',
  ];
  const views = ['issues', 'my-prs', 'pr-notifications', 'others-prs'];

  [false, true].forEach((routeOutsidePytorchToReplies) => {
    const classifier = makeClassifier({
      routeOutsidePytorchToReplies,
      deps: baseDeps,
    });
    mutedRepos.forEach((repo) => {
      const synthetic = syntheticReview(repo);
      const inbox = inboxReview(repo);
      views.forEach((view) => {
        assert.equal(classifier.matchesView(synthetic, view), false, `${repo} synthetic ${view}`);
        assert.equal(classifier.matchesView(inbox, view), false, `${repo} inbox ${view}`);
      });
      assert.equal(classifier.isNotificationReviewQueue(synthetic), false);
      assert.equal(classifier.isNotificationReviewQueue(inbox), false);
      assert.equal(classifier.isNotificationNeedsReview(synthetic), false);
      assert.equal(classifier.isNotificationNeedsReview(inbox), false);
      // Synthetic search results have no inbox thread to archive; real
      // muted threads are swept into Cleaned.
      assert.equal(classifier.isTrashNotification(synthetic), false);
      assert.equal(classifier.isTrashNotification(inbox), true);
    });

    const unmuted = syntheticReview('conda-forge/other-feedstock');
    assert.equal(classifier.isNotificationReviewQueue(unmuted), true);
    assert.equal(classifier.matchesView(unmuted, 'others-prs'), true);
  });
});

test('review importance only separates external authors for pytorch/pytorch', () => {
  const review = (id, repo) => notification(
    id,
    'PullRequest',
    'open',
    'review_requested',
    {
      repository: {
        owner: repo.split('/')[0],
        name: repo.split('/')[1],
        full_name: repo,
      },
    }
  );
  const cases = [
    {
      name: 'PyTorch core external author',
      notification: review('core-external', 'pytorch/pytorch'),
      fromCommitter: false,
      hasPermission: true,
      important: false,
      external: true,
    },
    {
      name: 'PyTorch core committer',
      notification: review('core-committer', 'pytorch/pytorch'),
      fromCommitter: true,
      hasPermission: true,
      important: true,
      external: false,
    },
    {
      name: 'lower-volume PyTorch repository',
      notification: review('vision-external', 'pytorch/vision'),
      fromCommitter: false,
      hasPermission: true,
      important: true,
      external: false,
    },
    {
      name: 'repository outside the PyTorch orgs',
      notification: review('acme-external', 'acme/widgets'),
      fromCommitter: false,
      hasPermission: true,
      important: true,
      external: false,
    },
    {
      name: 'non-core repository without author metadata',
      notification: review('meta-unknown', 'meta-pytorch/torchchat'),
      fromCommitter: false,
      hasPermission: false,
      important: true,
      external: false,
    },
  ];

  cases.forEach((entry) => {
    const classifier = makeClassifier({
      deps: {
        ...baseDeps,
        isNotificationFromCommitter: () => entry.fromCommitter,
        hasNotificationAuthorPermission: () => entry.hasPermission,
      },
    });
    assert.equal(
      classifier.isNotificationImportant(entry.notification),
      entry.important,
      `${entry.name}: important`
    );
    assert.equal(
      classifier.isNotificationFromExternal(entry.notification),
      entry.external,
      `${entry.name}: external`
    );
  });

  assert.equal(isPytorchCoreNotification(review('core', 'PyTorch/PyTorch')), true);
  assert.equal(isPytorchCoreNotification(review('vision', 'pytorch/vision')), false);
});
