// Pure done-queue state machine: counters, bounded-concurrency drain loop,
// and progress/final-status message selection for mark-done batches.
// Browser code passes the per-item I/O callback in; Node tests import this file.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxDoneQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DONE_CONCURRENCY = 8;

    function createQueue() {
        return {
            pending: [],           // Array of { notifId, ... } work items
            inFlight: new Map(),   // notifId -> promise
            totalQueued: 0,        // Total queued in current session (resets when fully drained)
            completed: 0,
            failed: 0,
            skipped: 0,
            suppressProgress: false,
            suppressStatusProgress: false,
            failedResults: [],     // { id, error }
            successfulIds: [],
            active: false,
            _drainResolvers: [],   // Resolvers for callers awaiting an already-running drain
        };
    }

    function resetCounters(queue) {
        queue.totalQueued = 0;
        queue.completed = 0;
        queue.failed = 0;
        queue.skipped = 0;
        queue.suppressProgress = false;
        queue.suppressStatusProgress = false;
        queue.failedResults = [];
        queue.successfulIds = [];
    }

    function enqueueItems(queue, items) {
        if (!queue.active) {
            // New session - reset counters
            resetCounters(queue);
        }
        items.forEach((item) => queue.pending.push(item));
        queue.totalQueued += items.length;
    }

    function resetForBatch(queue, total) {
        queue.pending = [];
        queue.inFlight.clear();
        resetCounters(queue);
        queue.totalQueued = total;
        queue.suppressStatusProgress = true;
        queue.active = true;
    }

    function recordSuccess(queue, notifId) {
        queue.completed += 1;
        queue.successfulIds.push(notifId);
    }

    function recordFailure(queue, notifId, error) {
        queue.failed += 1;
        queue.failedResults.push({ id: notifId, error });
    }

    function recordSkipped(queue) {
        queue.skipped += 1;
    }

    function requeueItem(queue, item) {
        queue.pending.push(item);
    }

    function recordBatchSuccess(queue, notifIds) {
        queue.completed = notifIds.length;
        queue.successfulIds = notifIds.slice();
    }

    function recordBatchFailure(queue, notifIds, error) {
        queue.failed = notifIds.length;
        queue.failedResults = notifIds.map((id) => ({ id, error }));
    }

    function getProcessedCount(queue) {
        return queue.completed + queue.failed + queue.skipped;
    }

    function getProgressStatus(queue) {
        // For single-item operations, skip intermediate progress to avoid flashing
        if (queue.totalQueued === 1 || queue.suppressStatusProgress) {
            return null;
        }
        const processed = getProcessedCount(queue);
        const remaining = queue.totalQueued - processed;
        return {
            message: `Done ${processed}/${queue.totalQueued} (${remaining} pending)`,
            type: 'success',
            autoDismiss: false,
        };
    }

    function getFinalStatus(queue) {
        const total = queue.totalQueued;
        const succeeded = queue.successfulIds.length;
        const failed = queue.failedResults.length;
        const skipped = queue.skipped;

        if (total === 1 && failed === 0 && skipped === 0) {
            return { message: 'Marked as done', type: 'success', autoDismiss: true };
        }

        if (failed === 0 && skipped === 0) {
            return {
                message: `Done ${succeeded}/${total} (0 pending)`,
                type: 'success',
                autoDismiss: true,
            };
        }

        if (failed === 0 && skipped > 0) {
            if (succeeded > 0) {
                return {
                    message: `Done ${succeeded}/${total} (${skipped} had new comments)`,
                    type: 'info',
                    autoDismiss: true,
                };
            }
            return {
                message: `Skipped ${skipped}: new comments detected`,
                type: 'info',
                autoDismiss: true,
            };
        }

        const firstError = (queue.failedResults[0] && queue.failedResults[0].error) || 'Unknown error';

        if (succeeded === 0) {
            const skippedSuffix = skipped > 0 ? ` (${skipped} had new comments)` : '';
            return {
                message: `Failed to mark notifications: ${firstError}${skippedSuffix}`,
                type: 'error',
                autoDismiss: false,
            };
        }

        // Partial failure
        const skippedSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
        return {
            message: `${succeeded} done, ${failed} failed${skippedSuffix}: ${firstError}`,
            type: 'error',
            autoDismiss: false,
        };
    }

    function isBatchActive(queue) {
        return Boolean(queue && queue.active && queue.totalQueued > 1);
    }

    function getProgressBarState(queue) {
        if (!isBatchActive(queue) || queue.suppressProgress) {
            return null;
        }
        const processed = getProcessedCount(queue);
        return {
            processed,
            total: queue.totalQueued,
            percent: (processed / queue.totalQueued) * 100,
            message: `Marking ${processed} of ${queue.totalQueued}...`,
        };
    }

    // Drain the queue with bounded concurrency. processItem(item) performs the
    // I/O for one item and records its outcome on the queue; it must not reject.
    // If the queue is already draining, returns a promise that resolves when the
    // running drain (including newly enqueued items) completes.
    async function processQueue(queue, processItem, hooks = {}) {
        const notify = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};

        if (queue.active) {
            return new Promise((resolve) => {
                queue._drainResolvers.push(resolve);
            });
        }

        queue.active = true;
        notify(queue);

        try {
            while (queue.pending.length > 0 || queue.inFlight.size > 0) {
                // Fill up to DONE_CONCURRENCY slots
                while (queue.pending.length > 0 && queue.inFlight.size < DONE_CONCURRENCY) {
                    const item = queue.pending.shift();
                    const promise = Promise.resolve(processItem(item)).then(() => {
                        queue.inFlight.delete(item.notifId);
                        notify(queue);
                    });
                    queue.inFlight.set(item.notifId, promise);
                }

                if (queue.inFlight.size > 0) {
                    await Promise.race(queue.inFlight.values());
                }
            }
        } finally {
            queue.active = false;
            const resolvers = queue._drainResolvers.splice(0);
            resolvers.forEach((resolve) => resolve());
        }
    }

    return {
        DONE_CONCURRENCY,
        createQueue,
        enqueueItems,
        getFinalStatus,
        getProcessedCount,
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
    };
});
