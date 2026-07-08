// Pure sync logic: overlap/dedup merging plus server snapshot key and apply
// decisions. Browser code passes plain data in; Node tests import this file.
(function (root, factory) {
    let identity = root.GhinboxNotificationIdentity;
    if (!identity && typeof require === 'function') {
        identity = require('./notifications-identity.js');
    }
    const api = factory(identity);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxSyncMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (identity) {
    const {
        getNotificationDedupKey,
        getNotificationKey,
        getNotificationMatchKey,
        getNotificationMatchKeyForRepo,
    } = identity;

    function getUpdatedAtSignature(updatedAt) {
        const parsed = Date.parse(updatedAt);
        if (Number.isNaN(parsed)) {
            return String(updatedAt || '');
        }
        return `ms:${parsed}`;
    }

    function buildPreviousMatchMap(notifications) {
        const map = new Map();
        notifications.forEach((notif, index) => {
            const key = getNotificationMatchKey(notif);
            if (!key || map.has(key)) {
                return;
            }
            map.set(key, { updatedAt: getUpdatedAtSignature(notif.updated_at), index });
        });
        return map;
    }

    function buildNotificationMatchKeySet(notifications, repo = null) {
        const keys = new Set();
        notifications.forEach((notif) => {
            const key = repo
                ? getNotificationMatchKeyForRepo(notif, repo)
                : getNotificationMatchKey(notif);
            if (key) {
                keys.add(key);
            }
        });
        return keys;
    }

    function buildIncrementalRestLookupKeys(notifications, previousMatchMap) {
        const keys = new Set();
        notifications.forEach((notif) => {
            const key = getNotificationMatchKey(notif);
            if (!key) {
                return;
            }
            const previous = previousMatchMap.get(key);
            if (previous && previous.updatedAt === getUpdatedAtSignature(notif.updated_at)) {
                return;
            }
            keys.add(key);
        });
        return keys;
    }

    function findIncrementalOverlapIndex(notifications, previousMatchMap) {
        for (const notif of notifications) {
            const key = getNotificationMatchKey(notif);
            if (!key) {
                continue;
            }
            const previous = previousMatchMap.get(key);
            if (previous && previous.updatedAt === getUpdatedAtSignature(notif.updated_at)) {
                return previous.index;
            }
        }
        return null;
    }

    function isSyntheticReviewRequest(notification) {
        return (
            notification?.responsibility_source === 'review-requested' &&
            String(notification?.id || '').startsWith('review-request:')
        );
    }

    function canUseIncrementalOverlapMerge({
        syncMode,
        sources,
        previousNotifications,
        lastSyncedRepo = null,
        profileSignature = null,
    } = {}) {
        if (syncMode !== 'incremental') {
            return false;
        }
        if (!Array.isArray(sources) || sources.length !== 1) {
            return false;
        }
        if (!Array.isArray(previousNotifications) || previousNotifications.length === 0) {
            return false;
        }
        if (!lastSyncedRepo) {
            return false;
        }
        const source = sources[0] || {};
        return (
            lastSyncedRepo === profileSignature ||
            lastSyncedRepo === source.fullName ||
            lastSyncedRepo === source.value
        );
    }

    function shouldPruneIncrementalNotifications({
        syncMode = null,
        fetchedUntilEnd = false,
        stoppedAtOverlap = false,
    } = {}) {
        return (
            syncMode === 'incremental' &&
            fetchedUntilEnd === true &&
            stoppedAtOverlap !== true
        );
    }

    function mergeIncrementalNotifications(
        newNotifications,
        previousNotifications,
        startIndex,
        { pruneMissing = false } = {}
    ) {
        const merged = newNotifications.slice();
        const seenKeys = new Set();
        const seenIds = new Set();
        const seenSyntheticReviewKeys = new Set();
        merged.forEach((notif) => {
            const id = getNotificationKey(notif);
            if (id) {
                seenIds.add(id);
            }
            const key = getNotificationDedupKey(notif);
            if (key) {
                seenKeys.add(key);
                if (isSyntheticReviewRequest(notif)) {
                    seenSyntheticReviewKeys.add(key);
                }
            }
        });
        for (let i = startIndex; i < previousNotifications.length; i += 1) {
            const notif = previousNotifications[i];
            const syntheticReviewRequest = isSyntheticReviewRequest(notif);
            if (pruneMissing && !syntheticReviewRequest) {
                continue;
            }
            const id = getNotificationKey(notif);
            if (id && seenIds.has(id)) {
                continue;
            }
            const key = getNotificationDedupKey(notif);
            if (key && seenKeys.has(key)) {
                // Synthetic review-request rows are sourced from review search, not
                // from the HTML notification stream. A fresh NT_ row for the same PR
                // does not make the cached synthetic responsibility row obsolete.
                if (!syntheticReviewRequest || seenSyntheticReviewKeys.has(key)) {
                    continue;
                }
            }
            merged.push(notif);
            if (id) {
                seenIds.add(id);
            }
            if (key) {
                seenKeys.add(key);
                if (syntheticReviewRequest) {
                    seenSyntheticReviewKeys.add(key);
                }
            }
        }
        return merged;
    }

    function dedupAndSortNotifications(notifications) {
        const deduped = [];
        const seenNotificationIds = new Set();
        notifications.forEach((notification) => {
            // Keep HTML NT_ rows distinct from synthetic review-request rows
            // for the same PR so notification-backed review requests stay clearable.
            const key = getNotificationKey(notification);
            if (seenNotificationIds.has(key)) {
                return;
            }
            seenNotificationIds.add(key);
            deduped.push(notification);
        });
        return deduped.sort((a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
    }

    function getServerSnapshotSourceKey(source) {
        if (!source || typeof source !== 'object') {
            return '';
        }
        if (source.kind === 'repo') {
            const fullName = String(
                source.fullName ||
                    (source.owner && source.repo
                        ? `${source.owner}/${source.repo}`
                        : source.value || '')
            ).trim();
            return fullName;
        }
        return '';
    }

    function getServerProfileSnapshotKey(profileName) {
        const name = String(profileName || '').trim();
        return name ? `profile:${name}` : '';
    }

    function getServerSnapshotKey(sources, profileName) {
        if (
            Array.isArray(sources) &&
            sources.length === 1 &&
            sources[0]?.kind === 'repo'
        ) {
            return getServerSnapshotSourceKey(sources[0]);
        }
        return getServerProfileSnapshotKey(profileName);
    }

    function getServerSnapshotLastSyncedRepo(sources, profileSignature) {
        const profileValue = String(profileSignature || '').trim();
        if (!Array.isArray(sources) || sources.length !== 1) {
            return profileValue;
        }
        const source = sources[0] || {};
        if (source.kind === 'repo') {
            return String(source.fullName || source.value || profileValue).trim();
        }
        return profileValue;
    }

    function getServerSnapshotSyncEntry(source) {
        if (!source || typeof source !== 'object') {
            return null;
        }
        if (source.kind === 'repo') {
            const owner = String(source.owner || '').trim();
            const repo = String(source.repo || '').trim();
            return owner && repo ? { kind: 'repo', owner, repo } : null;
        }
        if (source.kind === 'query') {
            const query = String(source.query || source.value || '').trim();
            return query ? { kind: 'query', query } : null;
        }
        return null;
    }

    function buildServerProfileSyncEntries(sources) {
        if (!Array.isArray(sources)) {
            return [];
        }
        return sources
            .map((source) => getServerSnapshotSyncEntry(source))
            .filter(Boolean);
    }

    function shouldApplyServerSnapshot({
        forceApply = false,
        currentNotificationCount = 0,
        snapshot = null,
        localSyncedAt = null,
    } = {}) {
        if (!snapshot || !Array.isArray(snapshot.notifications)) {
            return false;
        }
        if (forceApply) {
            return true;
        }
        if (currentNotificationCount === 0) {
            return true;
        }
        return Boolean(snapshot.synced_at && snapshot.synced_at !== localSyncedAt);
    }

    return {
        buildServerProfileSyncEntries,
        buildIncrementalRestLookupKeys,
        buildNotificationMatchKeySet,
        buildPreviousMatchMap,
        canUseIncrementalOverlapMerge,
        dedupAndSortNotifications,
        findIncrementalOverlapIndex,
        getServerProfileSnapshotKey,
        getServerSnapshotKey,
        getServerSnapshotLastSyncedRepo,
        getServerSnapshotSourceKey,
        getServerSnapshotSyncEntry,
        getUpdatedAtSignature,
        mergeIncrementalNotifications,
        shouldPruneIncrementalNotifications,
        shouldApplyServerSnapshot,
    };
});
