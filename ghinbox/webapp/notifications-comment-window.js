// Pure comment windowing and render-state helpers.
// Browser code passes state-derived values in; Node tests import this file.
(function (root, factory) {
    let commentInterest = root.GhinboxCommentInterest;
    if (!commentInterest && typeof require === 'function') {
        commentInterest = require('./notifications-comment-interest.js');
    }
    const api = factory(commentInterest);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxCommentWindow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (commentInterest) {
    const AGE_THRESHOLDS = {
        '1day': 1 * 24 * 60 * 60 * 1000,
        '3days': 3 * 24 * 60 * 60 * 1000,
        '1week': 7 * 24 * 60 * 60 * 1000,
        '1month': 30 * 24 * 60 * 60 * 1000,
    };

    function extractCommentIdFromAnchor(anchor) {
        if (!anchor) {
            return null;
        }
        const issueMatch = String(anchor).match(/^issuecomment-(\d+)$/);
        if (issueMatch) {
            return { id: parseInt(issueMatch[1], 10), type: 'issue' };
        }
        const discussionMatch = String(anchor).match(/^discussion_r(\d+)$/);
        if (discussionMatch) {
            return { id: parseInt(discussionMatch[1], 10), type: 'discussion' };
        }
        const reviewMatch = String(anchor).match(/^pullrequestreview-(\d+)$/);
        if (reviewMatch) {
            return { id: parseInt(reviewMatch[1], 10), type: 'review' };
        }
        const reviewCommentMatch = String(anchor).match(/^r(\d+)$/);
        if (reviewCommentMatch) {
            return { id: parseInt(reviewCommentMatch[1], 10), type: 'review_comment' };
        }
        return null;
    }

    function filterCommentsByAnchor(comments, anchor) {
        if (!anchor || !comments || comments.length === 0) {
            return comments;
        }
        const anchorInfo = extractCommentIdFromAnchor(anchor);
        if (!anchorInfo) {
            return comments;
        }
        const { id: anchorCommentId, type: anchorType } = anchorInfo;
        const anchorIndex = comments.findIndex((comment) => {
            const commentId = typeof comment.id === 'number' ? comment.id : parseInt(comment.id, 10);
            if (commentId !== anchorCommentId) {
                return false;
            }
            if (anchorType === 'review_comment' && comment.isReviewComment) {
                return true;
            }
            if (anchorType === 'issue' && !comment.isReviewComment && !comment.isIssue) {
                return true;
            }
            return commentId === anchorCommentId;
        });
        return anchorIndex === -1 ? comments : comments.slice(anchorIndex);
    }

    function filterCommentsByLastReadAt(comments, lastReadAt) {
        if (!lastReadAt || !comments || comments.length === 0) {
            return comments;
        }
        const lastReadMs = Date.parse(lastReadAt);
        if (Number.isNaN(lastReadMs)) {
            return comments;
        }
        return comments.filter((comment) => {
            const timestamp = comment?.updated_at || comment?.created_at;
            if (!timestamp) {
                return true;
            }
            const commentMs = Date.parse(timestamp);
            return Number.isNaN(commentMs) || commentMs > lastReadMs;
        });
    }

    function getCommentWindowComments(notification, cached) {
        const anchor = cached?.anchor || notification?.subject?.anchor || null;
        const lastReadAt = cached?.lastReadAt || notification?.last_read_at || null;
        const rawComments = cached?.comments || [];
        if (!cached?.allComments) {
            return rawComments;
        }
        const anchoredComments = filterCommentsByAnchor(rawComments, anchor);
        return anchor ? anchoredComments : filterCommentsByLastReadAt(anchoredComments, lastReadAt);
    }

    function isCommentTooOld(comment, ageFilter, now = new Date()) {
        if (ageFilter === 'all') {
            return false;
        }
        const threshold = AGE_THRESHOLDS[ageFilter];
        if (!threshold) {
            return false;
        }
        const timestamp = comment?.created_at || comment?.updated_at;
        if (!timestamp) {
            return false;
        }
        const parsed = Date.parse(timestamp);
        if (Number.isNaN(parsed)) {
            return false;
        }
        const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
        if (Number.isNaN(nowMs)) {
            return false;
        }
        return nowMs - parsed > threshold;
    }

    function pluralize(count, singular, plural = `${singular}s`) {
        return `${count} ${count === 1 ? singular : plural}`;
    }

    function normalizeLogin(login) {
        return login ? String(login).toLowerCase() : '';
    }

    function getLatestOwnCommentIndex(comments, currentUserLogin) {
        const login = normalizeLogin(currentUserLogin);
        if (!login || !Array.isArray(comments)) {
            return -1;
        }
        let latestIndex = -1;
        comments.forEach((comment, index) => {
            const author = normalizeLogin(comment?.user?.login);
            if (author === login) {
                latestIndex = index;
            }
        });
        return latestIndex;
    }

    function getEmptyCommentDetail(cached, unreadComments, relevantComments, options = {}) {
        const rawCount = Array.isArray(cached?.comments) ? cached.comments.length : 0;
        const unreadCount = Array.isArray(unreadComments) ? unreadComments.length : 0;
        if (rawCount === 0) {
            return '';
        }
        if (unreadCount === 0) {
            return `Cached ${pluralize(rawCount, 'comment')}; none are in the current unread window.`;
        }
        if (relevantComments.length > 0) {
            return '';
        }
        const latestOwnIndex = getLatestOwnCommentIndex(
            unreadComments,
            options.currentUserLogin
        );
        if (latestOwnIndex === unreadComments.length - 1) {
            return `Cached ${pluralize(rawCount, 'comment')}; none remain after your latest comment.`;
        }
        return `Cached ${pluralize(rawCount, 'comment')}; ${pluralize(unreadCount, 'comment')} in the current window, but none matched the relevance filter.`;
    }

    function getRenderableCommentState(notification, cached, options = {}) {
        if (!cached) {
            return { kind: 'pending', label: 'Comments: pending...' };
        }
        if (cached.error) {
            return { kind: 'error', error: cached.error };
        }

        const anchor = cached.anchor || notification?.subject?.anchor || null;
        const unreadComments = getCommentWindowComments(notification, cached);
        const comments = commentInterest.filterRelevantCommentsForNotification(
            notification,
            unreadComments,
            options.currentUserLogin
        );
        const hasFilter = Boolean(anchor || cached.lastReadAt);
        if (comments.length === 0) {
            return {
                kind: 'empty',
                label: hasFilter ? 'No unread comments found.' : 'No comments found.',
                detail: getEmptyCommentDetail(cached, unreadComments, comments, options),
            };
        }

        const visibleComments = options.hideUninteresting
            ? comments.filter((comment) => !commentInterest.isUninterestingComment(comment))
            : comments;
        const ageFilteredComments = visibleComments.filter(
            (comment) => !isCommentTooOld(comment, options.ageFilter || 'all', options.now)
        );
        if (ageFilteredComments.length === 0) {
            return {
                kind: 'empty',
                label: visibleComments.length > 0
                    ? 'All comments filtered by age.'
                    : 'No interesting unread comments found.',
            };
        }
        return { kind: 'comments', comments: ageFilteredComments };
    }

    return {
        extractCommentIdFromAnchor,
        filterCommentsByAnchor,
        filterCommentsByLastReadAt,
        getCommentWindowComments,
        getRenderableCommentState,
        isCommentTooOld,
    };
});
