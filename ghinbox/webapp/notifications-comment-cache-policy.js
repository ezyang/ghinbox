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
        const lastReadAt = notification?.last_read_at || null;
        return {
            anchor,
            lastReadAt,
            hasFilter: Boolean(anchor || lastReadAt),
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

    return {
        DEFAULT_COMMENT_CACHE_TTL_MS,
        getCommentFetchWindow,
        getPendingReviewMetadataNotifications,
        getReviewMetadataNeeds,
        hasFreshCachedField,
        isAuthorAssociationFresh,
        isAuthorLoginFresh,
        isAuthorPermissionFresh,
        isCommentCacheFresh,
        isDiffstatFresh,
        isReviewDecisionFresh,
        isTimestampFresh,
        shouldPrefetchNotificationComments,
        shouldPrefetchReviewMetadata,
    };
});
