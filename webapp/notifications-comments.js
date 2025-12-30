// notifications-comments.js
// Comment prefetching, caching, classification, and display logic
// This module expects the following globals from notifications-*.js:
//   state, getNotificationKey, getIssueNumber, parseRepoInput,
//   showStatus, refreshRateLimit, updateGraphqlRateLimit, setGraphqlRateLimitError,
//   render, escapeHtml, renderMarkdown, fetchJson

const COMMENT_CACHE_KEY = 'ghnotif_bulk_comment_cache_v1';
const COMMENT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const COMMENT_CONCURRENCY = 4;
const REVIEW_DECISION_BATCH_SIZE = 40;
const COMMENT_EXPAND_ISSUES_KEY = 'ghnotif_comment_expand_issues';
const COMMENT_EXPAND_PRS_KEY = 'ghnotif_comment_expand_prs';
const COMMENT_HIDE_UNINTERESTING_KEY = 'ghnotif_comment_hide_uninteresting';

async function loadCommentCache() {
    try {
        const cached = await loadCommentCacheStorage();
        if (cached && typeof cached === 'object') {
            return cached;
        }
    } catch (e) {
        console.error('Failed to load comment cache from IndexedDB:', e);
    }
    const raw = localStorage.getItem(COMMENT_CACHE_KEY);
    if (!raw) {
        return { version: 1, threads: {} };
    }
    try {
        const parsed = JSON.parse(raw);
        await saveCommentCacheStorage(parsed);
        localStorage.removeItem(COMMENT_CACHE_KEY);
        return parsed;
    } catch (e) {
        console.error('Failed to parse comment cache:', e);
        return { version: 1, threads: {} };
    }
}

function saveCommentCache() {
    saveCommentCacheStorage(state.commentCache).catch((error) => {
        console.error('Failed to persist comment cache:', error);
    });
}

function isCommentCacheFresh(cached) {
    if (!cached?.fetchedAt) {
        return false;
    }
    const fetchedAtMs = Date.parse(cached.fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
        return false;
    }
    return Date.now() - fetchedAtMs < COMMENT_CACHE_TTL_MS;
}

function isReviewDecisionFresh(cached) {
    if (!cached || !Object.prototype.hasOwnProperty.call(cached, 'reviewDecision')) {
        return false;
    }
    const fetchedAt = cached.reviewDecisionFetchedAt || cached.fetchedAt;
    if (!fetchedAt) {
        return false;
    }
    const fetchedAtMs = Date.parse(fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
        return false;
    }
    return Date.now() - fetchedAtMs < COMMENT_CACHE_TTL_MS;
}

function isAuthorAssociationFresh(cached) {
    if (!cached || !Object.prototype.hasOwnProperty.call(cached, 'authorAssociation')) {
        return false;
    }
    const fetchedAt = cached.authorAssociationFetchedAt || cached.fetchedAt;
    if (!fetchedAt) {
        return false;
    }
    const fetchedAtMs = Date.parse(fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
        return false;
    }
    return Date.now() - fetchedAtMs < COMMENT_CACHE_TTL_MS;
}

function isAuthorLoginFresh(cached) {
    if (!cached || !Object.prototype.hasOwnProperty.call(cached, 'authorLogin')) {
        return false;
    }
    const fetchedAt = cached.authorLoginFetchedAt || cached.fetchedAt;
    if (!fetchedAt) {
        return false;
    }
    const fetchedAtMs = Date.parse(fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
        return false;
    }
    return Date.now() - fetchedAtMs < COMMENT_CACHE_TTL_MS;
}

function isDiffstatFresh(cached) {
    if (
        !cached ||
        !Object.prototype.hasOwnProperty.call(cached, 'additions') ||
        !Object.prototype.hasOwnProperty.call(cached, 'deletions')
    ) {
        return false;
    }
    const fetchedAt = cached.diffstatFetchedAt || cached.fetchedAt;
    if (!fetchedAt) {
        return false;
    }
    const fetchedAtMs = Date.parse(fetchedAt);
    if (Number.isNaN(fetchedAtMs)) {
        return false;
    }
    return Date.now() - fetchedAtMs < COMMENT_CACHE_TTL_MS;
}

