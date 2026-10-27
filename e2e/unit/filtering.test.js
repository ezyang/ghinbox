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
    verdict: 'all',
  });
  assert.deepEqual(normalizeViewFilters({ 'others-prs': { author: 'ai' } })['others-prs'], {
    state: 'all',
    author: 'ai',
    interest: 'all',
    verdict: 'all',
  });
  assert.equal(normalizeViewFilters({ 'others-prs': 'closed' })['others-prs'].state, 'done');
  assert.equal(normalizeViewFilters({ 'others-prs': { state: 'draft' } })['others-prs'].state, 'done');
  assert.equal(normalizeViewFilters({ 'others-prs': { verdict: 'bogus' } })['others-prs'].verdict, 'all');
  assert.equal(normalizeViewFilters({ 'others-prs': { verdict: 'look' } })['others-prs'].verdict, 'look');
});

test('classifies notifications into view counts', () => {
  assert.deepEqual(getViewCounts(input()), {
    issues: 5,
    myPrs: 1,
    prNotifications: 1,
    othersPrs: 7,
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
  // No digest verdicts yet: nothing is skipped.
  assert.deepEqual(counts.verdict, { all: 6, look: 6, skip: 0 });
});

test('digest review verdicts hide only skipped PRs under "Worth a look"', () => {
  const pr = (id, number) => notification(id, 'PullRequest', 'open', 'review_requested', {
    repository: { full_name: 'PyTorch/PyTorch' },
    subject: { type: 'PullRequest', state: 'open', title: id, number },
  });
  const notifications = [pr('looked', 1), pr('skipped', 2), pr('unjudged', 3)];
  const reviewVerdicts = new Map([
    ['pytorch/pytorch#1', { verdict: 'look', buckets: ['easy'], why: 'tiny fix' }],
    ['pytorch/pytorch#2', { verdict: 'skip', buckets: [], why: 'drive-by' }],
  ]);
  const deps = {
    ...baseDeps,
    isNotificationFromCommitter: () => false,
    hasNotificationAuthorPermission: () => true,
  };
  const reviews = (verdict) => input({
    notifications,
    view: 'others-prs',
    viewFilters: normalizeViewFilters({ 'others-prs': { verdict } }),
    reviewVerdicts,
    deps,
  });

  assert.deepEqual(ids(getFilteredNotifications(reviews('all'))), ['looked', 'skipped', 'unjudged']);
  assert.deepEqual(ids(getFilteredNotifications(reviews('look'))), ['looked', 'unjudged']);
  assert.deepEqual(ids(getFilteredNotifications(reviews('skip'))), ['skipped']);
  const counts = getSubfilterCounts(reviews('look'));
  assert.deepEqual(counts.verdict, { all: 3, look: 2, skip: 1 });
  assert.equal(counts.author.external, 2);
  assert.equal(
    makeClassifier({ reviewVerdicts, deps }).getReviewVerdict(notifications[1]).why,
    'drive-by'
  );
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
      // muted threads are swept (marked done).
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

test('PyTorch workflow labels route review requests by whose turn it is', () => {
  let nextNumber = 1;
  const review = (id, labels, repo = 'pytorch/pytorch') => notification(
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
      subject: { type: 'PullRequest', state: 'open', title: id, number: nextNumber++ },
      labels: labels.map((name) => ({ name })),
    }
  );
  const cases = [
    {
      name: 'external PR with no workflow label',
      notification: review('plain', ['triaged', 'open source']),
      reviewQueue: true,
      important: false,
      externalCandidate: true,
    },
    {
      name: 'external PR ready for review is promoted to Important',
      notification: review('ready', ['triaged', 'open source', 'ready for review']),
      reviewQueue: true,
      important: true,
      externalCandidate: false,
    },
    {
      name: 'in progress waits on the author',
      notification: review('in-progress', ['triaged', 'in progress']),
      reviewQueue: false,
      important: false,
      externalCandidate: false,
    },
    {
      name: 'missing actionable issue waits on the author',
      notification: review('missing', ['bot-triaged', 'Missing Actionable Issue']),
      reviewQueue: false,
      important: false,
      externalCandidate: false,
    },
    {
      name: 'workflow labels mean nothing outside pytorch/pytorch',
      notification: review('vision', ['in progress'], 'pytorch/vision'),
      reviewQueue: true,
      important: true,
      externalCandidate: false,
    },
  ];

  const notifications = cases.map((entry) => entry.notification);
  // Muse judged both skippable before the ready PR passed pre-review.
  const reviewVerdicts = {
    'pytorch/pytorch#1': { verdict: 'skip' },
    'pytorch/pytorch#2': { verdict: 'skip' },
  };
  const deps = {
    ...baseDeps,
    isNotificationFromCommitter: () => false,
    hasNotificationAuthorPermission: () => true,
  };
  const classifier = makeClassifier({ notifications, reviewVerdicts, deps });
  cases.forEach((entry) => {
    assert.equal(
      classifier.matchesView(entry.notification, 'others-prs'),
      entry.reviewQueue,
      `${entry.name}: in Reviews`
    );
    assert.equal(
      classifier.isNotificationNeedsReview(entry.notification),
      entry.reviewQueue,
      `${entry.name}: needs review`
    );
    assert.equal(
      classifier.isNotificationImportant(entry.notification),
      entry.important,
      `${entry.name}: important`
    );
    assert.equal(
      classifier.isExternalReviewCandidate(entry.notification),
      entry.externalCandidate,
      `${entry.name}: external review candidate`
    );
  });

  const reviews = (author, verdict = 'all') => ids(getFilteredNotifications(input({
    notifications,
    view: 'others-prs',
    viewFilters: normalizeViewFilters({ 'others-prs': { author, verdict } }),
    reviewVerdicts,
    deps,
  })));
  assert.deepEqual(reviews('committer'), ['ready', 'vision']);
  assert.deepEqual(reviews('external'), ['plain']);
  assert.deepEqual(reviews('all', 'look'), ['ready', 'vision']);
});

test('real threads for PRs waiting in Reviews leave Feed and Replies', () => {
  const pr = (id, repo, number, extra = {}) => ({
    id,
    reason: 'comment',
    updated_at: '2025-01-01T00:00:00Z',
    repository: { full_name: repo },
    subject: { type: 'PullRequest', state: 'open', number, title: id, url: `https://github.com/${repo}/pull/${number}` },
    ui: { saved: false, done: false },
    ...extra,
  });
  const request = (repo, number, extra = {}) => pr(`review-request:${repo}#${number}`, repo, number, {
    reason: 'review_requested',
    responsibility_source: 'review-requested',
    ...extra,
  });
  const notifications = [
    request('test/repo', 1),
    request('test/repo', 2, { subject: { type: 'PullRequest', state: 'closed', number: 2 } }),
    request('pytorch/pytorch-canary', 3),
    pr('reply-waiting', 'test/repo', 1),
    pr('feed-waiting', 'test/repo', 1),
    pr('closed-request', 'test/repo', 2),
    pr('muted-request', 'pytorch/pytorch-canary', 3),
    pr('other-repo', 'test/other', 1),
    pr('approved', 'test/repo', 4),
    request('test/repo', 4),
    pr('real-request', 'test/repo', 1, { reason: 'review_requested' }),
  ];
  const classifier = makeClassifier({
    notifications,
    deps: {
      isNotificationDirectedAtCurrentUser: (n) => n.id === 'reply-waiting',
      isNotificationApproved: (n) => n.subject.number === 4,
    },
  });
  const table = Object.fromEntries(notifications.map((n) => [n.id, [
    classifier.isReviewQueueDuplicate(n),
    classifier.matchesView(n, 'issues'),
    classifier.matchesView(n, 'pr-notifications'),
  ]]));

  assert.deepEqual(table, {
    'review-request:test/repo#1': [false, false, false],
    'review-request:test/repo#2': [false, false, false],
    'review-request:pytorch/pytorch-canary#3': [false, false, false],
    'reply-waiting': [true, false, false],
    'feed-waiting': [true, false, false],
    'closed-request': [false, true, false],
    'muted-request': [false, true, false],
    'other-repo': [false, true, false],
    approved: [false, true, false],
    'review-request:test/repo#4': [false, false, false],
    'real-request': [false, false, false],
  });
});

test('Muse reply demotions move Replies to Feed only at the judged updated_at', () => {
  const reply = (id, updatedAt) => ({
    id,
    reason: 'mention',
    updated_at: updatedAt,
    subject: { type: 'Issue', state: 'open', title: id },
    ui: { saved: false, done: false },
  });
  const notifications = [
    reply('judged', '2026-09-01T00:00:00Z'),
    reply('newer-activity', '2026-09-02T00:00:00Z'),
    reply('kept', '2026-09-01T00:00:00Z'),
  ];
  const classifier = makeClassifier({
    notifications,
    replyDemotions: new Map([
      ['judged', { updated_at: '2026-09-01T00:00:00Z', why: 'thanks only' }],
      ['newer-activity', '2026-09-01T00:00:00Z'],
    ]),
    deps: { isNotificationDirectedAtCurrentUser: () => true },
  });
  const table = Object.fromEntries(notifications.map((n) => [n.id, [
    classifier.isReplyDemoted(n),
    classifier.matchesView(n, 'issues'),
    classifier.matchesView(n, 'pr-notifications'),
  ]]));
  assert.deepEqual(table, {
    judged: [true, true, false],
    'newer-activity': [false, false, true],
    kept: [false, false, true],
  });
});
