// notifications-comments.js
// Comment prefetching, caching, classification, and display logic
// This module expects the following globals from notifications-*.js:
//   state, getNotificationKey, getIssueNumber, parseRepoInput,
//   showStatus, refreshRateLimit, updateGraphqlRateLimit, setGraphqlRateLimitError,
//   render, escapeHtml, renderMarkdown, fetchJson

const COMMENT_CACHE_KEY = 'ghnotif_bulk_comment_cache_v1';
const COMMENT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const COMMENT_CONCURRENCY = 8;
const REVIEW_DECISION_BATCH_SIZE = 40;
const COMMENT_EXPAND_ISSUES_KEY = 'ghnotif_comment_expand_issues';
const COMMENT_EXPAND_PRS_KEY = 'ghnotif_comment_expand_prs';
const COMMENT_HIDE_UNINTERESTING_KEY = 'ghnotif_comment_hide_uninteresting';
const COMMENT_AGE_FILTER_KEY = 'ghnotif_comment_age_filter';
const PREFETCH_STATUS_REFRESH_MS = 750;
const PREFETCH_STATUS_IDLE_CLEAR_MS = 1200;

function canUpdateCommentPrefetchStatus() {
    return !state.statusState || state.statusState.type === 'info';
}

function clearCommentPrefetchStatusTimers() {
    if (state.commentPrefetchStatusTimer) {
        clearTimeout(state.commentPrefetchStatusTimer);
        state.commentPrefetchStatusTimer = null;
    }
}

function clearCommentPrefetchIdleTimer() {
    if (state.commentPrefetchIdleTimer) {
        clearTimeout(state.commentPrefetchIdleTimer);
        state.commentPrefetchIdleTimer = null;
    }
}

function updateCommentPrefetchStatus(message, { force = false } = {}) {
    if (!canUpdateCommentPrefetchStatus()) {
        return;
    }
    clearCommentPrefetchIdleTimer();
    state.commentPrefetchStatusMessage = message;
    const now = Date.now();
    const elapsed = now - (state.commentPrefetchStatusLastUpdate || 0);
    const shouldUpdate = force || elapsed >= PREFETCH_STATUS_REFRESH_MS;
    if (shouldUpdate) {
        clearCommentPrefetchStatusTimers();
        state.commentPrefetchStatusLastUpdate = now;
        state.commentPrefetchStatusActive = true;
        showStatus(message, 'info');
        return;
    }
    if (!state.commentPrefetchStatusTimer) {
        state.commentPrefetchStatusTimer = setTimeout(() => {
            state.commentPrefetchStatusTimer = null;
            if (!state.commentPrefetchStatusMessage || !canUpdateCommentPrefetchStatus()) {
                return;
            }
            state.commentPrefetchStatusLastUpdate = Date.now();
            state.commentPrefetchStatusActive = true;
            showStatus(state.commentPrefetchStatusMessage, 'info');
        }, PREFETCH_STATUS_REFRESH_MS - elapsed);
    }
}

function scheduleCommentPrefetchIdleClear() {
    const progress = state.commentPrefetchProgress;
    if (!progress?.active) {
        return;
    }
    clearCommentPrefetchStatusTimers();
    clearCommentPrefetchIdleTimer();
    state.commentPrefetchIdleTimer = setTimeout(() => {
        state.commentPrefetchIdleTimer = null;
        state.commentPrefetchStatusActive = false;
        state.commentPrefetchStatusMessage = null;
        state.commentPrefetchStatusLastUpdate = 0;
        state.commentPrefetchProgress = {
            active: false,
            total: 0,
            completed: 0,
            failed: 0,
            inFlight: 0,
            concurrency: COMMENT_CONCURRENCY,
        };
        render();
    }, PREFETCH_STATUS_REFRESH_MS);
}

function ensureCommentPrefetchProgress() {
    const existing = state.commentPrefetchProgress;
    if (existing?.active) {
        existing.concurrency = COMMENT_CONCURRENCY;
        return existing;
    }
    state.commentPrefetchProgress = {
        active: true,
        total: 0,
        completed: 0,
        failed: 0,
        inFlight: 0,
        concurrency: COMMENT_CONCURRENCY,
    };
    return state.commentPrefetchProgress;
}

function addCommentPrefetchWork(count) {
    if (count <= 0) {
        return;
    }
    clearCommentPrefetchIdleTimer();
    const progress = ensureCommentPrefetchProgress();
    progress.total += count;
    render();
}

