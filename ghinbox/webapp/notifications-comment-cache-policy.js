// Pure comment cache freshness and prefetch decision helpers.
// Browser code passes state-derived values in; Node tests import this file.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxCommentCachePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DEFAULT_COMMENT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

    function isTimestampFresh(timestamp, options = {}) {
        if (!timestamp) {
            return false;
        }
        const timestampMs = Date.parse(timestamp);
        if (Number.isNaN(timestampMs)) {
            return false;
        }
        const nowMs = options.nowMs ?? Date.now();
        const ttlMs = options.ttlMs ?? DEFAULT_COMMENT_CACHE_TTL_MS;
        return nowMs - timestampMs < ttlMs;
    }

    function isCommentCacheFresh(cached, options = {}) {
        return isTimestampFresh(cached?.fetchedAt, options);
    }

    function hasFreshCachedField(cached, fieldName, fetchedAtFieldName, options = {}) {
        if (!cached || !Object.prototype.hasOwnProperty.call(cached, fieldName)) {
            return false;
        }
        return isTimestampFresh(cached[fetchedAtFieldName] || cached.fetchedAt, options);
    }

    function isReviewDecisionFresh(cached, options = {}) {
        return hasFreshCachedField(cached, 'reviewDecision', 'reviewDecisionFetchedAt', options);
    }

    function isAuthorAssociationFresh(cached, options = {}) {
        return hasFreshCachedField(cached, 'authorAssociation', 'authorAssociationFetchedAt', options);
    }

    function isAuthorPermissionFresh(cached, options = {}) {
        return hasFreshCachedField(cached, 'authorPermission', 'authorPermissionFetchedAt', options);
    }

    function isAuthorLoginFresh(cached, options = {}) {
        return hasFreshCachedField(cached, 'authorLogin', 'authorLoginFetchedAt', options);
    }

    function isDiffstatFresh(cached, options = {}) {
        return (
            cached &&
            Object.prototype.hasOwnProperty.call(cached, 'additions') &&
            Object.prototype.hasOwnProperty.call(cached, 'deletions') &&
            isTimestampFresh(cached.diffstatFetchedAt || cached.fetchedAt, options)
        );
    }

    function getCommentFetchWindow(notification) {
        const anchor = notification?.subject?.anchor || null;
        const lastReadAt =
            notification?.ui?.read_comment_watermark_at || notification?.last_read_at || null;
        return {
            anchor,
            lastReadAt,
            hasFilter: Boolean(anchor || lastReadAt),
        };
    }

    function getPreservedCommentMetadata(cached) {
        const preserved = {
            reviewDecision: cached?.reviewDecision,
            reviewDecisionFetchedAt: cached?.reviewDecisionFetchedAt,
            additions: cached?.additions,
            deletions: cached?.deletions,
            changedFiles: cached?.changedFiles,
            diffstatFetchedAt: cached?.diffstatFetchedAt,
        };
        if (Array.isArray(cached?.stateEvents)) {
            preserved.stateEvents = cached.stateEvents;
        }
        if (cached?.stateEventsFetchedAt) {
            preserved.stateEventsFetchedAt = cached.stateEventsFetchedAt;
        }
        if (cached?.authorLogin !== null && cached?.authorLogin !== undefined) {
            preserved.authorLogin = cached.authorLogin;
            preserved.authorLoginFetchedAt = cached.authorLoginFetchedAt;
        }
        if (cached?.authorAssociation !== null && cached?.authorAssociation !== undefined) {
            preserved.authorAssociation = cached.authorAssociation;
            preserved.authorAssociationFetchedAt = cached.authorAssociationFetchedAt;
        }
        if (cached?.authorPermission !== null && cached?.authorPermission !== undefined) {
            preserved.authorPermission = cached.authorPermission;
            preserved.authorPermissionFetchedAt = cached.authorPermissionFetchedAt;
        }
        return preserved;
    }

    function buildCommentSuccessCacheEntry(notification, cached, options = {}) {
        const { anchor, lastReadAt } = getCommentFetchWindow(notification);
        const stateEvents = Array.isArray(options.stateEvents)
            ? options.stateEvents
            : Array.isArray(cached?.stateEvents)
                ? cached.stateEvents
                : [];
        return {
            notificationUpdatedAt: notification?.updated_at,
            anchor,
            lastReadAt,
            unread: notification?.unread,
            ...getPreservedCommentMetadata(cached),
            comments: Array.isArray(options.comments) ? options.comments : [],
            stateEvents,
            stateEventsFetchedAt: options.stateEventsFetchedAt ||
                options.fetchedAt ||
                cached?.stateEventsFetchedAt ||
                new Date().toISOString(),
            allComments: Boolean(options.allComments),
            fetchedAt: options.fetchedAt || new Date().toISOString(),
        };
    }

    function buildCommentErrorCacheEntry(notification, cached, options = {}) {
        const { hasFilter } = getCommentFetchWindow(notification);
        return {
            notificationUpdatedAt: notification?.updated_at,
            comments: [],
            allComments: !hasFilter,
            error: options.error || 'Unknown comment fetch error.',
            fetchedAt: options.fetchedAt || new Date().toISOString(),
            ...getPreservedCommentMetadata(cached),
        };
    }

    function buildMissingIssueCommentCacheEntry(notification, cached, options = {}) {
        return {
            notificationUpdatedAt: notification?.updated_at,
            comments: [],
            error: 'No issue number found.',
            fetchedAt: options.fetchedAt || new Date().toISOString(),
            ...getPreservedCommentMetadata(cached),
        };
    }

    function shouldPrefetchNotificationComments(notification, cached, options = {}) {
        if (!cached) {
            return true;
        }
        if (cached.notificationUpdatedAt !== notification?.updated_at) {
            return true;
        }
        if (!isCommentCacheFresh(cached, options)) {
            return true;
        }

        const { anchor, lastReadAt, hasFilter } = getCommentFetchWindow(notification);
        if (hasFilter) {
            return (cached.anchor || null) !== anchor || (cached.lastReadAt || null) !== lastReadAt;
        }
        return !cached.allComments;
    }

    function getReviewMetadataNeeds(cached, options = {}) {
        return {
            reviewDecision: !isReviewDecisionFresh(cached, options),
            authorAssociation:
                Boolean(options.includeAuthorAssociation) &&
                !isAuthorAssociationFresh(cached, options),
            authorPermission:
                Boolean(options.includeAuthorPermission) &&
                !isAuthorPermissionFresh(cached, options),
            authorLogin: !isAuthorLoginFresh(cached, options),
            diffstat: !isDiffstatFresh(cached, options),
        };
    }

    function shouldPrefetchReviewMetadata(notification, cached, options = {}) {
        if (notification?.subject?.type !== 'PullRequest') {
            return false;
        }
        if (options.force) {
            return true;
        }
        const needs = getReviewMetadataNeeds(cached, options);
        return Object.values(needs).some(Boolean);
    }

    function getPendingReviewMetadataNotifications(notifications, cacheThreads = {}, options = {}) {
        if (!Array.isArray(notifications)) {
            return [];
        }
        const getKey = typeof options.getNotificationKey === 'function'
            ? options.getNotificationKey
            : (notification) => notification?.id;
        return notifications.filter((notification) =>
            shouldPrefetchReviewMetadata(notification, cacheThreads[getKey(notification)], options)
        );
    }

    function getCommentCacheThreads(commentCache) {
        return commentCache && typeof commentCache.threads === 'object' && commentCache.threads
            ? commentCache.threads
            : {};
    }

    function shouldUseServerSnapshotCommentEntry(existingEntry, snapshotEntry) {
        const existingFetchedAt = Date.parse(existingEntry?.fetchedAt || '');
        const snapshotFetchedAt = Date.parse(snapshotEntry?.fetchedAt || '');
        return (
            !existingEntry ||
            Number.isNaN(existingFetchedAt) ||
            (!Number.isNaN(snapshotFetchedAt) && snapshotFetchedAt >= existingFetchedAt)
        );
    }

    function mergeServerSnapshotCommentCache(commentCache, snapshotCommentCache) {
        const snapshotThreads = getCommentCacheThreads(snapshotCommentCache);
        const mergedThreads = { ...getCommentCacheThreads(commentCache) };
        Object.entries(snapshotThreads).forEach(([key, snapshotEntry]) => {
            if (shouldUseServerSnapshotCommentEntry(mergedThreads[key], snapshotEntry)) {
                mergedThreads[key] = snapshotEntry;
            }
        });
        return {
            version: (commentCache && commentCache.version) || 1,
            threads: mergedThreads,
        };
    }

    function pruneCommentCacheToNotifications(commentCache, notifications) {
        const liveIds = new Set();
        (Array.isArray(notifications) ? notifications : []).forEach((notification) => {
            const id = String(notification?.id || '');
            if (id) {
                liveIds.add(id);
            }
        });

        const prunedThreads = {};
        Object.entries(getCommentCacheThreads(commentCache)).forEach(([key, entry]) => {
            if (liveIds.has(key)) {
                prunedThreads[key] = entry;
            }
        });
        return {
            version: (commentCache && commentCache.version) || 1,
            threads: prunedThreads,
        };
    }

    return {
        DEFAULT_COMMENT_CACHE_TTL_MS,
        buildCommentErrorCacheEntry,
        buildCommentSuccessCacheEntry,
        buildMissingIssueCommentCacheEntry,
        getCommentFetchWindow,
        getCommentCacheThreads,
        getPendingReviewMetadataNotifications,
        getPreservedCommentMetadata,
        getReviewMetadataNeeds,
        hasFreshCachedField,
        isAuthorAssociationFresh,
        isAuthorLoginFresh,
        isAuthorPermissionFresh,
        isCommentCacheFresh,
        isDiffstatFresh,
        isReviewDecisionFresh,
        isTimestampFresh,
        mergeServerSnapshotCommentCache,
        pruneCommentCacheToNotifications,
        shouldUseServerSnapshotCommentEntry,
        shouldPrefetchNotificationComments,
        shouldPrefetchReviewMetadata,
    };
});
