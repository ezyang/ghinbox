// Pure comment windowing helpers: which cached comments are in the unread
// window, and which ones the Replies view shows inline.
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

    function isUninterestingReplyContextComment(comment, currentUserLogin) {
        return !commentInterest.isDelegatedTaskCompletion(comment, currentUserLogin) &&
            commentInterest.isUninterestingComment(comment);
    }

    // The latest close/merge per event name, newer than sinceMs. The cache
    // can hold both a synthetic closed-at event and GitHub's own for one close.
    function getCloseEventsAfter(stateEvents, sinceMs) {
        const latestByName = new Map();
        (Array.isArray(stateEvents) ? stateEvents : []).forEach((event) => {
            if (!commentInterest.isClosingStateEvent(event)) {
                return;
            }
            const timestampMs = commentInterest.getCommentTimestampMs(event);
            if (!timestampMs || timestampMs <= sinceMs) {
                return;
            }
            const name = String(event.event || event.type || 'closed').toLowerCase();
            const previous = latestByName.get(name);
            if (!previous || timestampMs > previous.timestampMs) {
                latestByName.set(name, { name, timestampMs, event });
            }
        });
        return Array.from(latestByName.values()).map(({ name, event }) => ({
            kind: 'event',
            event: name === 'state_change' || name === 'state-change' ? 'closed' : name,
            actor: event.actor?.login || null,
            created_at: event.created_at || event.updated_at,
        }));
    }

    // What the Replies view shows under a row: the comment that made the
    // notification a reply (findDirectedComment) and all activity after it,
    // so the user can see whether the thread still needs them. Runs of bot
    // comments after the reply collapse into one item. Without a directed
    // comment (forced outside-org replies) it shows the unread comments.
    //   kind: 'reply' | 'unread'
    //   items: [{ kind: 'comment', comment, directed }
    //          | { kind: 'bots', comments, authors }
    //          | { kind: 'event', event: 'closed' | 'merged', actor, created_at }]
    function getReplyContext(notification, options = {}) {
        const comments = commentInterest.sortComments(options.comments || []);
        const interestOptions = { ...options, comments };
        const directed = commentInterest.findDirectedComment(notification, interestOptions);
        const kind = directed ? 'reply' : 'unread';
        const shown = directed
            ? comments.slice(comments.indexOf(directed))
            : commentInterest.getUnreadComments(notification, interestOptions);

        const items = [];
        shown.forEach((comment) => {
            if (
                comment !== directed &&
                isUninterestingReplyContextComment(comment, options.currentUserLogin)
            ) {
                const previous = items[items.length - 1];
                if (previous?.kind === 'bots') {
                    previous.comments.push(comment);
                } else {
                    items.push({ kind: 'bots', comments: [comment] });
                }
                return;
            }
            items.push({ kind: 'comment', comment, directed: comment === directed });
        });
        items.forEach((item) => {
            if (item.kind === 'bots') {
                item.authors = Array.from(
                    new Set(item.comments.map((comment) => comment.user?.login || 'unknown'))
                );
            }
        });

        if (shown.length > 0) {
            const sinceMs = commentInterest.getCommentTimestampMs(shown[0]);
            getCloseEventsAfter(options.stateEvents, sinceMs).forEach((eventItem) => {
                const eventMs = commentInterest.getCommentTimestampMs(eventItem);
                const index = items.findIndex((item) => {
                    const first = item.kind === 'bots' ? item.comments[0] : item.comment;
                    return commentInterest.getCommentTimestampMs(first) > eventMs;
                });
                items.splice(index === -1 ? items.length : index, 0, eventItem);
            });
        }
        return { kind, items };
    }

    // Plain-text comment body for inline display: bot templates hide markup
    // in HTML comments, which GitHub never renders.
    function getCommentDisplayText(body) {
        return String(body || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    }

    return {
        extractCommentIdFromAnchor,
        getCommentDisplayText,
        getReplyContext,
        filterCommentsByAnchor,
        filterCommentsByLastReadAt,
        getCommentWindowComments,
    };
});
