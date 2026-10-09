const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  applyPendingMerges,
  assessPullRequest,
  buildShipSearchQuery,
  buildShipSections,
  buildStackLookupGraphql,
  getMergebotState,
  getMissingStackNumbers,
  getShipButtonLabel,
  groupIntoStacks,
  normalizePullRequest,
  parseDrCiComment,
  parseGhstackStack,
  planShip,
  resolveStackMerges,
  summarizeCi,
} = require('../../ghinbox/webapp/notifications-ship.js');

// Harvested by scripts/harvest_ship_fixtures.py from real pytorch/pytorch PRs.
function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ship', `${name}.md`), 'utf8');
}

const NOW = Date.parse('2026-10-09T06:00:00Z');

test('parseDrCiComment reads headline, head sha, and sections from real comments', () => {
  const cases = [
    {
      name: 'drci-no-failures',
      headline: 'No Failures',
      sections: [],
      ci: { state: 'green', blocking: 0, unrelated: 0, pending: 0 },
    },
    {
      name: 'drci-pending',
      headline: 'No Failures, 1 Pending',
      sections: [],
      ci: { state: 'pending', blocking: 0, unrelated: 0, pending: 1 },
    },
    {
      name: 'drci-merge-normally-flaky',
      headline: 'You can merge normally! (1 Unrelated Failure)',
      sections: [['FLAKY', 'unrelated']],
      ci: { state: 'green', blocking: 0, unrelated: 1, pending: 0 },
    },
    {
      name: 'drci-new-failure',
      headline: '1 New Failure',
      sections: [['NEW FAILURE', 'blocking']],
      ci: { state: 'failing', blocking: 1, unrelated: 0, pending: 0 },
    },
    {
      name: 'drci-cancelled-pending',
      headline: '1 Cancelled Job, 3 Pending',
      sections: [['CANCELLED JOB', 'blocking']],
      ci: { state: 'failing', blocking: 1, unrelated: 0, pending: 3 },
    },
    {
      name: 'drci-broken-trunk',
      headline: 'You can merge normally! (1 Unrelated Failure)',
      sections: [['BROKEN TRUNK', 'unrelated']],
      ci: { state: 'green', blocking: 0, unrelated: 1, pending: 0 },
    },
    {
      name: 'drci-unstable',
      sections: [['UNSTABLE', 'unrelated']],
      ci: { state: 'green', blocking: 0, unrelated: 2, pending: 0 },
    },
    {
      name: 'drci-unclassified',
      headline: '1 Unclassified Failure',
      sections: [['UNCLASSIFIED FAILURE', 'blocking']],
      ci: { state: 'failing', blocking: 1, unrelated: 0, pending: 0 },
    },
    {
      name: 'drci-ai-suppressed',
      sections: [['NEW FAILURES SUPPRESSED BY AI (non-blocking)', 'unrelated']],
      ci: { state: 'green', blocking: 0, unrelated: 1, pending: 0 },
    },
    {
      name: 'drci-crcr',
      headline: 'You can merge normally! (26 Unrelated Failures)',
      sections: [['CRCR (non-blocking)', 'unrelated']],
      ci: { state: 'green', blocking: 0, unrelated: 26, pending: 0 },
    },
    {
      name: 'drci-new-and-broken-trunk',
      headline: '1 New Failure, 1 Unrelated Failure',
      sections: [['NEW FAILURE', 'blocking'], ['BROKEN TRUNK', 'unrelated']],
      ci: { state: 'failing', blocking: 1, unrelated: 1, pending: 0 },
    },
  ];
  for (const testCase of cases) {
    const drci = parseDrCiComment(fixture(testCase.name));
    assert.ok(drci, testCase.name);
    if (testCase.headline) {
      assert.equal(drci.headline, testCase.headline, testCase.name);
    }
    assert.match(drci.headSha, /^[0-9a-f]{40}$/, testCase.name);
    assert.deepEqual(
      drci.sections.map((section) => [section.name, section.kind]),
      testCase.sections,
      testCase.name
    );
    const ci = summarizeCi({ drci, rollup: 'FAILURE', headSha: drci.headSha });
    assert.deepEqual(
      {
        state: ci.state,
        blocking: ci.blockingJobs.length,
        unrelated: ci.unrelatedCount,
        pending: ci.pendingCount,
      },
      testCase.ci,
      testCase.name
    );
    assert.equal(ci.stale, false, testCase.name);
  }
});

