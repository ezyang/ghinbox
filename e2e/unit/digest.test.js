const assert = require('node:assert/strict');
const test = require('node:test');
const {
  digestWhyById,
  formatDigestStatus,
  formatNothingUnusual,
  formatLlmUsage,
  isClientBusy,
  replyDemotionsById,
  reviewVerdictsByPr,
  describeReviewVerdict,
  selectVisibleDigest,
  shouldApplyBackgroundSnapshot,
  shouldShowDigestPanel,
} = require('../../ghinbox/webapp/notifications-digest.js');

const digest = {
  status: 'idle',
  composed_at: '2026-09-23T11:50:00Z',
  pending_count: 0,
  queue_count: 0,
  counts: { feed_count: 40, direct_count: 3, broadcast_count: 30 },
  look_at: [
    { id: 'a', title: 'A', why: 'ping' },
    { id: 'done', title: 'Done', why: 'gone' },
  ],
  composed_item_count: 40,
  unusual: [
    { text: 'Three reports of one guard bug.', examples: [{ id: 'b' }, { id: 'done' }] },
    { text: '', examples: [] },
  ],
};

test('selectVisibleDigest drops look-at items no longer live, keeps unusual examples', () => {
  const visible = selectVisibleDigest(digest, new Set(['a', 'b']));
  assert.deepEqual(visible.lookAt.map((item) => item.id), ['a']);
  // Unusual examples are often items the server already auto-marked done.
  assert.deepEqual(visible.unusual, [
    { text: 'Three reports of one guard bug.', examples: [{ id: 'b' }, { id: 'done' }] },
  ]);
  assert.deepEqual(selectVisibleDigest(null, []), { lookAt: [], unusual: [] });
});

test('formatNothingUnusual reports a normal day only once a digest composed', () => {
  assert.equal(formatNothingUnusual(digest), 'Nothing out of the ordinary in 40 items.');
  assert.equal(
    formatNothingUnusual({ ...digest, composed_item_count: 1 }),
    'Nothing out of the ordinary in 1 item.'
  );
  assert.equal(formatNothingUnusual({ ...digest, composed_item_count: 0 }), 'Nothing out of the ordinary.');
  assert.equal(formatNothingUnusual({ status: 'idle', composed_at: null }), '');
  assert.equal(formatNothingUnusual(null), '');
});

test('shouldShowDigestPanel decision table', () => {
  const visible = selectVisibleDigest(digest, ['a', 'b']);
  const empty = { lookAt: [], unusual: [] };
  const cases = [
    ['Feed with a composed digest', { view: 'issues', digest, visible }, true],
    ['other views hide it', { view: 'others-prs', digest, visible }, false],
    ['no digest loaded', { view: 'issues', digest: null, visible: empty }, false],
    ['composed digest, nothing left to look at', { view: 'issues', digest, visible: empty }, true],
    [
      'never composed, nothing queued',
      { view: 'issues', digest: { status: 'idle' }, visible: empty },
      false,
    ],
    [
      'never composed, items queued',
      { view: 'issues', digest: { status: 'idle', queue_count: 4 }, visible: empty },
      true,
    ],
    [
      'digest disabled for the profile',
      { view: 'issues', digest: { ...digest, enabled: false }, visible },
      false,
    ],
    [
      'first digest still running',
      { view: 'issues', digest: { status: 'running' }, visible: empty },
      true,
    ],
    [
      'errors stay visible',
      { view: 'issues', digest: { status: 'error', error: 'x' }, visible: empty },
      true,
    ],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(shouldShowDigestPanel(input), expected, name);
  }
});

test('digestWhyById maps surfaced items to their reason', () => {
  assert.deepEqual(
    [...digestWhyById(digest)],
    [
      ['a', 'ping'],
      ['done', 'gone'],
    ]
  );
  assert.equal(digestWhyById(null).size, 0);
});

test('formatDigestStatus summarizes look-at, queue, and freshness', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const visible = selectVisibleDigest(digest, ['a', 'b']);
  assert.equal(formatDigestStatus(digest, visible, now), '1 worth a look · digest from 10m ago');
  assert.equal(
    formatDigestStatus(
      { ...digest, queue_count: 12, composed_at: '2026-09-23T07:00:00Z' },
      visible,
      now
    ),
    '1 worth a look · 12 marked done, queued for the next digest · digest from 5h ago'
  );
  assert.equal(
    formatDigestStatus({ ...digest, status: 'running', pending_count: 5 }, visible, now),
    '1 worth a look · digest from 10m ago · digesting 5 new items…'
  );
  assert.equal(
    formatDigestStatus({ status: 'error', error: 'boom' }, visible, now),
    '1 worth a look · last update failed: boom'
  );
  assert.equal(
    formatDigestStatus(
      {
        ...digest,
        auto_done: { attempted: 3, done: 0, error: 'No GitHub token configured' },
      },
      { lookAt: [], unusual: [] },
      now
    ),
    'digest from 10m ago · auto-done failed: No GitHub token configured'
  );
  assert.equal(
    formatDigestStatus(
      {
        ...digest,
        auto_done: { attempted: 0, done: 0, trash: { attempted: 2, done: 0, error: 'HTTP 500' } },
      },
      { lookAt: [], unusual: [] },
      now
    ),
    'digest from 10m ago · trash sweep failed: HTTP 500'
  );
});