function scheduleCommentPrefetch(notifications) {
    // Invariant: comment/review metadata prefetch happens immediately after sync.
    // UI filter changes should not trigger new prefetch work.
    scheduleReviewDecisionPrefetch(notifications, { includeAuthorAssociation: true });
    const pending = notifications.filter(shouldPrefetchNotificationComments);
    if (!pending.length) {
        return;
    }
    showStatus(
        `Prefetch: queued ${pending.length} notifications (concurrency ${COMMENT_CONCURRENCY})`,
        'info',
        { flash: true }
    );
    pending.forEach((notif) => {
        state.commentQueue.push(() => prefetchNotificationComments(notif));
    });
    runCommentQueue();
}

async function runCommentQueue() {
    if (state.commentQueueRunning) {
        return;
    }
    state.commentQueueRunning = true;
    showStatus(
        `Prefetch: starting ${state.commentQueue.length} requests`,
        'info',
        { flash: true }
    );
    while (state.commentQueue.length) {
        const batch = state.commentQueue.splice(0, COMMENT_CONCURRENCY);
        showStatus(
            `Prefetch: fetching ${batch.length} (remaining ${state.commentQueue.length})`,
            'info',
            { flash: true }
        );
        await Promise.all(batch.map((task) => task()));
        saveCommentCache();
        render();
    }
    await refreshRateLimit();
    state.commentQueueRunning = false;
    if (state.commentQueue.length) {
        runCommentQueue();
    }
}

function shouldPrefetchNotificationComments(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached) {
        return true;
    }
    if (cached.notificationUpdatedAt !== notification.updated_at) {
        return true;
    }
    if (!isCommentCacheFresh(cached)) {
        return true;
    }
    // Check if filter parameters match
    const anchor = notification.subject?.anchor || null;
    const lastReadAt = notification.last_read_at || null;
    const hasFilter = Boolean(anchor || lastReadAt);

    if (hasFilter) {
        // Re-fetch if anchor or lastReadAt changed
        // Normalize undefined to null for comparison
        const cachedAnchor = cached.anchor || null;
        const cachedLastReadAt = cached.lastReadAt || null;
        if (cachedAnchor !== anchor || cachedLastReadAt !== lastReadAt) {
            return true;
        }
    } else if (!cached.allComments) {
        // No filter but we don't have all comments
        return true;
    }
    return false;
}

// Extract the comment ID from an anchor like "issuecomment-12345" or "discussion_r12345"
function extractCommentIdFromAnchor(anchor) {
    if (!anchor) {
        return null;
    }
    // Handle "issuecomment-12345" format
    const issueMatch = anchor.match(/^issuecomment-(\d+)$/);
    if (issueMatch) {
        return parseInt(issueMatch[1], 10);
    }
    // Handle "discussion_r12345" format (discussion comments)
    const discussionMatch = anchor.match(/^discussion_r(\d+)$/);
    if (discussionMatch) {
        return parseInt(discussionMatch[1], 10);
    }
    // Handle "pullrequestreview-12345" format
    const reviewMatch = anchor.match(/^pullrequestreview-(\d+)$/);
    if (reviewMatch) {
        return parseInt(reviewMatch[1], 10);
    }
    return null;
}

function toIssueComment(issue) {
    if (!issue) {
        return null;
    }
    return {
        id: issue.id || `issue-${issue.number || 'unknown'}`,
        user: issue.user,
        body: issue.body ?? '',
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        isIssue: true,
    };
}

async function fetchAllIssueComments(repo, issueNumber) {
    const issueUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}`;
    let issue = null;
    try {
        issue = await fetchJson(issueUrl);
    } catch (error) {
        issue = null;
    }
    const commentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}/comments`;
    const commentPayload = await fetchJson(commentUrl);
    const comments = [];
    const issueComment = toIssueComment(issue);
    if (issueComment) {
        comments.push(issueComment);
    }
    if (Array.isArray(commentPayload)) {
        comments.push(...commentPayload);
    }
    return comments;
}

async function fetchGraphql(query, variables) {
    const response = await fetch('/github/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Request failed: /github/graphql (${response.status}) ${detail}`);
    }
    const payload = await response.json();
    if (payload?.data?.rateLimit) {
        updateGraphqlRateLimit(payload.data.rateLimit);
    } else if (payload?.extensions?.rateLimit) {
        updateGraphqlRateLimit(payload.extensions.rateLimit);
    }
    if (Array.isArray(payload?.errors) && payload.errors.length) {
        const messages = payload.errors
            .map((error) => error?.message)
            .filter(Boolean)
            .join('; ');
        throw new Error(messages || 'GraphQL request failed');
    }
    return payload.data;
}