test('parseDrCiComment keeps job links and failing tests, not nested AI verdicts', () => {
  const drci = parseDrCiComment(fixture('drci-new-failure'));
  assert.equal(drci.sections.length, 1);
  const [job] = drci.sections[0].jobs;
  assert.match(job.url, /^https:\/\/hud\.pytorch\.org\/pr\/pytorch\/pytorch\/200100#\d+$/);
  assert.ok(job.name.includes(' / '));
  assert.ok(job.failures.length >= 1);
  assert.equal(drci.greenLight.approved, false);
});

test('parseDrCiComment skips the active SEV header for the CI headline', () => {
  const drci = parseDrCiComment(fixture('drci-sev'));
  assert.equal(drci.headline, 'No Failures');
  assert.equal(drci.sevs.length, 1);
  assert.match(drci.sevs[0].url, /hud\.pytorch\.org/);
});

test('summarizeCi flags Dr. CI results for an older commit and falls back to the rollup', () => {
  const drci = parseDrCiComment(fixture('drci-no-failures'));
  assert.equal(summarizeCi({ drci, headSha: 'f'.repeat(40) }).stale, true);
  assert.equal(summarizeCi({ rollup: 'SUCCESS' }).state, 'green');
  assert.equal(summarizeCi({ rollup: 'PENDING' }).state, 'pending');
  assert.equal(summarizeCi({ rollup: null }).state, 'none');
  const failing = summarizeCi({ rollup: 'FAILURE', url: 'https://github.com/a/b/pull/1' });
  assert.equal(failing.state, 'failing');
  assert.equal(failing.blockingJobs[0].url, 'https://github.com/a/b/pull/1/checks');
  assert.equal(parseDrCiComment('just a comment'), null);
});

test('parseGhstackStack reads the newest-first stack and the current PR', () => {
  const stack = parseGhstackStack(fixture('ghstack-body'));
  assert.equal(stack.current, 200189);
  assert.equal(stack.numbers[0], 200218);
  assert.equal(stack.numbers.at(-1), 200167);
  assert.ok(stack.numbers.includes(200189));
  assert.equal(parseGhstackStack('Fixes #12\n\n* #13'), null);
  assert.deepEqual(
    parseGhstackStack('Stack from [ghstack](https://x) (oldest at bottom):\r\n* #3\r\n* __->__ #2\r\n\r\nBody'),
    { numbers: [3, 2], current: 2 }
  );
});

function comment(login, body, createdAt) {
  return { author: { login }, body, createdAt };
}

test('getMergebotState follows the merge lifecycle in the last comments', () => {
  const cases = [
    { comments: [], expected: null },
    {
      comments: [comment('ezyang', '@pytorchbot merge', '2026-10-09T01:00:00Z')],
      expected: { state: 'requested', at: '2026-10-09T01:00:00Z' },
    },
    {
      comments: [
        comment('ezyang', '@pytorchbot merge -i', '2026-10-09T01:00:00Z'),
        comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-09T01:01:00Z'),
      ],
      expected: { state: 'merging', at: '2026-10-09T01:01:00Z' },
    },
    {
      comments: [
        comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-09T01:01:00Z'),
        comment('pytorchmergebot', fixture('mergebot-failed-label'), '2026-10-09T01:05:00Z'),
      ],
      expected: {
        state: 'failed',
        reason: 'This PR needs a `release notes:` label',
        at: '2026-10-09T01:05:00Z',
      },
    },
    {
      comments: [comment('pytorchmergebot', fixture('mergebot-stack-merge'), '2026-10-09T01:01:00Z')],
      expected: { state: 'merging', at: '2026-10-09T01:01:00Z', underNumber: 200103 },
    },
    {
      // A revert ends the earlier merge.
      comments: [
        comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-09T01:01:00Z'),
        comment('pytorchmergebot', '@ezyang your PR has been successfully reverted.', '2026-10-09T03:00:00Z'),
      ],
      expected: null,
    },
    {
      // Merges finish within hours; a day-old "started" has no news.
      comments: [comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-07T01:00:00Z')],
      expected: null,
    },
  ];
  for (const { comments, expected } of cases) {
    assert.deepEqual(getMergebotState(comments, { nowMs: NOW }), expected);
  }
  const failed = getMergebotState(
    [comment('pytorchmergebot', fixture('mergebot-failed-job'), '2026-10-09T01:05:00Z')],
    { nowMs: NOW }
  );
  assert.match(failed.reason, /^1 jobs have failed, first few of them are: trunk \//);
  // A push after the failure retires it.
  assert.equal(
    getMergebotState(
      [comment('pytorchmergebot', fixture('mergebot-failed-job'), '2026-10-09T01:05:00Z')],
      { headCommittedAt: '2026-10-09T02:00:00Z', nowMs: NOW }
    ),
    null
  );
});

const DRCI = {
  green: fixture('drci-no-failures'),
  pending: fixture('drci-pending'),
  unrelated: fixture('drci-merge-normally-flaky'),
  failing: fixture('drci-new-failure'),
};

function stackBody(numbers, current) {
  return [
    'Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.18.0) (oldest at bottom):',
    ...numbers.map((number) => (number === current ? `* __->__ #${number}` : `* #${number}`)),
    '',
    'Body.',
  ].join('\n');
}

// GraphQL node shape, matching the ShipPullRequest fragment. Head SHAs are
// left unset so harvested Dr. CI comments never read as stale.
function prNode({
  number,
  repo = 'pytorch/pytorch',
  title = `PR ${number}`,
  state = 'OPEN',
  merged = false,
  isDraft = false,
  updatedAt = '2026-10-08T12:00:00Z',
  mergeable = 'MERGEABLE',
  reviewDecision = null,
  body = '',
  labels = ['topic: not user facing'],
  reviewRequestCount = 2,
  reviews = [],
  rollup = 'SUCCESS',
  drci = null,
  tail = [],
}) {
  return {
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    state,
    merged,
    isDraft,
    updatedAt,
    mergeable,
    reviewDecision,
    body,
    repository: { nameWithOwner: repo },
    labels: { nodes: labels.map((name) => ({ name })) },
    reviewRequests: { totalCount: reviewRequestCount },
    latestOpinionatedReviews: {
      nodes: reviews.map(([reviewState, login]) => ({ state: reviewState, author: { login } })),
    },
    commits: { nodes: [{ commit: { oid: null, committedDate: '2026-10-08T00:00:00Z', statusCheckRollup: { state: rollup } } }] },
    headComments: { nodes: drci ? [comment('pytorch-bot', drci, '2026-10-08T00:10:00Z')] : [] },
    tailComments: { nodes: tail },
  };
}

function pr(options) {
  return normalizePullRequest(prNode(options), { nowMs: NOW });
}

test('assessPullRequest lists what only the author can fix', () => {
  const cases = [
    [{ reviewDecision: 'APPROVED', drci: DRCI.green }, { ready: true, blockers: [] }],
    [{ reviewDecision: 'APPROVED', drci: DRCI.failing }, { ready: true, blockers: [] }],
    [{ drci: DRCI.failing }, { ready: false, blockers: ['ci-failing'] }],
    [{ drci: DRCI.green }, { ready: false, blockers: [] }],
    [{ reviewRequestCount: 0 }, { ready: false, blockers: ['no-reviewers'] }],
    [{ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' }, { ready: false, blockers: ['conflict'] }],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, { ready: false, blockers: ['changes-requested'] }],
    [{ reviewDecision: 'APPROVED', labels: ['ciflow/trunk'] }, { ready: false, blockers: ['needs-label'] }],
    [{ reviewDecision: 'APPROVED', labels: ['release notes: fx'] }, { ready: true, blockers: [] }],
    [{ reviewDecision: 'APPROVED', isDraft: true }, { ready: false, blockers: ['draft'] }],
    [
      { reviewDecision: 'APPROVED', labels: ['Reverted', 'topic: not user facing'] },
      { ready: true, blockers: ['reverted'] },
    ],
    [
      {
        reviewDecision: 'APPROVED',
        tail: [comment('pytorchmergebot', fixture('mergebot-failed-job'), '2026-10-09T01:00:00Z')],
      },
      { ready: true, blockers: ['merge-failed'] },
    ],
    [
      {
        reviewDecision: 'APPROVED',
        tail: [comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-09T01:00:00Z')],
      },
      { ready: false, blockers: [] },
    ],
    // Repos without required reviews report no decision; reviews decide.
    [
      { repo: 'ezyang/ghstack', reviews: [['APPROVED', 'albanD']], labels: [] },
      { ready: true, blockers: [] },
    ],
    [{ state: 'CLOSED' }, { ready: false, blockers: ['closed'] }],
  ];
  for (const [options, expected] of cases) {
    const assessment = assessPullRequest(pr({ number: 1, ...options }));
    assert.deepEqual(
      { ready: assessment.ready, blockers: assessment.blockers.map((blocker) => blocker.code) },
      expected,
      JSON.stringify(options)
    );
  }
});

function byKey(prs) {
  return new Map(prs.map((item) => [item.key, item]));
}

test('planShip needs every open PR below in the ghstack stack to be ready', () => {
  const numbers = [104, 103, 102, 101];
  const make = (number, options = {}) => pr({
    number,
    body: stackBody(numbers, number),
    reviewDecision: 'APPROVED',
    drci: DRCI.green,
    ...options,
  });
  const top = make(104);
  const awaiting = make(103, { reviewDecision: null });
  const pending = make(102, { drci: DRCI.pending });
  const merged = make(101, { state: 'MERGED', merged: true });
  const prs = [top, awaiting, pending, merged];

  assert.deepEqual(planShip(top, byKey(prs)), {
    canShip: false,
    reason: 'blocked-below',
    blockedBy: [{ number: 103, why: 'awaiting review' }],
  });

  const ready = planShip(make(103), byKey([top, make(103), pending, merged]));
  assert.equal(ready.canShip, true);
  assert.deepEqual(ready.prNumbers, [103, 102]);
  assert.equal(ready.pendingCount, 1);
  assert.equal(ready.command, '@pytorchbot merge');
  assert.equal(getShipButtonLabel(ready), 'Ship It (2 PRs)');

  // Unknown members (not fetched) hide Ship It rather than guess.
  assert.deepEqual(planShip(top, byKey([top])), {
    canShip: false,
    reason: 'unknown-below',
    missing: [103, 102, 101],
  });

  const draftBelow = make(102, { isDraft: true });
  assert.deepEqual(planShip(make(103), byKey([make(103), draftBelow, merged])).blockedBy, [
    { number: 102, why: 'draft' },
  ]);
});

test('planShip collects blocking failures across the sub-stack for acknowledgement', () => {
  const numbers = [202, 201];
  const top = pr({ number: 202, body: stackBody(numbers, 202), reviewDecision: 'APPROVED', drci: DRCI.unrelated });
  const bottom = pr({ number: 201, body: stackBody(numbers, 201), reviewDecision: 'APPROVED', drci: DRCI.failing });
  const plan = planShip(top, byKey([top, bottom]));
  assert.equal(plan.canShip, true);
  assert.equal(plan.command, '@pytorchbot merge -i');
  assert.deepEqual(plan.failures.map((failure) => [failure.prNumber, failure.section]), [
    [201, 'NEW FAILURE'],
  ]);
  assert.equal(getShipButtonLabel(plan), 'Ship It (2 PRs, 1 error)');

  const single = pr({ number: 7, reviewDecision: 'APPROVED', drci: DRCI.failing });
  assert.equal(getShipButtonLabel(planShip(single, byKey([single]))), 'Ship It (1 error)');
  const elsewhere = pr({ number: 8, repo: 'pytorch/test-infra', reviewDecision: 'APPROVED' });
  assert.deepEqual(planShip(elsewhere, byKey([elsewhere])), { canShip: false, reason: 'no-mergebot' });
});

test('groupIntoStacks orders members newest-first and leaves singles alone', () => {
  const numbers = [303, 302, 301];
  const prs = [
    pr({ number: 301, body: stackBody(numbers, 301) }),
    pr({ number: 9 }),
    pr({ number: 303, body: stackBody(numbers, 303) }),
    pr({ number: 302, body: stackBody(numbers, 302) }),
  ];
  assert.deepEqual(
    groupIntoStacks(prs).map((group) => group.map((item) => item.number)),
    [[303, 302, 301], [9]]
  );
});

test('getMissingStackNumbers batches unseen stack members per repo', () => {
  const prs = [
    pr({ number: 402, body: stackBody([403, 402, 401], 402) }),
    pr({ number: 5, repo: 'ezyang/ghstack', body: stackBody([6, 5], 5) }),
  ];
  assert.deepEqual(getMissingStackNumbers(prs), [
    { repo: 'pytorch/pytorch', numbers: [403, 401] },
    { repo: 'ezyang/ghstack', numbers: [6] },
  ]);
  const query = buildStackLookupGraphql('pytorch/pytorch', [403, 401]);
  assert.match(query, /repository\(owner: "pytorch", name: "pytorch"\)/);
  assert.match(query, /pr403: pullRequest\(number: 403\) \{ \.\.\.ShipPullRequest \}/);
});

test('buildShipSearchQuery asks for recent non-draft PRs by the viewer', () => {
  assert.equal(
    buildShipSearchQuery(Date.parse('2026-10-09T00:00:00Z')),
    'is:pr is:open author:@me archived:false draft:false updated:>=2026-07-11'
  );
});

test('resolveStackMerges drops a stack member merge once the top PR stopped', () => {
  const started = comment('pytorchmergebot', fixture('mergebot-stack-merge'), '2026-10-09T01:01:00Z');
  const member = pr({ number: 200167, reviewDecision: 'APPROVED', tail: [started] });
  const failedTop = pr({
    number: 200103,
    reviewDecision: 'APPROVED',
    tail: [comment('pytorchmergebot', fixture('mergebot-failed-job'), '2026-10-09T02:00:00Z')],
  });
  const mergingTop = pr({
    number: 200103,
    reviewDecision: 'APPROVED',
    tail: [comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-09T01:00:00Z')],
  });
  assert.equal(resolveStackMerges([member, failedTop])[0].mergebot, null);
  assert.equal(resolveStackMerges([member, mergingTop])[0].mergebot.state, 'merging');
  assert.equal(resolveStackMerges([member])[0].mergebot.state, 'merging');
});

test('applyPendingMerges shows a just-posted merge until GitHub has newer news', () => {
  const plain = pr({ number: 1, reviewDecision: 'APPROVED' });
  const [patched] = applyPendingMerges([plain], { [plain.key]: NOW });
  assert.equal(patched.mergebot.state, 'requested');
  const failedLater = pr({
    number: 1,
    reviewDecision: 'APPROVED',
    tail: [comment('pytorchmergebot', fixture('mergebot-failed-job'), new Date(NOW + 60000).toISOString())],
  });
  assert.equal(applyPendingMerges([failedLater], { [plain.key]: NOW })[0].mergebot.state, 'failed');
});

test('buildShipSections splits stacks into action needed and review requested', () => {
  const numbers = [503, 502, 501];
  const prs = [
    // Stack: bottom approved and green, middle awaiting review, top approved.
    pr({ number: 503, body: stackBody(numbers, 503), reviewDecision: 'APPROVED', drci: DRCI.green, updatedAt: '2026-10-08T10:00:00Z' }),
    pr({ number: 502, body: stackBody(numbers, 502), drci: DRCI.green, updatedAt: '2026-10-08T09:00:00Z' }),
    pr({ number: 501, body: stackBody(numbers, 501), reviewDecision: 'APPROVED', drci: DRCI.green, updatedAt: '2026-10-08T08:00:00Z' }),
    // Waiting on reviewers only.
    pr({ number: 600, drci: DRCI.pending, updatedAt: '2026-10-08T11:00:00Z' }),
    // Merging: nothing to do.
    pr({
      number: 700,
      reviewDecision: 'APPROVED',
      tail: [comment('pytorchmergebot', fixture('mergebot-started'), '2026-10-09T01:00:00Z')],
      updatedAt: '2026-10-08T07:00:00Z',
    }),
    // Changes requested.
    pr({ number: 800, reviewDecision: 'CHANGES_REQUESTED', updatedAt: '2026-10-08T06:00:00Z' }),
  ];
  const sections = buildShipSections(prs);
  assert.deepEqual(
    sections.action.map((group) => group.rows.map((row) => [row.pr.number, row.needsAction])),
    [
      [[503, false], [502, false], [501, true]],
      [[800, true]],
    ]
  );
  assert.equal(sections.action[0].isStack, true);
  assert.equal(sections.action[0].rows[0].waiting, 'Approved; waiting on #502 (awaiting review)');
  assert.equal(sections.action[0].rows[2].plan.canShip, true);
  assert.deepEqual(
    sections.review.map((group) => group.rows.map((row) => [row.pr.number, row.waiting])),
    [[[600, 'Awaiting review']], [[700, 'Merging']]]
  );
  assert.equal(sections.actionCount, 2);
  assert.equal(sections.reviewCount, 4);
});

test('buildShipSections hides merged stack members but keeps them for planning', () => {
  const numbers = [902, 901];
  const sections = buildShipSections([
    pr({ number: 902, body: stackBody(numbers, 902), reviewDecision: 'APPROVED', drci: DRCI.green }),
    pr({ number: 901, body: stackBody(numbers, 901), state: 'MERGED', merged: true }),
  ]);
  assert.deepEqual(sections.action.map((group) => group.rows.map((row) => row.pr.number)), [[902]]);
  assert.equal(sections.action[0].isStack, true);
  assert.equal(sections.action[0].rows[0].plan.canShip, true);
});
