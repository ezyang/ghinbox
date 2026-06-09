// Pure comment status label/class helpers.
// Browser code passes state-derived values in; Node tests import this file.
(function (root, factory) {
    let commentInterest = root.GhinboxCommentInterest;
    let commentWindow = root.GhinboxCommentWindow;
    if ((!commentInterest || !commentWindow) && typeof require === 'function') {
        commentInterest = commentInterest || require('./notifications-comment-interest.js');
        commentWindow = commentWindow || require('./notifications-comment-window.js');
    }
    const api = factory(commentInterest, commentWindow);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxCommentStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (commentInterest, commentWindow) {
    function getPullRequestState(notification) {
        return String(notification?.subject?.state || '').toLowerCase();
    }

    function isOpenPullRequest(notification) {
        if (notification?.subject?.type !== 'PullRequest') {
            return false;
        }
        const state = getPullRequestState(notification);
        return state !== 'draft' && state !== 'closed' && state !== 'merged';
    }

    function isReviewResponsibility(notification) {
        if (notification?.subject?.type !== 'PullRequest') {
            return false;
        }
        if (notification.responsibility_source === 'review-requested') {
            return true;
        }
        const reason = String(notification.reason || '').toLowerCase();
        return reason === 'review_requested' || reason === 'approved';
    }

    function getReviewDecision(cached) {
        return String(cached?.reviewDecision || '').toUpperCase();
    }

    function hasSubmittedApproval(cached) {
        const reviews = Array.isArray(cached?.reviews) ? cached.reviews : [];
        return reviews.some((review) => String(review?.state || '').toUpperCase() === 'APPROVED');
    }

    function getLabelNames(notification, cached) {
        const labels = Array.isArray(cached?.labelNames)
            ? cached.labelNames
            : Array.isArray(notification?.labels)
                ? notification.labels.map((label) =>
                    typeof label === 'string' ? label : label?.name
                )
                : [];
        return labels
            .map((label) => String(label || '').trim().toLowerCase())
            .filter(Boolean);
    }

    function hasMergedogLabel(notification, cached) {
        return getLabelNames(notification, cached).includes('mergedog');
    }

    const { getCommentTimestampMs, normalizeLogin } = commentInterest;

    function isPyTorchMergeBotComment(comment) {
        const login = normalizeLogin(comment?.user?.login);
        return login === 'pytorchmergebot' || login === 'pytorch-bot[bot]';
    }

    function isApprovalQualificationMergeFailure(comment) {
        if (!isPyTorchMergeBotComment(comment)) {
            return false;
        }
        const body = String(comment?.body || '');
        return (
            /\bmerge failed\b/i.test(body) &&
            /approvers from one of the following sets are needed/i.test(body)
        );
    }

    function isMergeStartedComment(comment) {
        if (!isPyTorchMergeBotComment(comment)) {
            return false;
        }
        return /\bmerge started\b/i.test(String(comment?.body || ''));
    }

    function hasUnresolvedApprovalQualificationFailure(cached) {
        const comments = Array.isArray(cached?.comments) ? cached.comments : [];
        let latestFailureMs = null;
        let latestMergeStartedMs = null;

        comments.forEach((comment) => {
            const timestampMs = getCommentTimestampMs(comment);
            if (isApprovalQualificationMergeFailure(comment)) {
                latestFailureMs = Math.max(latestFailureMs ?? timestampMs ?? 0, timestampMs ?? 0);
            } else if (isMergeStartedComment(comment)) {
                latestMergeStartedMs = Math.max(
                    latestMergeStartedMs ?? timestampMs ?? 0,
                    timestampMs ?? 0
                );
            }
        });

        if (latestFailureMs === null) {
            return false;
        }
        return latestMergeStartedMs === null || latestFailureMs > latestMergeStartedMs;
    }

    function isApproved(notification, cached) {
        if (!isOpenPullRequest(notification) || !cached || cached.error) {
            return false;
        }
        const reviewDecision = getReviewDecision(cached);
        return (
            (reviewDecision === 'APPROVED' ||
                (reviewDecision !== 'CHANGES_REQUESTED' && hasSubmittedApproval(cached))) &&
            !hasMergedogLabel(notification, cached) &&
            !hasUnresolvedApprovalQualificationFailure(cached)
        );
    }

    function isChangesRequested(notification, cached) {
        if (!isOpenPullRequest(notification) || !cached || cached.error) {
            return false;
        }
        return getReviewDecision(cached) === 'CHANGES_REQUESTED';
    }

    function isNeedsReview(notification, cached) {
        return (
            isOpenPullRequest(notification) &&
            isReviewResponsibility(notification) &&
            !hasMergedogLabel(notification, cached) &&
            !isApproved(notification, cached)
        );
    }

    function getStatusComments(notification, cached) {
        const anchor = cached?.anchor || notification?.subject?.anchor || null;
        const comments = cached?.comments || [];
        return commentWindow.getCommentWindowComments(notification, {
            ...cached,
            anchor,
            comments,
        });
    }

    function getUninterestingReason(notification, cached, options = {}) {
        if (!cached || cached.error) {
            return null;
        }
        return commentInterest.getUninterestingReason(notification, {
            comments: getStatusComments(notification, cached),
            currentUserLogin: options.currentUserLogin,
            isApproved: isApproved(notification, cached),
        });
    }

    function isUninteresting(notification, cached, options = {}) {
        if (!cached || cached.error) {
            return false;
        }
        return commentInterest.isNotificationUninteresting(notification, {
            comments: getStatusComments(notification, cached),
            currentUserLogin: options.currentUserLogin,
            isApproved: isApproved(notification, cached),
        });
    }

    function getCommentStatus(notification, cached, options = {}) {
        if (!cached) {
            return { label: 'Comments: pending', className: 'pending' };
        }
        if (cached.error) {
            return { label: 'Comments: error', className: 'error' };
        }

        const comments = getStatusComments(notification, cached);
        const count = comments.length;
        const directReplies = commentInterest.getDirectReviewThreadReplies(
            comments,
            options.currentUserLogin
        );
        if (directReplies.length > 0) {
            return {
                label: directReplies.length === 1
                    ? 'Reply to you'
                    : `Replies to you (${directReplies.length})`,
                className: 'interesting',
            };
        }

        if (isNeedsReview(notification, cached)) {
            return { label: 'Needs review', className: 'needs-review' };
        }

        if (isApproved(notification, cached)) {
            return { label: 'Approved', className: 'approved' };
        }

        const reason = getUninterestingReason(notification, cached, options);
        const reasonLabels = {
            'no-comments': 'No new comments',
            'bot-only': 'Bot comments only',
            'bot-commands': 'Bot commands only',
            'own-or-bot-only': 'Only you or bots',
        };
        if (reason !== null) {
            const reasonLabel = reasonLabels[reason];
            return {
                label: count > 0 ? `${reasonLabel} (${count})` : reasonLabel,
                className: 'uninteresting',
            };
        }

        return { label: `Interesting (${count})`, className: 'interesting' };
    }

    return {
        getCommentStatus,
        getStatusComments,
        getUninterestingReason,
        hasUnresolvedApprovalQualificationFailure,
        hasMergedogLabel,
        isApproved,
        isChangesRequested,
        isNeedsReview,
        isReviewResponsibility,
        isUninteresting,
    };
});