function buildReviewDecisionQuery(issueNumbers) {
    const fields = issueNumbers
        .map(
            (issueNumber) =>
                `pr${issueNumber}: pullRequest(number: ${issueNumber}) { reviewDecision authorAssociation additions deletions changedFiles author { login } }`
        )
        .join('\n');
    return `
        query($owner: String!, $name: String!) {
            rateLimit {
                limit
                remaining
                resetAt
            }
            repository(owner: $owner, name: $name) {
                ${fields}
            }
        }
    `;
}

function setReviewDecisionCache(
    notification,
    reviewDecision,
    authorAssociation,
    authorLogin,
    options = {}
) {
    const includeAuthorAssociation = Boolean(options.includeAuthorAssociation);
    const threadId = getNotificationKey(notification);
    const existing = state.commentCache.threads[threadId] || {};
    const nowIso = new Date().toISOString();
    const next = {
        ...existing,
        notificationUpdatedAt: notification.updated_at || existing.notificationUpdatedAt,
        reviewDecision,
        reviewDecisionFetchedAt: nowIso,
        authorLogin,
        authorLoginFetchedAt: nowIso,
        diffstatFetchedAt: nowIso,
    };
    if (includeAuthorAssociation && authorAssociation !== null && authorAssociation !== undefined) {
        next.authorAssociation = authorAssociation;
        next.authorAssociationFetchedAt = nowIso;
    }
    state.commentCache.threads[threadId] = next;
}

async function prefetchReviewDecisions(repo, notifications, options = {}) {
    const includeAuthorAssociation = Boolean(options.includeAuthorAssociation);
    const issueNumbers = notifications
        .map((notif) => getIssueNumber(notif))
        .filter((issueNumber) => typeof issueNumber === 'number');
    if (!issueNumbers.length) {
        return;
    }
    const uniqueNumbers = Array.from(new Set(issueNumbers));
    try {
        for (let i = 0; i < uniqueNumbers.length; i += REVIEW_DECISION_BATCH_SIZE) {
            const batch = uniqueNumbers.slice(i, i + REVIEW_DECISION_BATCH_SIZE);
            const query = buildReviewDecisionQuery(batch);
            const data = await fetchGraphql(query, {
                owner: repo.owner,
                name: repo.repo,
            });
            const repoData = data?.repository || {};
            const decisions = new Map();
            batch.forEach((issueNumber) => {
                const entry = repoData[`pr${issueNumber}`];
                decisions.set(issueNumber, {
                    reviewDecision: entry?.reviewDecision ?? null,
                    authorAssociation: entry?.authorAssociation ?? null,
                    additions: entry?.additions ?? null,
                    deletions: entry?.deletions ?? null,
                    changedFiles: entry?.changedFiles ?? null,
                    authorLogin: entry?.author?.login ?? null,
                });
            });
            notifications.forEach((notif) => {
                const issueNumber = getIssueNumber(notif);
                if (!decisions.has(issueNumber)) {
                    return;
                }
                const entry = decisions.get(issueNumber);
                setReviewDecisionCache(
                    notif,
                    entry.reviewDecision,
                    entry.authorAssociation,
                    entry.authorLogin,
                    { includeAuthorAssociation }
                );
                const threadId = getNotificationKey(notif);
                state.commentCache.threads[threadId] = {
                    ...state.commentCache.threads[threadId],
                    additions: entry.additions,
                    deletions: entry.deletions,
                    changedFiles: entry.changedFiles,
                };
            });
        }
        setGraphqlRateLimitError(null);
    } catch (error) {
        setGraphqlRateLimitError(error.message || String(error));
    }
}

