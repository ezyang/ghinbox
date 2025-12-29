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
const COMMENT_PREFETCH_KEY = 'ghnotif_comment_prefetch_enabled';
const COMMENT_EXPAND_KEY = 'ghnotif_comment_expand_enabled';
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

function scheduleCommentPrefetch(notifications) {
    if (!state.commentPrefetchEnabled) {
        return;
    }
    scheduleReviewDecisionPrefetch(notifications);
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
    const shouldLoadAllComments = Boolean(
        notification.last_read_at_missing || !notification.last_read_at
    );
    if (shouldLoadAllComments) {
        return !cached.allComments;
    }
    return cached.lastReadAt !== (notification.last_read_at || null);
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
                `pr${issueNumber}: pullRequest(number: ${issueNumber}) { reviewDecision authorAssociation }`
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

function setReviewDecisionCache(notification, reviewDecision, authorAssociation) {
    const threadId = getNotificationKey(notification);
    const existing = state.commentCache.threads[threadId] || {};
    const nowIso = new Date().toISOString();
    state.commentCache.threads[threadId] = {
        ...existing,
        notificationUpdatedAt: notification.updated_at || existing.notificationUpdatedAt,
        reviewDecision,
        reviewDecisionFetchedAt: nowIso,
        authorAssociation,
        authorAssociationFetchedAt: nowIso,
    };
}

async function prefetchReviewDecisions(repo, notifications) {
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
                    entry.authorAssociation
                );
            });
        }
        setGraphqlRateLimitError(null);
    } catch (error) {
        setGraphqlRateLimitError(error.message || String(error));
    }
}

function scheduleReviewDecisionPrefetch(notifications) {
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
    const pending = prNotifications.filter((notif) => {
        const cached = state.commentCache.threads[getNotificationKey(notif)];
        return !isReviewDecisionFresh(cached) || !isAuthorAssociationFresh(cached);
    });
    if (!pending.length) {
        return;
    }
    showStatus(
        `Review metadata prefetch: queued ${pending.length} PRs`,
        'info',
        { flash: true }
    );
    state.commentQueue.push(() => prefetchReviewDecisions(repo, pending));
    runCommentQueue();
}

async function prefetchNotificationComments(notification) {
    const threadId = getNotificationKey(notification);
    const cached = state.commentCache.threads[threadId];
    const existingReviewDecision = cached?.reviewDecision;
    const existingReviewDecisionFetchedAt = cached?.reviewDecisionFetchedAt;
    const shouldLoadAllComments = Boolean(
        notification.last_read_at_missing || !notification.last_read_at
    );
    if (
        cached &&
        cached.notificationUpdatedAt === notification.updated_at &&
        isCommentCacheFresh(cached) &&
        ((shouldLoadAllComments && cached.allComments) ||
            (!shouldLoadAllComments &&
                cached.lastReadAt === (notification.last_read_at || null)))
    ) {
        return;
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
        };
        return;
    }

    try {
        const repo = parseRepoInput(state.repo || '');
        if (!repo) {
            throw new Error('Missing repository input.');
        }
        let lastReadAt = null;
        let allComments = false;
        let comments = [];
        if (shouldLoadAllComments) {
            allComments = true;
            comments = await fetchAllIssueComments(repo, issueNumber);
        } else {
            lastReadAt = notification.last_read_at || cached?.lastReadAt || null;
            if (!lastReadAt) {
                allComments = true;
                comments = await fetchAllIssueComments(repo, issueNumber);
            } else {
                let commentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}/comments`;
                commentUrl += `?since=${encodeURIComponent(lastReadAt)}`;
                comments = await fetchJson(commentUrl);
            }
        }
        state.commentCache.threads[threadId] = {
            notificationUpdatedAt: notification.updated_at,
            lastReadAt,
            unread: notification.unread,
            comments,
            allComments,
            fetchedAt: new Date().toISOString(),
            reviewDecision: existingReviewDecision,
            reviewDecisionFetchedAt: existingReviewDecisionFetchedAt,
        };
    } catch (error) {
        state.commentCache.threads[threadId] = {
            notificationUpdatedAt: notification.updated_at,
            comments: [],
            allComments: shouldLoadAllComments,
            error: error.message || String(error),
            fetchedAt: new Date().toISOString(),
            reviewDecision: existingReviewDecision,
            reviewDecisionFetchedAt: existingReviewDecisionFetchedAt,
        };
    }
}

function getCommentStatus(notification) {
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!state.commentPrefetchEnabled) {
        return { label: 'Comments: off', className: 'off' };
    }
    if (!cached) {
        return { label: 'Comments: pending', className: 'pending' };
    }
    if (cached.error) {
        return { label: 'Comments: error', className: 'error' };
    }
    const count = cached.comments ? cached.comments.length : 0;
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

function getCommentItems(notification) {
    if (!state.commentExpandEnabled) {
        return '';
    }
    if (!state.commentPrefetchEnabled) {
        return '<li class="comment-item">Enable comment fetching to show comments.</li>';
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached) {
        return '<li class="comment-item">Comments: pending...</li>';
    }
    if (cached.error) {
        return `<li class="comment-item">Comments error: ${escapeHtml(cached.error)}</li>`;
    }
    const comments = filterCommentsAfterOwnComment(cached.comments || []);
    if (comments.length === 0) {
        const label = cached.allComments ? 'No comments found.' : 'No unread comments found.';
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
    if (!state.commentPrefetchEnabled) {
        return false;
    }
    const cached = state.commentCache.threads[getNotificationKey(notification)];
    if (!cached || cached.error) {
        return false;
    }
    const comments = cached.comments || [];
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
    if (!state.commentPrefetchEnabled) {
        return false;
    }
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
