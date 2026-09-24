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
    // server snapshot until the next sync, so "Look at these" (surfaced items,
    // annotated in the list itself) shows only what is still live. Vibe
    // examples are context, not a to-do list: the server marks most digested
    // items done itself, so they are kept as-is.
    function selectVisibleDigest(digest, liveIds) {
        const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
        const lookAt = (digest?.look_at || []).filter((item) => live.has(String(item.id)));
        const vibe = (digest?.vibe || [])
            .filter((theme) => theme && theme.text)
            .map((theme) => ({
                title: theme.title || '',
                text: theme.text,
                examples: theme.examples || [],
            }));
        return { lookAt, vibe };
    }

    // Why each surfaced ("worth a look") item matters, for its list row.
    function digestWhyById(digest) {
        const whyById = new Map();
        for (const item of digest?.look_at || []) {
            if (item && item.id && item.why) {
                whyById.set(String(item.id), item.why);
            }
        }
        return whyById;
    }

    function shouldShowDigestPanel({ view, digest, visible }) {
        if (view !== 'issues' || !digest || digest.enabled === false) {
            return false;
        }
        if (digest.status === 'running' || digest.status === 'error') {
            return true;
        }
        return Boolean(
            digest.composed_at ||
            digest.queue_count > 0 ||
            visible.lookAt.length > 0 ||
            visible.vibe.length > 0
        );
    }

    function formatAge(ms, now) {
        const minutes = Math.max(0, Math.round((now - ms) / 60000));
        return minutes < 1 ? 'just now' :
            minutes < 60 ? `${minutes}m ago` :
            `${Math.round(minutes / 60)}h ago`;
    }

    function formatDigestStatus(digest, visible, now = Date.now()) {
        if (!digest) {
            return '';
        }
        const parts = [];
        if (visible.lookAt.length) {
            parts.push(`${visible.lookAt.length} worth a look`);
        }
        if (digest.queue_count) {
            parts.push(`${digest.queue_count} marked done, queued for the next digest`);
        }
        const composedMs = toMs(digest.composed_at);
        if (composedMs !== null) {
            parts.push(`digest from ${formatAge(composedMs, now)}`);
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
        if (digest.auto_done?.error) {
            parts.push(`auto-done failed: ${digest.auto_done.error}`);
        }
        return parts.join(' · ');
    }

    function formatTokens(count) {
        if (count >= 1e6) {
            return `${(count / 1e6).toFixed(1)}M`;
        }
        if (count >= 1e3) {
            return `${Math.round(count / 1e3)}k`;
        }
        return String(count);
    }

    // LLM spend over the server's usage window, for tuning triage/compose.
    function formatLlmUsage(usage) {
        const total = usage?.total;
        if (!total || !total.calls) {
            return '';
        }
        const kinds = ['triage', 'compose']
            .filter((kind) => usage[kind]?.calls)
            .map((kind) => `${usage[kind].calls} ${kind}`);
        const parts = [
            `LLM, last ${usage.window_hours || 24}h: ${total.calls} calls (${kinds.join(', ')})`,
        ];
        if (total.input_tokens || total.output_tokens) {
            parts.push(
                `${formatTokens(total.input_tokens || 0)} in / ` +
                `${formatTokens(total.output_tokens || 0)} out tokens`
            );
        } else {
            parts.push(`${formatTokens(total.prompt_chars || 0)} prompt chars`);
        }
        if (total.cost_usd) {
            parts.push(`$${total.cost_usd.toFixed(2)}`);
        }
        if (total.errors) {
            parts.push(`${total.errors} failed`);
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
        digestWhyById,
        shouldShowDigestPanel,
        formatDigestStatus,
        formatLlmUsage,
        shouldApplyBackgroundSnapshot,
        isClientBusy,
    };
});