function scheduleReviewDecisionPrefetch(notifications, options = {}) {
    const force = Boolean(options.force);
    const includeAuthorAssociation = Boolean(options.includeAuthorAssociation);
    const repo = parseRepoInput(state.repo || state.lastSyncedRepo || '');
    if (!repo) {
        return;
    }
    const prNotifications = notifications.filter(
        (notif) => notif.subject?.type === 'PullRequest'
    );
    if (!prNotifications.length) {
        return;
    }
    const pending = force
        ? prNotifications
        : prNotifications.filter((notif) => {
            const cached = state.commentCache.threads[getNotificationKey(notif)];
            const needsReviewDecision = !isReviewDecisionFresh(cached);
            const needsAuthorAssociation =
                includeAuthorAssociation && !isAuthorAssociationFresh(cached);
            const needsAuthorLogin = !isAuthorLoginFresh(cached);
            const needsDiffstat = !isDiffstatFresh(cached);
            return (
                needsReviewDecision ||
                needsAuthorAssociation ||
                needsAuthorLogin ||
                needsDiffstat
            );
        });
    if (!pending.length) {
        return;
    }
    if (force) {
        showStatus(`Review metadata prefetch: fetching ${pending.length} PRs`, 'info', {
            autoDismiss: true,
        });
        prefetchReviewDecisions(repo, pending, { includeAuthorAssociation })
            .then(() => {
                saveCommentCache();
                render();
            })
            .catch((error) => {
                console.error('Review metadata prefetch failed:', error);
            });
        return;
    }
    showStatus(`Review metadata prefetch: queued ${pending.length} PRs`, 'info', {
        autoDismiss: true,
    });
    state.commentQueue.push(() =>
        prefetchReviewDecisions(repo, pending, { includeAuthorAssociation })
    );
    runCommentQueue();
}