function updateCommentPrefetchWork({ completed = 0, failed = 0, inFlight = 0 } = {}) {
    const progress = ensureCommentPrefetchProgress();
    progress.completed += completed;
    progress.failed += failed;
    progress.inFlight = Math.max(0, progress.inFlight + inFlight);
    render();
}

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

function isAuthorPermissionFresh(cached) {
    if (!cached || !Object.prototype.hasOwnProperty.call(cached, 'authorPermission')) {
        return false;
    }
    const fetchedAt = cached.authorPermissionFetchedAt || cached.fetchedAt;
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
    scheduleReviewDecisionPrefetch(notifications, {
        includeAuthorAssociation: true,
        includeAuthorPermission: true,
    });
    const pending = notifications.filter(shouldPrefetchNotificationComments);
    if (!pending.length) {
        return;
    }
    let queuedCount = 0;
    pending.forEach((notif) => {
        const key = getNotificationKey(notif);
        if (state.commentQueueKeys.has(key)) {
            return;
        }
        queuedCount += 1;
        state.commentQueueKeys.add(key);
        state.commentQueue.push(async () => {
            let failed = false;
            try {
                updateCommentPrefetchWork({ inFlight: 1 });
                await prefetchNotificationComments(notif);
            } catch (error) {
                failed = true;
                console.error('Comment prefetch failed:', error);
            } finally {
                updateCommentPrefetchWork({
                    completed: 1,
                    failed: failed ? 1 : 0,
                    inFlight: -1,
                });
                state.commentQueueKeys.delete(key);
            }
        });
    });
    addCommentPrefetchWork(queuedCount);
    runCommentQueue();
}

function scheduleSyncPageCommentPrefetch(notifications) {
    const stableNotifications = notifications.filter(
        (notif) => notif.subject?.anchor || notif.last_read_at
    );
    if (!stableNotifications.length) {
        return;
    }
    scheduleCommentPrefetch(stableNotifications);
}

