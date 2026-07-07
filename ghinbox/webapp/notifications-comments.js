// notifications-comments.js
// Comment prefetching, caching, classification, and display logic
// This module expects the following globals from notifications-*.js:
//   state, getNotificationKey, getIssueNumber, parseRepoInput,
//   showStatus, refreshRateLimit, updateGraphqlRateLimit, setGraphqlRateLimitError,
//   render, escapeHtml, renderMarkdown, fetchJson, fetchGraphql

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
const COMMENT_INTEREST = globalThis.GhinboxCommentInterest;
const COMMENT_WINDOW = globalThis.GhinboxCommentWindow;
const COMMENT_STATUS = globalThis.GhinboxCommentStatus;
const COMMENT_CACHE_POLICY = globalThis.GhinboxCommentCachePolicy;

function canUpdateCommentPrefetchStatus() {
    return !state.statusState || state.statusState.type === 'info';
}

function formatCommentPrefetchProgressMessage() {
    const progress = state.commentPrefetchProgress;
    if (!progress?.active || progress.total <= 0) {
        return '';
    }
    const processed = progress.completed + progress.failed;
    const active = progress.inFlight;
    return (
        `Fetching comments ${processed}/${progress.total}` +
        (active > 0 ? ` (${active} active)` : '')
    );
}

