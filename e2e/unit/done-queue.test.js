const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DONE_CONCURRENCY,
  createQueue,
  enqueueItems,
  getFinalStatus,
  getProgressBarState,
  getProgressStatus,
  isBatchActive,
  processQueue,
  recordBatchFailure,
  recordBatchSuccess,
  recordFailure,
  recordSkipped,
  recordSuccess,
  requeueItem,
  resetForBatch,
} = require('../../ghinbox/webapp/notifications-done-queue.js');

function item(id) {
  return { notifId: id };
}

test('enqueueItems resets counters when queue is idle', () => {
  const queue = createQueue();
  queue.completed = 3;
  queue.failed = 2;
  queue.skipped = 1;
  queue.suppressProgress = true;
  queue.failedResults = [{ id: 'x', error: 'old' }];
  queue.successfulIds = ['x'];

  enqueueItems(queue, [item('a'), item('b')]);

  assert.equal(queue.totalQueued, 2);
  assert.equal(queue.completed, 0);
  assert.equal(queue.failed, 0);
  assert.equal(queue.skipped, 0);
  assert.equal(queue.suppressProgress, false);
  assert.deepEqual(queue.failedResults, []);
  assert.deepEqual(queue.successfulIds, []);
  assert.equal(queue.pending.length, 2);
});

test('enqueueItems accumulates while a drain is active', () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a')]);
  queue.active = true;
  recordSuccess(queue, 'a');
  enqueueItems(queue, [item('b'), item('c')]);

  assert.equal(queue.totalQueued, 3);
  assert.equal(queue.completed, 1);
  assert.equal(queue.pending.length, 3);
});

test('resetForBatch clears pending work and suppresses progress', () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a')]);
  resetForBatch(queue, 5);

  assert.equal(queue.pending.length, 0);
  assert.equal(queue.totalQueued, 5);
  assert.equal(queue.suppressProgress, true);
  assert.equal(queue.active, true);
});

test('record helpers update counters and result lists', () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a'), item('b'), item('c')]);

  recordSuccess(queue, 'a');
  recordFailure(queue, 'b', 'boom');
  recordSkipped(queue);

  assert.deepEqual(queue.successfulIds, ['a']);
  assert.deepEqual(queue.failedResults, [{ id: 'b', error: 'boom' }]);
  assert.equal(queue.skipped, 1);
});

test('recordBatchSuccess and recordBatchFailure cover whole batches', () => {
  const success = createQueue();
  resetForBatch(success, 2);
  recordBatchSuccess(success, ['a', 'b']);
  assert.equal(success.completed, 2);
  assert.deepEqual(success.successfulIds, ['a', 'b']);

  const failure = createQueue();
  resetForBatch(failure, 2);
  recordBatchFailure(failure, ['a', 'b'], 'HTTP 500');
  assert.equal(failure.failed, 2);
  assert.deepEqual(failure.failedResults, [
    { id: 'a', error: 'HTTP 500' },
    { id: 'b', error: 'HTTP 500' },
  ]);
});

test('getProgressStatus suppresses single-item and suppressed batches', () => {
  const single = createQueue();
  enqueueItems(single, [item('a')]);
  assert.equal(getProgressStatus(single), null);

  const suppressed = createQueue();
  resetForBatch(suppressed, 3);
  assert.equal(getProgressStatus(suppressed), null);
});

test('getProgressStatus reports processed and remaining counts', () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a'), item('b'), item('c')]);
  recordSuccess(queue, 'a');
  recordSkipped(queue);

  assert.deepEqual(getProgressStatus(queue), {
    message: 'Done 2/3 (1 pending)',
    type: 'success',
    autoDismiss: false,
  });
});

const FINAL_STATUS_CASES = [
  {
    name: 'single success',
    total: 1,
    successes: ['a'],
    failures: [],
    skipped: 0,
    expected: { message: 'Marked as done', type: 'success', autoDismiss: true },
  },
  {
    name: 'all succeeded',
    total: 3,
    successes: ['a', 'b', 'c'],
    failures: [],
    skipped: 0,
    expected: { message: 'Done 3/3 (0 pending)', type: 'success', autoDismiss: true },
  },
  {
    name: 'some skipped, rest succeeded',
    total: 3,
    successes: ['a', 'b'],
    failures: [],
    skipped: 1,
    expected: {
      message: 'Done 2/3 (1 had new comments)',
      type: 'info',
      autoDismiss: true,
    },
  },
  {
    name: 'all skipped',
    total: 2,
    successes: [],
    failures: [],
    skipped: 2,
    expected: {
      message: 'Skipped 2: new comments detected',
      type: 'info',
      autoDismiss: true,
    },
  },
  {
    name: 'all failed',
    total: 2,
    successes: [],
    failures: [{ id: 'a', error: 'HTTP 500' }, { id: 'b', error: 'HTTP 502' }],
    skipped: 0,
    expected: {
      message: 'Failed to mark notifications: HTTP 500',
      type: 'error',
      autoDismiss: false,
    },
  },
  {
    name: 'all failed with skips',
    total: 3,
    successes: [],
    failures: [{ id: 'a', error: 'HTTP 500' }],
    skipped: 2,
    expected: {
      message: 'Failed to mark notifications: HTTP 500 (2 had new comments)',
      type: 'error',
      autoDismiss: false,
    },
  },
  {
    name: 'partial failure',
    total: 3,
    successes: ['a'],
    failures: [{ id: 'b', error: 'HTTP 500' }],
    skipped: 1,
    expected: {
      message: '1 done, 1 failed, 1 skipped: HTTP 500',
      type: 'error',
      autoDismiss: false,
    },
  },
];

