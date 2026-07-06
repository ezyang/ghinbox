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

    return {
        buildIncrementalRestLookupKeys,
        buildNotificationMatchKeySet,
        buildPreviousMatchMap,
        canUseIncrementalOverlapMerge,
        dedupAndSortNotifications,
        findIncrementalOverlapIndex,
        getUpdatedAtSignature,
        mergeIncrementalNotifications,
    };
});