function getCommentPrefetchStatusDisplayMessage(message) {
    const base = state.lastPersistentStatus;
    if (!base || base.type !== 'info' || !base.message || base.message === message) {
        return message;
    }
    if (base.message.includes('Fetching comments')) {
        return message;
    }
    return `${base.message}\n${message}`;
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
    const statusMessage = getCommentPrefetchStatusDisplayMessage(message);
    const now = Date.now();
    const elapsed = now - (state.commentPrefetchStatusLastUpdate || 0);
    const shouldUpdate = force || elapsed >= PREFETCH_STATUS_REFRESH_MS;
    if (shouldUpdate) {
        clearCommentPrefetchStatusTimers();
        state.commentPrefetchStatusLastUpdate = now;
        showStatus(statusMessage, 'info', {
            flash: true,
            durationMs: PREFETCH_STATUS_REFRESH_MS + PREFETCH_STATUS_IDLE_CLEAR_MS,
        });
        return;
    }
    if (!state.commentPrefetchStatusTimer) {
        state.commentPrefetchStatusTimer = setTimeout(() => {
            state.commentPrefetchStatusTimer = null;
            if (!state.commentPrefetchStatusMessage || !canUpdateCommentPrefetchStatus()) {
                return;
            }
            state.commentPrefetchStatusLastUpdate = Date.now();
            showStatus(
                getCommentPrefetchStatusDisplayMessage(state.commentPrefetchStatusMessage),
                'info',
                {
                    flash: true,
                    durationMs: PREFETCH_STATUS_REFRESH_MS + PREFETCH_STATUS_IDLE_CLEAR_MS,
                }
            );
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
    updateCommentPrefetchStatus(formatCommentPrefetchProgressMessage(), { force: true });
    render();
}

function updateCommentPrefetchWork({ completed = 0, failed = 0, inFlight = 0 } = {}) {
    const progress = ensureCommentPrefetchProgress();
    progress.completed += completed;
    progress.failed += failed;
    progress.inFlight = Math.max(0, progress.inFlight + inFlight);
    updateCommentPrefetchStatus(formatCommentPrefetchProgressMessage());
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
    return COMMENT_CACHE_POLICY.isCommentCacheFresh(cached, { ttlMs: COMMENT_CACHE_TTL_MS });
}

function isReviewDecisionFresh(cached) {
    return COMMENT_CACHE_POLICY.isReviewDecisionFresh(cached, { ttlMs: COMMENT_CACHE_TTL_MS });
}

function isAuthorAssociationFresh(cached) {
    return COMMENT_CACHE_POLICY.isAuthorAssociationFresh(cached, { ttlMs: COMMENT_CACHE_TTL_MS });
}

function isAuthorPermissionFresh(cached) {
    return COMMENT_CACHE_POLICY.isAuthorPermissionFresh(cached, { ttlMs: COMMENT_CACHE_TTL_MS });
}

function isAuthorLoginFresh(cached) {
    return COMMENT_CACHE_POLICY.isAuthorLoginFresh(cached, { ttlMs: COMMENT_CACHE_TTL_MS });
}

function isDiffstatFresh(cached) {
    return COMMENT_CACHE_POLICY.isDiffstatFresh(cached, { ttlMs: COMMENT_CACHE_TTL_MS });
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
    const queuedNotifications = [];
    pending.forEach((notif) => {
        const key = getNotificationKey(notif);
        if (state.commentQueueKeys.has(key)) {
            return;
        }
        state.commentQueueKeys.add(key);
        queuedNotifications.push(notif);
    });
    if (!queuedNotifications.length) {
        return;
    }
    state.commentQueue.push(() => prefetchNotificationCommentsBulk(queuedNotifications));
    addCommentPrefetchWork(queuedNotifications.length);
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
    return COMMENT_CACHE_POLICY.shouldPrefetchNotificationComments(notification, cached, {
        ttlMs: COMMENT_CACHE_TTL_MS,
    });
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

async function fetchIssueStateEvents(repo, issueNumber) {
    const stateEvents = [];
    const issueUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}`;
    try {
        const issue = await fetchJson(issueUrl);
        if (issue?.closed_at) {
            stateEvents.push({
                id: `issue-${issueNumber}-closed-at`,
                event: 'closed',
                created_at: issue.closed_at,
            });
        }
    } catch (error) {
        console.error('Failed to fetch issue close timestamp:', error);
    }
    const eventUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}/events`;
    try {
        const eventPayload = await fetchJson(eventUrl);
        if (Array.isArray(eventPayload)) {
            stateEvents.push(...eventPayload.filter((event) =>
                COMMENT_INTEREST.isClosingStateEvent(event)
            ));
        }
    } catch (error) {
        console.error('Failed to fetch issue state events:', error);
    }
    return stateEvents;
}

function shouldFetchStateEvents(notification) {
    return COMMENT_INTEREST.isClosedOrMergedNotification(notification);
}

async function fetchBulkNotificationComments(notifications) {
    if (!notifications.length) {
        return null;
    }
    const response = await fetch('/github/rest/comments/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications }),
    });
    if (!response.ok) {
        return null;
    }
    return response.json();
}

function buildReviewDecisionQuery(issueNumbers) {
    const fields = issueNumbers
        .map(
            (issueNumber) =>
                `pr${issueNumber}: pullRequest(number: ${issueNumber}) { reviewDecision authorAssociation additions deletions changedFiles author { login } labels(first: 20) { nodes { name } } }`
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
    labelNames,
    options = {}
) {
    const includeAuthorAssociation = Boolean(options.includeAuthorAssociation);
    const threadId = getNotificationKey(notification);
    const existing = state.commentCache.threads[threadId] || {};
    state.commentCache.threads[threadId] =
        COMMENT_CACHE_POLICY.buildReviewMetadataCacheEntry(
            notification,
            existing,
            {
                reviewDecision,
                authorAssociation,
                authorLogin,
                labelNames,
            },
            {
                includeAuthorAssociation,
                includeDiffstatFields: false,
                preserveUndefinedReviewDecision: true,
                preserveLabelNamesWhenMissing: true,
            }
        );
}

function setAuthorPermissionCache(notification, authorPermission) {
    const threadId = getNotificationKey(notification);
    const existing = state.commentCache.threads[threadId] || {};
    state.commentCache.threads[threadId] =
        COMMENT_CACHE_POLICY.buildAuthorPermissionCacheEntry(
            notification,
            existing,
            authorPermission
        );
}

function setReviewMetadataCacheEntry(notification, entry, options = {}) {
    const threadId = getNotificationKey(notification);
    const existing = state.commentCache.threads[threadId] || {};
    const next = COMMENT_CACHE_POLICY.buildReviewMetadataCacheEntry(
        notification,
        existing,
        entry || {},
        options
    );
    state.commentCache.threads[threadId] = next;
    return next;
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
                decisions.set(issueNumber, repoData[`pr${issueNumber}`] || {});
            });
            notifications.forEach((notif) => {
                const issueNumber = getIssueNumber(notif);
                if (!decisions.has(issueNumber)) {
                    return;
                }
                const entry = decisions.get(issueNumber);
                setReviewMetadataCacheEntry(notif, entry, { includeAuthorAssociation });
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
    const pending = force
        ? notifications.filter((notif) => notif.subject?.type === 'PullRequest')
        : COMMENT_CACHE_POLICY.getPendingReviewMetadataNotifications(
            notifications,
            state.commentCache.threads,
            {
                getNotificationKey,
                includeAuthorAssociation,
                includeAuthorPermission,
                ttlMs: COMMENT_CACHE_TTL_MS,
            }
        );
    if (!pending.length) {
        return;
    }
    const byRepo = new Map();
    pending.forEach((notification) => {
        const repo = getNotificationRepoInfo(notification);
        if (!repo) {
            console.warn(
                'Skipping review metadata prefetch for notification with no repository:',
                getNotificationKey(notification)
            );
            return;
        }
        const key = `${repo.owner}/${repo.repo}`;
        if (!byRepo.has(key)) {
            byRepo.set(key, { repo, notifications: [] });
        }
        byRepo.get(key).notifications.push(notification);
    });
    if (!byRepo.size) {
        return;
    }
    if (force) {
        Promise.all(Array.from(byRepo.values()).map((group) =>
            prefetchReviewDecisions(group.repo, group.notifications, {
                includeAuthorAssociation,
                includeAuthorPermission,
            })
        ))
            .then(() => {
                saveCommentCache();
                render();
            })
            .catch((error) => {
                console.error('Review metadata prefetch failed:', error);
        });
        return;
    }
    byRepo.forEach((group) => {
        state.commentQueue.push(() =>
            prefetchReviewDecisions(group.repo, group.notifications, {
                includeAuthorAssociation,
                includeAuthorPermission,
            })
        );
    });
    runCommentQueue();
}

async function prefetchNotificationComments(notification) {
    const threadId = getNotificationKey(notification);
    const cached = state.commentCache.threads[threadId];
    if (!shouldPrefetchNotificationComments(notification)) {
        return;
    }

    const issueNumber = getIssueNumber(notification);
    if (!issueNumber) {
        state.commentCache.threads[threadId] =
            COMMENT_CACHE_POLICY.buildMissingIssueCommentCacheEntry(notification, cached);
        return;
    }

    try {
        const repo = getNotificationRepoInfo(notification);
        if (!repo) {
            throw new Error('Missing repository input.');
        }

        const isPR = notification.subject?.type === 'PullRequest';
        let comments = [];
        let stateEvents = [];
        let allComments = false;
        const { anchor, lastReadAt } = COMMENT_CACHE_POLICY.getCommentFetchWindow(notification);
        const fetchStateEvents = shouldFetchStateEvents(notification);

        // If we have an anchor, always fetch all and filter client-side
        // Closed notifications need all comments so replies can be compared with the close event.
        // If we have last_read_at (but no anchor), use it as a server-side filter
        // If neither, fetch all comments
        if (anchor || fetchStateEvents) {
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
        if (fetchStateEvents) {
            try {
                stateEvents = await fetchIssueStateEvents(repo, issueNumber);
            } catch (error) {
                console.error('Failed to fetch issue state events:', error);
            }
        }

        state.commentCache.threads[threadId] = COMMENT_CACHE_POLICY.buildCommentSuccessCacheEntry(
            notification,
            cached,
            {
                comments,
                stateEvents,
                allComments,
            }
        );
    } catch (error) {
        state.commentCache.threads[threadId] = COMMENT_CACHE_POLICY.buildCommentErrorCacheEntry(
            notification,
            cached,
            { error: error.message || String(error) }
        );
    }
}

async function prefetchNotificationCommentsBulk(notifications) {
    const pending = notifications.filter(shouldPrefetchNotificationComments);
    if (!pending.length) {
        updateCommentPrefetchWork({ completed: notifications.length });
        notifications.forEach((notification) => {
            state.commentQueueKeys.delete(getNotificationKey(notification));
        });
        return;
    }
    updateCommentPrefetchWork({ inFlight: pending.length });
    let completed = 0;
    let failed = 0;
    try {
        const bulkPayload = await fetchBulkNotificationComments(pending);
        const threads = bulkPayload?.threads;
        if (!threads || typeof threads !== 'object') {
            await Promise.all(
                pending.map(async (notification) => {
                    try {
                        await prefetchNotificationComments(notification);
                    } finally {
                        completed += 1;
                        if (state.commentCache.threads[getNotificationKey(notification)]?.error) {
                            failed += 1;
                        }
                    }
                })
            );
            return;
        }
        pending.forEach((notification) => {
            const threadId = getNotificationKey(notification);
            const cached = state.commentCache.threads[threadId];
            const result = threads[threadId];
            completed += 1;
            if (!result) {
                failed += 1;
                state.commentCache.threads[threadId] =
                    COMMENT_CACHE_POLICY.buildCommentErrorCacheEntry(notification, cached, {
                        error: 'Bulk comment fetch returned no result.',
                    });
                return;
            }
            if (result.error) {
                failed += 1;
                state.commentCache.threads[threadId] =
                    COMMENT_CACHE_POLICY.buildCommentErrorCacheEntry(notification, cached, {
                        error: result.error,
                    });
                return;
            }
            state.commentCache.threads[threadId] =
                COMMENT_CACHE_POLICY.buildCommentSuccessCacheEntry(notification, cached, {
                    comments: Array.isArray(result.comments) ? result.comments : [],
                    stateEvents: Array.isArray(result.stateEvents) ? result.stateEvents : [],
                    allComments: Boolean(result.allComments),
                });
        });
    } catch (error) {
        console.error('Bulk comment prefetch failed:', error);
        await Promise.all(
            pending.map(async (notification) => {
                try {
                    await prefetchNotificationComments(notification);
                } finally {
                    completed += 1;
                    if (state.commentCache.threads[getNotificationKey(notification)]?.error) {
                        failed += 1;
                    }
                }
            })
        );
    } finally {
        updateCommentPrefetchWork({
            completed,
            failed,
            inFlight: -pending.length,
        });
        notifications.forEach((notification) => {
            state.commentQueueKeys.delete(getNotificationKey(notification));
        });
    }
}

function getCommentStatus(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_STATUS.getCommentStatus(notification, cached, {
        currentUserLogin: state.currentUserLogin,
    });
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

function getCommentItems(notification) {
    const override = typeof getCommentExpansionOverride === 'function'
        ? getCommentExpansionOverride(notification)
        : null;
    const shouldExpand = override !== null && override !== undefined
        ? Boolean(override)
        : (
            (state.view === 'issues' && state.commentExpandIssues) ||
            (state.view !== 'issues' && state.commentExpandPrs)
        );
    if (!shouldExpand) {
        return '';
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    const commentState = COMMENT_WINDOW.getRenderableCommentState(notification, cached, {
        ageFilter: state.commentAgeFilter,
        currentUserLogin: state.currentUserLogin,
        hideUninteresting: state.commentHideUninteresting,
    });
    if (commentState.kind === 'error') {
        return `<li class="comment-item">Comments error: ${escapeHtml(commentState.error)}</li>`;
    }
    if (commentState.kind !== 'comments') {
        const detail = commentState.detail
            ? `<div class="comment-empty-detail">${escapeHtml(commentState.detail)}</div>`
            : '';
        return `<li class="comment-item comment-empty">${escapeHtml(commentState.label)}${detail}</li>`;
    }
    return commentState.comments
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

function getSortedNotificationComments(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error || !Array.isArray(cached.comments)) {
        return [];
    }
    return COMMENT_INTEREST.sortComments(cached.comments);
}

function isNotificationForCurrentUser(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_INTEREST.isNotificationForCurrentUser(notification, {
        authorLogin: cached?.authorLogin,
        comments: getSortedNotificationComments(notification),
        currentUserLogin: state.currentUserLogin,
    });
}

function isNotificationDirectedAtCurrentUser(notification) {
    const comments = getSortedNotificationComments(notification);
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_INTEREST.isNotificationDirectedAtCurrentUser(notification, {
        authorLogin: cached?.authorLogin,
        comments,
        currentUserLogin: state.currentUserLogin,
        lastReadAt: cached?.lastReadAt,
        stateEvents: cached?.stateEvents,
        suppressParticipationReplies: notification?.ui?.replies_muted,
    });
}

function getUninterestingReason(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_STATUS.getUninterestingReason(notification, cached, {
        currentUserLogin: state.currentUserLogin,
    });
}

function isNotificationNeedsReview(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_STATUS.isNeedsReview(notification, cached);
}

function isNotificationReviewResponsibility(notification) {
    return COMMENT_STATUS.isReviewResponsibility(notification);
}

function isNotificationApproved(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_STATUS.isApproved(notification, cached);
}

function isNotificationChangesRequested(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    return COMMENT_STATUS.isChangesRequested(notification, cached);
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
    return COMMENT_INTEREST.isUninterestingComment(comment);
}
