// Pure decisions for the background feed digest and background snapshot pulls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxDigest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    const DIGEST_POLL_WHILE_RUNNING_MS = 15 * 1000;

    function toMs(value) {
        if (!value) {
            return null;
        }
        const ms = typeof value === 'number' ? value : Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }

    // The server digest lags the client: items marked done here stay in the
    // server snapshot until the next sync. Show only what is still live.
    function selectVisibleDigest(digest, liveIds) {
        const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
        const lookAt = (digest?.look_at || []).filter((item) => live.has(String(item.id)));
        const vibe = (digest?.vibe || [])
            .filter((theme) => theme && theme.text)
            .map((theme) => ({
                title: theme.title || '',
                text: theme.text,
                examples: (theme.examples || []).filter((example) =>
                    live.has(String(example.id))
                ),
            }));
        return { lookAt, vibe };
    }

    function shouldShowDigestPanel({ view, digest, visible }) {
        if (view !== 'issues' || !digest) {
            return false;
        }
        if (digest.status === 'running' || digest.status === 'error') {
            return true;
        }
        return Boolean(
            digest.composed_at &&
            (visible.lookAt.length > 0 || visible.vibe.length > 0)
        );
    }

    function formatDigestStatus(digest, visible, now = Date.now()) {
        if (!digest) {
            return '';
        }
        const parts = [];
        const composedMs = toMs(digest.composed_at);
        if (composedMs !== null) {
            const minutes = Math.max(0, Math.round((now - composedMs) / 60000));
            parts.push(
                minutes < 1 ? 'updated just now' :
                minutes < 60 ? `updated ${minutes}m ago` :
                `updated ${Math.round(minutes / 60)}h ago`
            );
        }
        const counts = digest.counts || {};
        if (counts.feed_count) {
            parts.push(
                `${visible.lookAt.length} of ${counts.feed_count} worth a look` +
                ` (${counts.direct_count || 0} direct, ` +
                `${counts.broadcast_count || 0} broadcast cc)`
            );
        }
        if (digest.status === 'running') {
            parts.push(
                digest.pending_count
                    ? `digesting ${digest.pending_count} new items…`
                    : 'updating…'
            );
        } else if (digest.status === 'error' && digest.error) {
            parts.push(`last update failed: ${digest.error}`);
        } else if (digest.pending_count) {
            parts.push(`${digest.pending_count} not yet digested`);
        }
        return parts.join(' · ');
    }

    // Decide whether a background pull may replace the client's list with the
    // server snapshot. Never disturb in-flight user work, and never apply a
    // sync that started before the user's last local mutation: its data can
    // predate a mark-done and would resurrect the item.
    function shouldApplyBackgroundSnapshot({
        snapshot = null,
        sync = null,
        localSyncedAt = null,
        lastLocalMutationAt = null,
        busy = false,
    } = {}) {
        if (busy || !snapshot || !Array.isArray(snapshot.notifications)) {
            return false;
        }
        if (!snapshot.synced_at || snapshot.synced_at === localSyncedAt) {
            return false;
        }
        if (sync?.status === 'running') {
            return false;
        }
        const mutationMs = toMs(lastLocalMutationAt);
        if (mutationMs === null) {
            return true;
        }
        const startedMs = toMs(sync?.started_at) ?? toMs(snapshot.synced_at);
        return startedMs !== null && startedMs > mutationMs;
    }

    function isClientBusy({
        loading = false,
        doneQueueActive = false,
        undoInProgress = false,
        unsubscribeInProgress = false,
        reviewsReloading = false,
        selectionCount = 0,
    } = {}) {
        return Boolean(
            loading ||
            doneQueueActive ||
            undoInProgress ||
            unsubscribeInProgress ||
            reviewsReloading ||
            selectionCount > 0
        );
    }

    return {
        BACKGROUND_REFRESH_INTERVAL_MS,
        DIGEST_POLL_WHILE_RUNNING_MS,
        selectVisibleDigest,
        shouldShowDigestPanel,
        formatDigestStatus,
        shouldApplyBackgroundSnapshot,
        isClientBusy,
    };
});
