// Pure comment windowing helpers: which cached comments are in the unread window.
// Browser code passes state-derived values in; Node tests import this file.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxCommentWindow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

    return {
        extractCommentIdFromAnchor,
        filterCommentsByAnchor,
        filterCommentsByLastReadAt,
        getCommentWindowComments,
    };
});
