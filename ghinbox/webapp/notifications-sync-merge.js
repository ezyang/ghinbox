// Pure incremental-sync merge logic: overlap detection and dedup merging of
// freshly fetched notification pages against the previous sync's list.
// Browser code passes notification arrays in; Node tests import this file.
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
    const { getNotificationMatchKey, getNotificationMatchKeyForRepo, getNotificationDedupKey } =
        identity;

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

    function mergeIncrementalNotifications(newNotifications, previousNotifications, startIndex) {
        const merged = newNotifications.slice();
        const seenKeys = new Set();
        merged.forEach((notif) => {
            const key = getNotificationDedupKey(notif);
            if (key) {
                seenKeys.add(key);
            }
        });
        for (let i = startIndex; i < previousNotifications.length; i += 1) {
            const notif = previousNotifications[i];
            const key = getNotificationDedupKey(notif);
            if (key && seenKeys.has(key)) {
                continue;
            }
            merged.push(notif);
            if (key) {
                seenKeys.add(key);
            }
        }
        return merged;
    }

    function pruneCommentCacheToNotifications(commentCache, notifications) {
        // A full sync rebuilds the notification list from upstream, so any
        // cached comment thread whose notification is no longer present is an
        // orphan. Drop those so local IndexedDB state can be fully reconstructed
        // from upstream and stale entries never accumulate. Returns a new cache;
        // does not mutate the input.
        const threads = commentCache && typeof commentCache.threads === 'object' && commentCache.threads
            ? commentCache.threads
            : {};
        const version = (commentCache && commentCache.version) || 1;
        const liveIds = new Set();
        (Array.isArray(notifications) ? notifications : []).forEach((notif) => {
            const id = String(notif?.id || '');
            if (id) {
                liveIds.add(id);
            }
        });
        const prunedThreads = {};
        Object.keys(threads).forEach((key) => {
            if (liveIds.has(key)) {
                prunedThreads[key] = threads[key];
            }
        });
        return { version, threads: prunedThreads };
    }

    return {
        buildIncrementalRestLookupKeys,
        buildNotificationMatchKeySet,
        buildPreviousMatchMap,
        findIncrementalOverlapIndex,
        getUpdatedAtSignature,
        mergeIncrementalNotifications,
        pruneCommentCacheToNotifications,
    };
});