async function prefetchNotificationComments(notification) {
    const threadId = getNotificationKey(notification);
    const cached = state.commentCache.threads[threadId];
    const existingReviewDecision = cached?.reviewDecision;
    const existingReviewDecisionFetchedAt = cached?.reviewDecisionFetchedAt;
    const existingAuthorLogin = cached?.authorLogin;
    const existingAuthorLoginFetchedAt = cached?.authorLoginFetchedAt;
    const existingAuthorAssociation = cached?.authorAssociation;
    const existingAuthorAssociationFetchedAt = cached?.authorAssociationFetchedAt;
    const existingDiffstat = {
        additions: cached?.additions,
        deletions: cached?.deletions,
        changedFiles: cached?.changedFiles,
        diffstatFetchedAt: cached?.diffstatFetchedAt,
    };

    // Determine if we have a useful filter: prefer anchor, fallback to last_read_at
    const anchor = notification.subject?.anchor || null;
    const lastReadAt = notification.last_read_at || null;
    const hasFilter = Boolean(anchor || lastReadAt);

    // Check if cache is still valid
    if (
        cached &&
        cached.notificationUpdatedAt === notification.updated_at &&
        isCommentCacheFresh(cached)
    ) {
        // If we have a filter, check if anchor/lastReadAt match
        // Normalize undefined to null for comparison
        if (hasFilter) {
            const cachedAnchor = cached.anchor || null;
            const cachedLastReadAt = cached.lastReadAt || null;
            if (cachedAnchor === anchor && cachedLastReadAt === lastReadAt) {
                return;
            }
        } else if (cached.allComments) {
            return;
        }
    }

    const issueNumber = getIssueNumber(notification);
    if (!issueNumber) {
        state.commentCache.threads[threadId] = {
            notificationUpdatedAt: notification.updated_at,
            comments: [],
            error: 'No issue number found.',
            fetchedAt: new Date().toISOString(),
            reviewDecision: existingReviewDecision,
            reviewDecisionFetchedAt: existingReviewDecisionFetchedAt,
            ...existingDiffstat,
        };
        return;
    }

    try {
        const repo = parseRepoInput(state.repo || '');
        if (!repo) {
            throw new Error('Missing repository input.');
        }

        let comments = [];
        let allComments = false;

        // If we have an anchor, always fetch all and filter client-side
        // If we have last_read_at (but no anchor), use it as a server-side filter
        // If neither, fetch all comments
        if (anchor) {
            // Anchor-based: fetch all, filter client-side
            allComments = true;
            comments = await fetchAllIssueComments(repo, issueNumber);
        } else if (lastReadAt) {
            // Fallback: use last_read_at as server-side filter
            let commentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}/comments`;
            commentUrl += `?since=${encodeURIComponent(lastReadAt)}`;
            comments = await fetchJson(commentUrl);
        } else {
            // No filter available - fetch all
            allComments = true;
            comments = await fetchAllIssueComments(repo, issueNumber);
        }

        const next = {
            notificationUpdatedAt: notification.updated_at,
            anchor,
            lastReadAt,
            unread: notification.unread,
            comments,
            allComments,
            fetchedAt: new Date().toISOString(),
            reviewDecision: existingReviewDecision,
            reviewDecisionFetchedAt: existingReviewDecisionFetchedAt,
            ...existingDiffstat,
        };
        if (existingAuthorLogin !== null && existingAuthorLogin !== undefined) {
            next.authorLogin = existingAuthorLogin;
            next.authorLoginFetchedAt = existingAuthorLoginFetchedAt;
        }
        if (existingAuthorAssociation !== null && existingAuthorAssociation !== undefined) {
            next.authorAssociation = existingAuthorAssociation;
            next.authorAssociationFetchedAt = existingAuthorAssociationFetchedAt;
        }
        state.commentCache.threads[threadId] = next;
    } catch (error) {
        const next = {
            notificationUpdatedAt: notification.updated_at,
            comments: [],
            allComments: !hasFilter,
            error: error.message || String(error),
            fetchedAt: new Date().toISOString(),
            reviewDecision: existingReviewDecision,
            reviewDecisionFetchedAt: existingReviewDecisionFetchedAt,
            ...existingDiffstat,
        };
        if (existingAuthorLogin !== null && existingAuthorLogin !== undefined) {
            next.authorLogin = existingAuthorLogin;
            next.authorLoginFetchedAt = existingAuthorLoginFetchedAt;
        }
        if (existingAuthorAssociation !== null && existingAuthorAssociation !== undefined) {
            next.authorAssociation = existingAuthorAssociation;
            next.authorAssociationFetchedAt = existingAuthorAssociationFetchedAt;
        }
        state.commentCache.threads[threadId] = next;
    }
}

function getCommentStatus(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached) {
        return { label: 'Comments: pending', className: 'pending' };
    }
    if (cached.error) {
        return { label: 'Comments: error', className: 'error' };
    }
    // Use anchor-filtered count for display (only if we have all comments)
    // If comments were already filtered server-side (via last_read_at), use as-is
    const anchor = cached.anchor || notification.subject?.anchor || null;
    const comments = cached.comments || [];
    const unreadComments = cached.allComments ? filterCommentsByAnchor(comments, anchor) : comments;
    const count = unreadComments.length;
    if (isNotificationApproved(notification)) {
        return { label: 'Approved', className: 'approved' };
    }
    if (isNotificationNeedsReview(notification)) {
        return { label: 'Needs review', className: 'needs-review' };
    }
    if (count === 0) {
        return { label: 'Uninteresting (0)', className: 'uninteresting' };
    }
    if (isNotificationUninteresting(notification)) {
        return { label: `Uninteresting (${count})`, className: 'uninteresting' };
    }
    return { label: `Interesting (${count})`, className: 'interesting' };
}

function getDiffstatInfo(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return null;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || !isDiffstatFresh(cached)) {
        return null;
    }
    const additions = cached.additions;
    const deletions = cached.deletions;
    if (typeof additions !== 'number' || typeof deletions !== 'number') {
        return null;
    }
    const total = additions + deletions;
    const changedFiles =
        typeof cached.changedFiles === 'number' ? cached.changedFiles : null;
    let title = `Changes: ${total} (+${additions}/-${deletions})`;
    if (changedFiles !== null) {
        title += `, files: ${changedFiles}`;
    }
    return {
        additions,
        deletions,
        changedFiles,
        total,
        title,
    };
}

// Filter comments to only show those at or after the anchor (first unread)
function filterCommentsByAnchor(comments, anchor) {
    if (!anchor || !comments || comments.length === 0) {
        return comments;
    }
    const anchorCommentId = extractCommentIdFromAnchor(anchor);
    if (!anchorCommentId) {
        // Anchor format not recognized, return all comments
        return comments;
    }
    // Find the index of the anchor comment and return from there
    const anchorIndex = comments.findIndex((comment) => {
        const commentId = typeof comment.id === 'number' ? comment.id : parseInt(comment.id, 10);
        return commentId === anchorCommentId;
    });
    if (anchorIndex === -1) {
        // Anchor comment not found - this could happen if the anchor points to
        // a review comment (not an issue comment). Return all comments.
        return comments;
    }
    return comments.slice(anchorIndex);
}

function getCommentItems(notification) {
    const isIssue = notification.subject?.type === 'Issue';
    const isPR = notification.subject?.type === 'PullRequest';
    const shouldExpand = (isIssue && state.commentExpandIssues) || (isPR && state.commentExpandPrs);
    if (!shouldExpand) {
        return '';
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached) {
        return '<li class="comment-item">Comments: pending...</li>';
    }
    if (cached.error) {
        return `<li class="comment-item">Comments error: ${escapeHtml(cached.error)}</li>`;
    }
    // Filter by anchor first (only if we have all comments), then by own comment
    // If comments were already filtered server-side (via last_read_at), use as-is
    const anchor = cached.anchor || notification.subject?.anchor || null;
    const rawComments = cached.comments || [];
    const unreadComments = cached.allComments ? filterCommentsByAnchor(rawComments, anchor) : rawComments;
    const comments = filterCommentsAfterOwnComment(unreadComments);
    const hasFilter = Boolean(anchor || cached.lastReadAt);
    if (comments.length === 0) {
        const label = hasFilter ? 'No unread comments found.' : 'No comments found.';
        return `<li class="comment-item">${label}</li>`;
    }
    const visibleComments = state.commentHideUninteresting
        ? comments.filter((comment) => !isUninterestingComment(comment))
        : comments;
    if (visibleComments.length === 0) {
        return '<li class="comment-item">No interesting unread comments found.</li>';
    }
    return visibleComments
        .map((comment) => {
            const author = comment.user?.login || 'unknown';
            const timestamp = comment.updated_at || comment.created_at || '';
            const bodyRaw = comment.body || '';
            const renderedBody = renderMarkdown(bodyRaw);
            return `
                <li class="comment-item">
                    <div class="comment-meta">
                        <span>${escapeHtml(author)}</span>
                        <span>${escapeHtml(new Date(timestamp).toLocaleString())}</span>
                    </div>
                    <div class="comment-body markdown-body">${renderedBody}</div>
                </li>
            `;
        })
        .join('');
}

function filterCommentsAfterOwnComment(comments) {
    const login = (state.currentUserLogin || '').toLowerCase();
    if (!login) {
        return comments;
    }
    let lastOwnIndex = -1;
    for (let i = 0; i < comments.length; i += 1) {
        const author = String(comments[i]?.user?.login || '').toLowerCase();
        if (author === login) {
            lastOwnIndex = i;
        }
    }
    return lastOwnIndex === -1 ? comments : comments.slice(lastOwnIndex + 1);
}

function isNotificationUninteresting(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    // Use anchor-filtered comments (only if we have all comments)
    // If comments were already filtered server-side (via last_read_at), use as-is
    const anchor = cached.anchor || notification.subject?.anchor || null;
    const rawComments = cached.comments || [];
    const comments = cached.allComments ? filterCommentsByAnchor(rawComments, anchor) : rawComments;
    if (notification.subject?.type === 'PullRequest') {
        if (isNotificationApproved(notification)) {
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

function isNotificationNeedsReview(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const notifState = notification.subject?.state;
    if (notifState === 'draft' || notifState === 'closed' || notifState === 'merged') {
        return false;
    }
    if (isNotificationApproved(notification)) {
        return false;
    }
    return true;
}

function isNotificationApproved(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    if (notification.subject?.state === 'draft') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    const decision = String(cached.reviewDecision || '').toUpperCase();
    return decision === 'APPROVED';
}

function isNotificationFromCommitter(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    const association = String(cached.authorAssociation || '').toUpperCase();
    const committerAssociations = new Set(['COLLABORATOR', 'MEMBER', 'OWNER']);
    return committerAssociations.has(association);
}

function hasNotificationAuthorAssociation(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(cached, 'authorAssociation');
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

function isRevertRelated(body) {
    return /\brevert(ed|ing)?\b/i.test(body) || /\brollback\b/i.test(body);
}

function isBotAuthor(login) {
    if (!login) {
        return false;
    }
    const normalized = login.toLowerCase();
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
