// Pure comment-interest, mention, reply, and uninteresting-comment helpers.
// Browser code passes state-derived values in; Node tests import this file.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxCommentInterest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalizeLogin(login) {
        return String(login || '').trim().toLowerCase();
    }

    function mentionsCurrentUser(text, currentUserLogin) {
        const login = String(currentUserLogin || '').trim();
        if (!login || !text) {
            return false;
        }
        const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, 'i');
        return pattern.test(String(text));
    }

    function isCurrentUserCcLine(line, currentUserLogin) {
        const text = String(line || '').trim();
        if (!/^cc:?\s+/i.test(text)) {
            return false;
        }
        return mentionsCurrentUser(text, currentUserLogin);
    }

    function hasActionableCurrentUserMention(comment, currentUserLogin) {
        const body = String(comment?.body || '');
        if (!mentionsCurrentUser(body, currentUserLogin)) {
            return false;
        }
        if (!comment?.isIssue) {
            return true;
        }
        const mentionedLines = body
            .split(/\r?\n/)
            .filter((line) => mentionsCurrentUser(line, currentUserLogin));
        return mentionedLines.some((line) => !isCurrentUserCcLine(line, currentUserLogin));
    }

    function getReviewThreadKey(comment) {
        if (!comment?.isReviewComment) {
            return null;
        }
        const rootId = comment.in_reply_to_id || comment.id;
        if (rootId === null || rootId === undefined) {
            return null;
        }
        return String(rootId);
    }

    function getCommentTimestampMs(comment) {
        const timestamp = comment?.created_at || comment?.updated_at;
        if (!timestamp) {
            return 0;
        }
        const parsed = Date.parse(timestamp);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    function isClosingSubjectState(state) {
        const normalized = String(state || '').toLowerCase();
        return normalized === 'closed' || normalized === 'merged';
    }

    function isClosedOrMergedNotification(notification) {
        return isClosingSubjectState(notification?.subject?.state);
    }

    function getStateEventTimestampMs(event) {
        const timestamp = event?.created_at || event?.updated_at;
        if (!timestamp) {
            return null;
        }
        const parsed = Date.parse(timestamp);
        return Number.isNaN(parsed) ? null : parsed;
    }

    function isClosingStateEvent(event) {
        const eventName = String(event?.event || event?.type || '').toLowerCase();
        if (eventName === 'closed' || eventName === 'merged') {
            return true;
        }
        if (eventName === 'state_change' || eventName === 'state-change') {
            return isClosingSubjectState(event?.state || event?.to_state || event?.to);
        }
        return false;
    }

    function getLatestCloseEventTimestampMs(stateEvents) {
        if (!Array.isArray(stateEvents) || stateEvents.length === 0) {
            return null;
        }
        let latest = null;
        stateEvents.forEach((event) => {
            if (!isClosingStateEvent(event)) {
                return;
            }
            const timestampMs = getStateEventTimestampMs(event);
            if (timestampMs === null) {
                return;
            }
            latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
        });
        return latest;
    }

    function sortComments(comments) {
        if (!Array.isArray(comments)) {
            return [];
        }
        return [...comments].sort((a, b) => {
            const timeA = getCommentTimestampMs(a);
            const timeB = getCommentTimestampMs(b);
            if (timeA === timeB) {
                const idA = Number(a?.id) || 0;
                const idB = Number(b?.id) || 0;
                return idA - idB;
            }
            return timeA - timeB;
        });
    }

    function getParticipationThreadKey(comment) {
        if (comment?.isReviewComment) {
            return `review:${getReviewThreadKey(comment) || comment.id || 'unknown'}`;
        }
        return 'conversation';
    }

    function isMainThreadComment(comment) {
        return !comment?.isReviewComment;
    }

    function filterCommentsAfterOwnComment(comments, currentUserLogin) {
        const login = normalizeLogin(currentUserLogin);
        if (!login) {
            return comments;
        }
        let lastOwnIndex = -1;
        for (let i = 0; i < comments.length; i += 1) {
            const author = normalizeLogin(comments[i]?.user?.login);
            if (author === login) {
                lastOwnIndex = i;
            }
        }
        return lastOwnIndex === -1 ? comments : comments.slice(lastOwnIndex + 1);
    }

    function getDirectReviewThreadReplies(comments, currentUserLogin) {
        const login = normalizeLogin(currentUserLogin);
        if (!login || !Array.isArray(comments) || comments.length === 0) {
            return [];
        }
        const byThread = new Map();
        comments.forEach((comment, index) => {
            const key = getReviewThreadKey(comment);
            if (!key) {
                return;
            }
            const thread = byThread.get(key) || [];
            thread.push({ comment, index });
            byThread.set(key, thread);
        });
        const replies = [];
        byThread.forEach((thread) => {
            let lastOwnIndex = -1;
            thread.forEach(({ comment }, index) => {
                const author = normalizeLogin(comment?.user?.login);
                if (author === login) {
                    lastOwnIndex = index;
                }
            });
            if (lastOwnIndex === -1) {
                return;
            }
            thread.slice(lastOwnIndex + 1).forEach(({ comment }) => {
                const author = normalizeLogin(comment?.user?.login);
                if (author && author !== login) {
                    replies.push(comment);
                }
            });
        });
        replies.sort((a, b) => {
            const dateA = new Date(a.created_at || a.updated_at || 0);
            const dateB = new Date(b.created_at || b.updated_at || 0);
            return dateA - dateB;
        });
        return replies;
    }

    function filterRelevantCommentsForNotification(notification, comments, currentUserLogin) {
        if (notification.subject?.type === 'PullRequest') {
            const directReplies = getDirectReviewThreadReplies(comments, currentUserLogin);
            if (directReplies.length > 0) {
                return directReplies;
            }
        }
        return filterCommentsAfterOwnComment(comments, currentUserLogin);
    }

    function isNotificationForCurrentUser(notification, options = {}) {
        if (notification.subject?.type !== 'PullRequest') {
            return false;
        }

        const currentUser = normalizeLogin(options.currentUserLogin);
        if (!currentUser) {
            return String(notification.reason || '').toLowerCase() === 'mention';
        }

        const authorLogin = normalizeLogin(options.authorLogin);
        if (
            authorLogin === currentUser ||
            String(notification.reason || '').toLowerCase() === 'author'
        ) {
            return true;
        }

        if (String(notification.reason || '').toLowerCase() === 'mention') {
            return true;
        }

        const comments = sortComments(options.comments || []);
        if (!comments.length) {
            return false;
        }

        let latestOwnIndex = -1;
        comments.forEach((comment, index) => {
            const author = normalizeLogin(comment?.user?.login);
            if (author === currentUser) {
                latestOwnIndex = index;
            }
        });

        const threadParticipation = new Map();
        comments.forEach((comment, index) => {
            const key = getParticipationThreadKey(comment);
            const stateForThread = threadParticipation.get(key) || {
                own: false,
                mentioned: false,
            };
            if (index <= latestOwnIndex) {
                const author = normalizeLogin(comment?.user?.login);
                if (author === currentUser) {
                    stateForThread.own = true;
                }
                if (hasActionableCurrentUserMention(comment, currentUser)) {
                    stateForThread.mentioned = true;
                }
            }
            threadParticipation.set(key, stateForThread);
        });

        const newComments = latestOwnIndex === -1
            ? comments
            : comments.slice(latestOwnIndex + 1);
        return newComments.some((comment) => {
            if (hasActionableCurrentUserMention(comment, currentUser)) {
                return true;
            }
            const key = getParticipationThreadKey(comment);
            const participation = threadParticipation.get(key);
            return Boolean(participation?.own || participation?.mentioned);
        });
    }

    function isNotificationDirectedAtCurrentUser(notification, options = {}) {
        const currentUser = normalizeLogin(options.currentUserLogin);
        if (!currentUser) {
            return false;
        }

        const comments = sortComments(options.comments || []);
        if (!comments.length) {
            return false;
        }

        const lastReadAt = Date.parse(options.lastReadAt || notification.last_read_at || '');
        const suppressParticipationReplies = Boolean(options.suppressParticipationReplies);
        const isUnread = (comment) => {
            const timestamp = getCommentTimestampMs(comment);
            return Number.isNaN(lastReadAt) || timestamp > lastReadAt;
        };
        const latestCloseEventMs = isClosedOrMergedNotification(notification)
            ? getLatestCloseEventTimestampMs(options.stateEvents || options.events || [])
            : null;
        if (isClosedOrMergedNotification(notification) && latestCloseEventMs === null) {
            return false;
        }
        const isAfterCloseEvent = (comment) => {
            if (latestCloseEventMs === null) {
                return true;
            }
            return getCommentTimestampMs(comment) > latestCloseEventMs;
        };
        const isInterestingUnreadComment = (comment) => isUnread(comment) &&
            !isUninterestingComment(comment) &&
            isAfterCloseEvent(comment);

        if (
            getDirectReviewThreadReplies(comments, currentUser)
                .some(isInterestingUnreadComment)
        ) {
            return true;
        }

        const hasUnreadCommentFromOtherUser = comments.some((comment) => {
            if (!isInterestingUnreadComment(comment)) {
                return false;
            }
            const author = normalizeLogin(comment?.user?.login);
            return author && author !== currentUser;
        });

        const notificationReason = String(notification.reason || '').toLowerCase();
        const notificationAuthor = normalizeLogin(options.authorLogin);
        if (
            (notification.subject?.type === 'Issue' ||
                notification.subject?.type === 'PullRequest') &&
            (notificationReason === 'author' || notificationAuthor === currentUser) &&
            hasUnreadCommentFromOtherUser &&
            !suppressParticipationReplies
        ) {
            return true;
        }

        return comments.some((comment, index) => {
            if (!isInterestingUnreadComment(comment)) {
                return false;
            }
            if (hasActionableCurrentUserMention(comment, currentUser)) {
                return true;
            }
            if (notification.subject?.type !== 'Issue') {
                return false;
            }
            if (!isMainThreadComment(comment)) {
                return false;
            }
            if (suppressParticipationReplies) {
                return false;
            }
            const author = normalizeLogin(comment?.user?.login);
            if (!author || author === currentUser) {
                return false;
            }
            const previousMainThreadComment = comments
                .slice(0, index)
                .reverse()
                .find(isMainThreadComment);
            const previousAuthor = normalizeLogin(previousMainThreadComment?.user?.login);
            return previousAuthor === currentUser;
        });
    }

    function isRevertRelated(body) {
        return /\brevert(ed|ing)?\b/i.test(body) || /\brollback\b/i.test(body);
    }

    function isBotAuthor(login) {
        if (!login) {
            return false;
        }
        const normalized = normalizeLogin(login);
        if (normalized.endsWith('[bot]')) {
            return true;
        }
        const knownBots = new Set([
            'dr-ci',
            'dr-ci-bot',
            'bors',
            'homu',
            'mergify',
            'pytorchbot',
            'pytorchmergebot',
            'pytorch-bot',
            'htmlpurifierbot',
            'github-actions',
            'dependabot',
            'dependabot-preview',
        ]);
        return knownBots.has(normalized);
    }

    function isBotInteractionComment(body) {
        const lines = String(body || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length === 0) {
            return false;
        }
        const commandPattern =
            '(?:label|unlabel|merge|close|reopen|rebase|retry|rerun|retest|backport|cherry-pick|assign|unassign|cc|triage|priority|kind|lgtm|r\\+)';
        const patterns = [
            new RegExp(`^/(?:${commandPattern})(?:\\s|$)`, 'i'),
            new RegExp(
                `^@?[\\w-]*bot\\b\\s+(?:${commandPattern})(?:\\s|$)`,
                'i'
            ),
            /^bors\b/i,
            /^@?bors\b/i,
            /^@?homu\b/i,
            /^@?mergify\b/i,
            /^@?dr[-.\s]?ci\b/i,
            /^r\+$/i,
        ];
        return lines.every((line) => patterns.some((pattern) => pattern.test(line)));
    }

    function isUninterestingComment(comment) {
        const body = String(comment?.body || '');
        if (isRevertRelated(body)) {
            return false;
        }
        const author = comment?.user?.login || '';
        if (isBotAuthor(author)) {
            return true;
        }
        return isBotInteractionComment(body);
    }

    function areCommentsOnlyByCurrentUserOrBots(comments, currentUserLogin) {
        const login = normalizeLogin(currentUserLogin);
        if (!login || !Array.isArray(comments) || comments.length === 0) {
            return false;
        }
        return comments.every((comment) => {
            const author = normalizeLogin(comment?.user?.login);
            return author === login ||
                isBotAuthor(author) ||
                isBotInteractionComment(comment?.body || '');
        });
    }

    function getUninterestingReason(notification, options = {}) {
        const comments = Array.isArray(options.comments) ? options.comments : [];
        const currentUserLogin = options.currentUserLogin;
        if (
            notification.subject?.type === 'PullRequest' &&
            comments.length > 0 &&
            areCommentsOnlyByCurrentUserOrBots(comments, currentUserLogin)
        ) {
            return 'own-or-bot-only';
        }
        if (
            notification.subject?.type === 'PullRequest' &&
            getDirectReviewThreadReplies(comments, currentUserLogin).length > 0
        ) {
            return null;
        }
        const filteredComments = filterRelevantCommentsForNotification(
            notification,
            comments,
            currentUserLogin
        );

        if (notification.subject?.type === 'PullRequest') {
            if (options.isApproved) {
                return null;
            }
            if (filteredComments.length === 0) {
                return null;
            }
        }

        if (filteredComments.length === 0) {
            return 'no-comments';
        }

        const allBotAuthors = filteredComments.every((comment) =>
            isBotAuthor(comment?.user?.login || '')
        );
        if (allBotAuthors) {
            return 'bot-only';
        }

        const allBotCommands = filteredComments.every((comment) =>
            isBotInteractionComment(comment?.body || '')
        );
        if (allBotCommands) {
            return 'bot-commands';
        }

        if (filteredComments.every(isUninterestingComment)) {
            return 'bot-only';
        }

        return null;
    }

    function isNotificationUninteresting(notification, options = {}) {
        const comments = Array.isArray(options.comments) ? options.comments : [];
        if (
            notification.subject?.type === 'PullRequest' &&
            comments.length > 0 &&
            areCommentsOnlyByCurrentUserOrBots(comments, options.currentUserLogin)
        ) {
            return true;
        }
        if (
            notification.subject?.type === 'PullRequest' &&
            getDirectReviewThreadReplies(comments, options.currentUserLogin).length > 0
        ) {
            return false;
        }
        if (notification.subject?.type === 'PullRequest') {
            if (options.isApproved) {
                return false;
            }
            if (comments.length === 0) {
                return false;
            }
        } else if (comments.length === 0) {
            return true;
        }
        return comments.every(isUninterestingComment);
    }

    return {
        areCommentsOnlyByCurrentUserOrBots,
        filterCommentsAfterOwnComment,
        filterRelevantCommentsForNotification,
        getCommentTimestampMs,
        getDirectReviewThreadReplies,
        getLatestCloseEventTimestampMs,
        getParticipationThreadKey,
        getReviewThreadKey,
        getUninterestingReason,
        hasActionableCurrentUserMention,
        isBotAuthor,
        isBotInteractionComment,
        isClosedOrMergedNotification,
        isClosingStateEvent,
        isCurrentUserCcLine,
        isMainThreadComment,
        isNotificationDirectedAtCurrentUser,
        isNotificationForCurrentUser,
        isNotificationUninteresting,
        isRevertRelated,
        isUninterestingComment,
        mentionsCurrentUser,
        sortComments,
    };
});