async function runCommentQueue() {
    if (state.commentQueueRunning) {
        return;
    }
    state.commentQueueRunning = true;
    while (state.commentQueue.length) {
        const batch = state.commentQueue.splice(0, COMMENT_CONCURRENCY);
        await Promise.all(batch.map((task) => task()));
        saveCommentCache();
        render();
    }
    await refreshRateLimit();
    state.commentQueueRunning = false;
    if (state.commentQueue.length) {
        runCommentQueue();
        return;
    }
    scheduleCommentPrefetchIdleClear();
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

// Extract the comment ID and type from an anchor like "issuecomment-12345" or "discussion_r12345"
function extractCommentIdFromAnchor(anchor) {
    if (!anchor) {
        return null;
    }
    // Handle "issuecomment-12345" format
    const issueMatch = anchor.match(/^issuecomment-(\d+)$/);
    if (issueMatch) {
        return { id: parseInt(issueMatch[1], 10), type: 'issue' };
    }
    // Handle "discussion_r12345" format (discussion comments)
    const discussionMatch = anchor.match(/^discussion_r(\d+)$/);
    if (discussionMatch) {
        return { id: parseInt(discussionMatch[1], 10), type: 'discussion' };
    }
    // Handle "pullrequestreview-12345" format (PR review, not individual comment)
    const reviewMatch = anchor.match(/^pullrequestreview-(\d+)$/);
    if (reviewMatch) {
        return { id: parseInt(reviewMatch[1], 10), type: 'review' };
    }
    // Handle "r12345" format (PR review comments on the diff)
    const reviewCommentMatch = anchor.match(/^r(\d+)$/);
    if (reviewCommentMatch) {
        return { id: parseInt(reviewCommentMatch[1], 10), type: 'review_comment' };
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

async function fetchAllIssueComments(repo, issueNumber, options = {}) {
    const isPR = Boolean(options.isPR);
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

    // For PRs, also fetch review comments (comments on the diff)
    if (isPR) {
        const reviewCommentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${issueNumber}/comments`;
        try {
            const reviewComments = await fetchJson(reviewCommentUrl);
            if (Array.isArray(reviewComments)) {
                // Mark these as review comments and add file context
                reviewComments.forEach((rc) => {
                    rc.isReviewComment = true;
                });
                comments.push(...reviewComments);
            }
        } catch (error) {
            console.error('Failed to fetch PR review comments:', error);
        }
    }

    // Sort all comments by created_at chronologically
    comments.sort((a, b) => {
        const dateA = new Date(a.created_at || 0);
        const dateB = new Date(b.created_at || 0);
        return dateA - dateB;
    });

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

function setAuthorPermissionCache(notification, authorPermission) {
    const threadId = getNotificationKey(notification);
    const existing = state.commentCache.threads[threadId] || {};
    state.commentCache.threads[threadId] = {
        ...existing,
        notificationUpdatedAt: notification.updated_at || existing.notificationUpdatedAt,
        authorPermission,
        authorPermissionFetchedAt: new Date().toISOString(),
    };
}

async function fetchAuthorPermission(repo, login) {
    const url =
        `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}` +
        `/collaborators/${encodeURIComponent(login)}/permission`;
    const payload = await fetchJson(url);
    return payload?.permission || payload?.role_name || null;
}

async function prefetchAuthorPermissions(repo, notifications) {
    const loginToNotifications = new Map();
    notifications.forEach((notif) => {
        const cached = state.commentCache.threads[getNotificationKey(notif)];
        if (!cached || isAuthorPermissionFresh(cached)) {
            return;
        }
        const login = String(cached.authorLogin || '').trim();
        if (!login) {
            return;
        }
        const existing = loginToNotifications.get(login) || [];
        existing.push(notif);
        loginToNotifications.set(login, existing);
    });
    if (!loginToNotifications.size) {
        return;
    }
    await Promise.all(
        Array.from(loginToNotifications.entries()).map(async ([login, loginNotifications]) => {
            try {
                const permission = await fetchAuthorPermission(repo, login);
                loginNotifications.forEach((notif) => {
                    setAuthorPermissionCache(notif, permission);
                });
            } catch (error) {
                console.error(`Failed to fetch permission for ${login}:`, error);
            }
        })
    );
}

async function prefetchReviewDecisions(repo, notifications, options = {}) {
    const includeAuthorAssociation = Boolean(options.includeAuthorAssociation);
    const includeAuthorPermission = Boolean(options.includeAuthorPermission);
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
            if (includeAuthorPermission) {
                await prefetchAuthorPermissions(repo, notifications);
            }
        }
        setGraphqlRateLimitError(null);
    } catch (error) {
        setGraphqlRateLimitError(error.message || String(error));
    }
}

function scheduleReviewDecisionPrefetch(notifications, options = {}) {
    const force = Boolean(options.force);
    const includeAuthorAssociation = Boolean(options.includeAuthorAssociation);
    const includeAuthorPermission = Boolean(options.includeAuthorPermission);
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
            const needsAuthorPermission =
                includeAuthorPermission && !isAuthorPermissionFresh(cached);
            const needsAuthorLogin = !isAuthorLoginFresh(cached);
            const needsDiffstat = !isDiffstatFresh(cached);
            return (
                needsReviewDecision ||
                needsAuthorAssociation ||
                needsAuthorPermission ||
                needsAuthorLogin ||
                needsDiffstat
            );
        });
    if (!pending.length) {
        return;
    }
    if (force) {
        prefetchReviewDecisions(repo, pending, { includeAuthorAssociation, includeAuthorPermission })
            .then(() => {
                saveCommentCache();
                render();
            })
            .catch((error) => {
                console.error('Review metadata prefetch failed:', error);
        });
        return;
    }
    state.commentQueue.push(() =>
        prefetchReviewDecisions(repo, pending, { includeAuthorAssociation, includeAuthorPermission })
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
    const existingAuthorPermission = cached?.authorPermission;
    const existingAuthorPermissionFetchedAt = cached?.authorPermissionFetchedAt;
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
            authorLogin: existingAuthorLogin,
            authorLoginFetchedAt: existingAuthorLoginFetchedAt,
            authorAssociation: existingAuthorAssociation,
            authorAssociationFetchedAt: existingAuthorAssociationFetchedAt,
            authorPermission: existingAuthorPermission,
            authorPermissionFetchedAt: existingAuthorPermissionFetchedAt,
            ...existingDiffstat,
        };
        return;
    }

    try {
        const repo = parseRepoInput(state.repo || '');
        if (!repo) {
            throw new Error('Missing repository input.');
        }

        const isPR = notification.subject?.type === 'PullRequest';
        let comments = [];
        let allComments = false;

        // If we have an anchor, always fetch all and filter client-side
        // If we have last_read_at (but no anchor), use it as a server-side filter
        // If neither, fetch all comments
        if (anchor) {
            // Anchor-based: fetch all, filter client-side
            allComments = true;
            comments = await fetchAllIssueComments(repo, issueNumber, { isPR });
        } else if (lastReadAt) {
            // Fallback: use last_read_at as server-side filter
            let commentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}/comments`;
            commentUrl += `?since=${encodeURIComponent(lastReadAt)}`;
            comments = await fetchJson(commentUrl);

            // For PRs, also fetch review comments with since filter
            if (isPR) {
                try {
                    let reviewCommentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${issueNumber}/comments`;
                    reviewCommentUrl += `?since=${encodeURIComponent(lastReadAt)}`;
                    const reviewComments = await fetchJson(reviewCommentUrl);
                    if (Array.isArray(reviewComments)) {
                        reviewComments.forEach((rc) => {
                            rc.isReviewComment = true;
                        });
                        comments.push(...reviewComments);
                        // Sort by created_at
                        comments.sort((a, b) => {
                            const dateA = new Date(a.created_at || 0);
                            const dateB = new Date(b.created_at || 0);
                            return dateA - dateB;
                        });
                    }
                } catch (error) {
                    console.error('Failed to fetch PR review comments:', error);
                }
            }
        } else {
            // No filter available - fetch all
            allComments = true;
            comments = await fetchAllIssueComments(repo, issueNumber, { isPR });
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
        if (existingAuthorPermission !== null && existingAuthorPermission !== undefined) {
            next.authorPermission = existingAuthorPermission;
            next.authorPermissionFetchedAt = existingAuthorPermissionFetchedAt;
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
        if (existingAuthorPermission !== null && existingAuthorPermission !== undefined) {
            next.authorPermission = existingAuthorPermission;
            next.authorPermissionFetchedAt = existingAuthorPermissionFetchedAt;
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
    const reason = getUninterestingReason(notification);
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
            className: 'uninteresting'
        };
    }
    const directReplies = getDirectReviewThreadReplies(unreadComments);
    if (directReplies.length > 0) {
        return {
            label: directReplies.length === 1 ? 'Reply to you' : `Replies to you (${directReplies.length})`,
            className: 'interesting',
        };
    }
    if (isNotificationNeedsReview(notification)) {
        return { label: 'Needs review', className: 'needs-review' };
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
    const anchorInfo = extractCommentIdFromAnchor(anchor);
    if (!anchorInfo) {
        // Anchor format not recognized, return all comments
        return comments;
    }
    const { id: anchorCommentId, type: anchorType } = anchorInfo;

    // Find the index of the anchor comment and return from there
    // Match based on both ID and type to handle mixed comment types
    const anchorIndex = comments.findIndex((comment) => {
        const commentId = typeof comment.id === 'number' ? comment.id : parseInt(comment.id, 10);
        if (commentId !== anchorCommentId) {
            return false;
        }
        // Check if comment type matches anchor type
        if (anchorType === 'review_comment' && comment.isReviewComment) {
            return true;
        }
        if (anchorType === 'issue' && !comment.isReviewComment && !comment.isIssue) {
            return true;
        }
        // For other types or if we can't determine, just match by ID
        return commentId === anchorCommentId;
    });
    if (anchorIndex === -1) {
        // Anchor comment not found - could be a review that's not in our comments list.
        // Return all comments.
        return comments;
    }
    return comments.slice(anchorIndex);
}

function isCommentTooOld(comment, ageFilter) {
    if (ageFilter === 'all') return false;

    const timestamp = comment.created_at || comment.updated_at;
    if (!timestamp) return false;

    const commentDate = new Date(timestamp);
    const now = new Date();
    const ageMs = now - commentDate;

    const thresholds = {
        '1day': 1 * 24 * 60 * 60 * 1000,
        '3days': 3 * 24 * 60 * 60 * 1000,
        '1week': 7 * 24 * 60 * 60 * 1000,
        '1month': 30 * 24 * 60 * 60 * 1000,
    };

    return ageMs > thresholds[ageFilter];
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
    const comments = filterRelevantCommentsForNotification(notification, unreadComments);
    const hasFilter = Boolean(anchor || cached.lastReadAt);
    if (comments.length === 0) {
        const label = hasFilter ? 'No unread comments found.' : 'No comments found.';
        return `<li class="comment-item">${label}</li>`;
    }
    const visibleComments = state.commentHideUninteresting
        ? comments.filter((comment) => !isUninterestingComment(comment))
        : comments;
    // Apply age filter
    const ageFilteredComments = visibleComments.filter(
        (comment) => !isCommentTooOld(comment, state.commentAgeFilter)
    );
    if (ageFilteredComments.length === 0) {
        if (visibleComments.length > 0) {
            return '<li class="comment-item">All comments filtered by age.</li>';
        }
        return '<li class="comment-item">No interesting unread comments found.</li>';
    }
    return ageFilteredComments
        .map((comment) => {
            const author = comment.user?.login || 'unknown';
            const timestamp = comment.updated_at || comment.created_at || '';
            const bodyRaw = comment.body || '';
            const renderedBody = renderMarkdown(bodyRaw);

            // For review comments, show file path context
            let fileContext = '';
            if (comment.isReviewComment && comment.path) {
                const line = comment.line || comment.original_line || '';
                const lineInfo = line ? `:${line}` : '';
                fileContext = `<div class="comment-file-context">${escapeHtml(comment.path)}${lineInfo}</div>`;
            }

            return `
                <li class="comment-item${comment.isReviewComment ? ' review-comment' : ''}">
                    <div class="comment-meta">
                        <span>${escapeHtml(author)}</span>
                        <span>${escapeHtml(new Date(timestamp).toLocaleString())}</span>
                    </div>
                    ${fileContext}
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

function mentionsCurrentUser(text) {
    const login = String(state.currentUserLogin || '').trim();
    if (!login || !text) {
        return false;
    }
    const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, 'i');
    return pattern.test(String(text));
}

function getParticipationThreadKey(comment) {
    if (comment?.isReviewComment) {
        return `review:${getReviewThreadKey(comment) || comment.id || 'unknown'}`;
    }
    return 'conversation';
}

function getSortedNotificationComments(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error || !Array.isArray(cached.comments)) {
        return [];
    }
    return [...cached.comments].sort((a, b) => {
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

function isNotificationForCurrentUser(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }

    const currentUser = String(state.currentUserLogin || '').toLowerCase();
    if (!currentUser) {
        return String(notification.reason || '').toLowerCase() === 'mention';
    }

    const cached = state.commentCache.threads[getNotificationKey(notification)];
    const authorLogin = String(cached?.authorLogin || '').toLowerCase();
    if (
        authorLogin === currentUser ||
        String(notification.reason || '').toLowerCase() === 'author'
    ) {
        return true;
    }

    if (String(notification.reason || '').toLowerCase() === 'mention') {
        return true;
    }

    const comments = getSortedNotificationComments(notification);
    if (!comments.length) {
        return false;
    }

    let latestOwnIndex = -1;
    comments.forEach((comment, index) => {
        const author = String(comment?.user?.login || '').toLowerCase();
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
            const author = String(comment?.user?.login || '').toLowerCase();
            if (author === currentUser) {
                stateForThread.own = true;
            }
            if (mentionsCurrentUser(comment?.body || '')) {
                stateForThread.mentioned = true;
            }
        }
        threadParticipation.set(key, stateForThread);
    });

    const newComments = latestOwnIndex === -1
        ? comments
        : comments.slice(latestOwnIndex + 1);
    return newComments.some((comment) => {
        if (mentionsCurrentUser(comment?.body || '')) {
            return true;
        }
        const key = getParticipationThreadKey(comment);
        const participation = threadParticipation.get(key);
        return Boolean(participation?.own || participation?.mentioned);
    });
}

function isNotificationDirectedAtCurrentUser(notification) {
    const currentUser = String(state.currentUserLogin || '').toLowerCase();
    if (!currentUser) {
        return false;
    }

    const comments = getSortedNotificationComments(notification);
    if (!comments.length) {
        return false;
    }

    if (getDirectReviewThreadReplies(comments).length > 0) {
        return true;
    }

    const lastReadAt = Date.parse(
        notification.last_read_at ||
        state.commentCache.threads[getNotificationKey(notification)]?.lastReadAt ||
        ''
    );
    const hasUnreadCommentFromOtherUser = comments.some((comment) => {
        const timestamp = getCommentTimestampMs(comment);
        if (!Number.isNaN(lastReadAt) && timestamp <= lastReadAt) {
            return false;
        }
        const author = String(comment?.user?.login || '').toLowerCase();
        return author && author !== currentUser;
    });

    if (
        notification.subject?.type === 'Issue' &&
        String(notification.reason || '').toLowerCase() === 'author' &&
        hasUnreadCommentFromOtherUser
    ) {
        return true;
    }

    return comments.some((comment) => {
        const timestamp = getCommentTimestampMs(comment);
        if (!Number.isNaN(lastReadAt) && timestamp <= lastReadAt) {
            return false;
        }
        return mentionsCurrentUser(comment?.body || '');
    });
}

function getDirectReviewThreadReplies(comments) {
    const login = (state.currentUserLogin || '').toLowerCase();
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
            const author = String(comment?.user?.login || '').toLowerCase();
            if (author === login) {
                lastOwnIndex = index;
            }
        });
        if (lastOwnIndex === -1) {
            return;
        }
        thread.slice(lastOwnIndex + 1).forEach(({ comment }) => {
            const author = String(comment?.user?.login || '').toLowerCase();
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

function filterRelevantCommentsForNotification(notification, comments) {
    if (notification.subject?.type === 'PullRequest') {
        const directReplies = getDirectReviewThreadReplies(comments);
        if (directReplies.length > 0) {
            return directReplies;
        }
    }
    return filterCommentsAfterOwnComment(comments);
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
    if (notification.subject?.type === 'PullRequest' && comments.length > 0 && areCommentsOnlyByCurrentUserOrBots(comments)) {
        return true;
    }
    if (notification.subject?.type === 'PullRequest' && getDirectReviewThreadReplies(comments).length > 0) {
        return false;
    }
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

function getUninterestingReason(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return null;
    }
    const anchor = cached.anchor || notification.subject?.anchor || null;
    const rawComments = cached.comments || [];
    const comments = cached.allComments ? filterCommentsByAnchor(rawComments, anchor) : rawComments;
    if (notification.subject?.type === 'PullRequest' && comments.length > 0 && areCommentsOnlyByCurrentUserOrBots(comments)) {
        return 'own-or-bot-only';
    }
    if (notification.subject?.type === 'PullRequest' && getDirectReviewThreadReplies(comments).length > 0) {
        return null;
    }
    const filteredComments = filterRelevantCommentsForNotification(notification, comments);

    // Check PR-specific conditions
    if (notification.subject?.type === 'PullRequest') {
        if (isNotificationApproved(notification)) {
            return null; // Approved PRs are interesting
        }
        if (filteredComments.length === 0) {
            return null; // PRs with no comments show "Needs review" - not uninteresting
        }
    }

    // No comments case (for issues)
    if (filteredComments.length === 0) {
        return 'no-comments';
    }

    // Check if all comments are from bot authors
    const allBotAuthors = filteredComments.every(c => isBotAuthor(c?.user?.login || ''));
    if (allBotAuthors) {
        return 'bot-only';
    }

    // Check if all comments are bot interaction commands
    const allBotCommands = filteredComments.every(c => isBotInteractionComment(c?.body || ''));
    if (allBotCommands) {
        return 'bot-commands';
    }

    // General uninteresting check (mixed bot content)
    if (filteredComments.every(isUninterestingComment)) {
        return 'bot-only';
    }

    return null; // Has interesting content
}

function isNotificationNeedsReview(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const notifState = notification.subject?.state;
    if (notifState === 'draft' || notifState === 'closed' || notifState === 'merged') {
        return false;
    }
    if (!isNotificationReviewResponsibility(notification)) {
        return false;
    }
    if (isNotificationApproved(notification)) {
        return false;
    }
    if (isNotificationChangesRequested(notification)) {
        return false;
    }
    return true;
}

function isNotificationReviewResponsibility(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    if (notification.responsibility_source === 'review-requested') {
        return true;
    }
    return String(notification.reason || '').toLowerCase() === 'review_requested';
}

function isNotificationApproved(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const prState = notification.subject?.state;
    if (prState === 'draft' || prState === 'closed' || prState === 'merged') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    const decision = String(cached.reviewDecision || '').toUpperCase();
    return decision === 'APPROVED';
}

function isNotificationChangesRequested(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const prState = notification.subject?.state;
    if (prState === 'draft' || prState === 'closed' || prState === 'merged') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    const decision = String(cached.reviewDecision || '').toUpperCase();
    return decision === 'CHANGES_REQUESTED';
}

function isNotificationFromCommitter(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    const permission = String(cached.authorPermission || '').toLowerCase();
    return permission === 'write' || permission === 'admin';
}

function hasNotificationAuthorPermission(notification) {
    if (notification.subject?.type !== 'PullRequest') {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(cached, 'authorPermission');
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

function areCommentsOnlyByCurrentUserOrBots(comments) {
    const login = String(state.currentUserLogin || '').toLowerCase();
    if (!login || !Array.isArray(comments) || comments.length === 0) {
        return false;
    }
    return comments.every((comment) => {
        const author = String(comment?.user?.login || '').toLowerCase();
        return author === login ||
            isBotAuthor(author) ||
            isBotInteractionComment(comment?.body || '');
    });
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