for (const c of FINAL_STATUS_CASES) {
  test(`getFinalStatus: ${c.name}`, () => {
    const queue = createQueue();
    queue.totalQueued = c.total;
    queue.successfulIds = c.successes;
    queue.failedResults = c.failures;
    queue.skipped = c.skipped;
    assert.deepEqual(getFinalStatus(queue), c.expected);
  });
}

test('isBatchActive requires active queue with more than one item', () => {
  assert.equal(isBatchActive(null), false);
  assert.equal(isBatchActive(undefined), false);

  const queue = createQueue();
  assert.equal(isBatchActive(queue), false);

  resetForBatch(queue, 1);
  assert.equal(isBatchActive(queue), false);

  resetForBatch(queue, 2);
  assert.equal(isBatchActive(queue), true);

  queue.active = false;
  assert.equal(isBatchActive(queue), false);
});

test('getProgressBarState hides suppressed batches and reports percent', () => {
  const queue = createQueue();
  resetForBatch(queue, 4);
  assert.equal(getProgressBarState(queue), null);

  queue.suppressProgress = false;
  recordSuccess(queue, 'a');
  assert.deepEqual(getProgressBarState(queue), {
    processed: 1,
    total: 4,
    percent: 25,
    message: 'Marking 1 of 4...',
  });
});

test('processQueue drains all items and records outcomes', async () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a'), item('b'), item('c')]);

  const processed = [];
  await processQueue(queue, async (workItem) => {
    processed.push(workItem.notifId);
    recordSuccess(queue, workItem.notifId);
  });

  assert.deepEqual(processed.sort(), ['a', 'b', 'c']);
  assert.equal(queue.active, false);
  assert.equal(queue.pending.length, 0);
  assert.equal(queue.inFlight.size, 0);
  assert.equal(queue.completed, 3);
});

test('processQueue caps concurrency at DONE_CONCURRENCY', async () => {
  const queue = createQueue();
  enqueueItems(
    queue,
    Array.from({ length: DONE_CONCURRENCY * 2 + 3 }, (_, i) => item(`n${i}`))
  );

  let inFlight = 0;
  let maxInFlight = 0;
  await processQueue(queue, async (workItem) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    recordSuccess(queue, workItem.notifId);
  });

  assert.equal(maxInFlight, DONE_CONCURRENCY);
  assert.equal(queue.completed, DONE_CONCURRENCY * 2 + 3);
});

test('processQueue picks up items enqueued mid-drain and resolves waiters', async () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a')]);

  const processed = [];
  let secondDrain = null;
  const firstDrain = processQueue(queue, async (workItem) => {
    processed.push(workItem.notifId);
    if (workItem.notifId === 'a') {
      enqueueItems(queue, [item('b')]);
      // A second processQueue call while active must wait for the same drain.
      secondDrain = processQueue(queue, () => {
        throw new Error('inner processor should never run');
      });
    }
    recordSuccess(queue, workItem.notifId);
  });

  await firstDrain;
  await secondDrain;
  assert.deepEqual(processed, ['a', 'b']);
  assert.equal(queue.completed, 2);
  assert.equal(queue.active, false);
});

test('processQueue calls onProgress per completed item plus once at start', async () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a'), item('b')]);

  let calls = 0;
  await processQueue(
    queue,
    async (workItem) => recordSuccess(queue, workItem.notifId),
    { onProgress: () => { calls += 1; } }
  );

  assert.equal(calls, 3);
});

test('requeueItem returns an item to pending for retry', async () => {
  const queue = createQueue();
  enqueueItems(queue, [item('a')]);

  let attempts = 0;
  await processQueue(queue, async (workItem) => {
    attempts += 1;
    if (attempts === 1) {
      requeueItem(queue, workItem);
      return;
    }
    recordSuccess(queue, workItem.notifId);
  });

  assert.equal(attempts, 2);
  assert.deepEqual(queue.successfulIds, ['a']);
});