test('formatLlmUsage reports calls, tokens, cost, and failures', () => {
  assert.equal(formatLlmUsage(null), '');
  assert.equal(formatLlmUsage({ window_hours: 24, total: { calls: 0 } }), '');
  assert.equal(
    formatLlmUsage({
      window_hours: 24,
      triage: { calls: 11 },
      compose: { calls: 1 },
      total: {
        calls: 12,
        errors: 1,
        input_tokens: 184_000,
        output_tokens: 9_500,
        cost_usd: 1.234,
      },
    }),
    'LLM, last 24h: 12 calls (11 triage, 1 compose) · 184k in / 10k out tokens · ' +
      '$1.23 · 1 failed'
  );
  // CLIs that report no usage fall back to prompt size.
  assert.equal(
    formatLlmUsage({
      window_hours: 24,
      triage: { calls: 2 },
      total: { calls: 2, prompt_chars: 1_500_000 },
    }),
    'LLM, last 24h: 2 calls (2 triage) · 1.5M prompt chars'
  );
});

test('shouldApplyBackgroundSnapshot decision table', () => {
  const snapshot = { notifications: [], synced_at: '2026-09-23T12:10:00Z' };
  const sync = { status: 'success', started_at: '2026-09-23T12:05:00Z' };
  const base = { snapshot, sync, localSyncedAt: '2026-09-23T11:55:00Z' };
  const cases = [
    ['newer snapshot, no local mutations', {}, true],
    ['same snapshot already applied', { localSyncedAt: snapshot.synced_at }, false],
    ['no snapshot', { snapshot: null }, false],
    ['client busy', { busy: true }, false],
    ['sync still running', { sync: { status: 'running' } }, false],
    [
      'sync started after the last mark-done',
      { lastLocalMutationAt: Date.parse('2026-09-23T12:00:00Z') },
      true,
    ],
    [
      'sync started before the last mark-done would resurrect it',
      { lastLocalMutationAt: Date.parse('2026-09-23T12:07:00Z') },
      false,
    ],
  ];
  for (const [name, overrides, expected] of cases) {
    assert.equal(
      shouldApplyBackgroundSnapshot({ ...base, ...overrides }),
      expected,
      name
    );
  }
});

test('isClientBusy flags in-flight user work', () => {
  assert.equal(isClientBusy({}), false);
  assert.equal(isClientBusy({ doneQueueActive: true }), true);
  assert.equal(isClientBusy({ selectionCount: 2 }), true);
  assert.equal(isClientBusy({ loading: true }), true);
});

test('replyDemotionsById keys FYI verdicts by id and the judged updated_at', () => {
  const demotions = replyDemotionsById({
    reply_demotions: [
      { id: 'a', updated_at: '2026-09-23T10:00:00Z', why: 'thanks only' },
      { id: 'b' },
    ],
  });
  assert.deepEqual([...demotions], [
    ['a', { updated_at: '2026-09-23T10:00:00Z', why: 'thanks only' }],
  ]);
  assert.equal(replyDemotionsById(null).size, 0);
});

test('reviewVerdictsByPr keys verdicts by PR and describes them for Reviews rows', () => {
  const verdicts = reviewVerdictsByPr({
    review_assessments: [
      { pr: 'PyTorch/PyTorch#1', verdict: 'look', buckets: ['context', 'bogus'], why: 'symbolic shapes' },
      { pr: 'pytorch/pytorch#2', verdict: 'skip', buckets: [], why: '' },
      { pr: 'pytorch/pytorch#3' },
    ],
  });
  assert.deepEqual([...verdicts.keys()], ['pytorch/pytorch#1', 'pytorch/pytorch#2']);
  assert.deepEqual(describeReviewVerdict(verdicts.get('pytorch/pytorch#1')), {
    verdict: 'look',
    chips: [{ bucket: 'context', label: 'You know this code' }],
    why: 'symbolic shapes',
  });
  assert.deepEqual(describeReviewVerdict(verdicts.get('pytorch/pytorch#2')), {
    verdict: 'skip',
    chips: [],
    why: 'Skip',
  });
  assert.equal(describeReviewVerdict(null), null);
  assert.equal(reviewVerdictsByPr(null).size, 0);
});

test('formatDigestStatus reports demoted replies and reply check failures', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const visible = selectVisibleDigest(digest, []);
  assert.equal(
    formatDigestStatus(
      {
        ...digest,
        reply_demotions: [{ id: 'x', updated_at: 'u' }, { id: 'y', updated_at: 'u' }],
        reply_check_error: 'muse down',
      },
      visible,
      now
    ),
    '2 replies judged FYI, moved to Feed · digest from 10m ago · reply check failed: muse down'
  );
});
