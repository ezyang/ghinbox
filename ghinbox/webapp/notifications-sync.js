        function formatRateLimit(rateLimit, error, graphqlRateLimit, graphqlError) {
            const parts = [];
            if (error) {
                parts.push(`core error: ${error}`);
            } else if (rateLimit?.resources?.core) {
                const core = rateLimit.resources.core;
                const resetAt = core.reset
                    ? new Date(core.reset * 1000).toLocaleTimeString()
                    : 'unknown';
                parts.push(`core ${core.remaining}/${core.limit} reset @ ${resetAt}`);
            } else {
                parts.push('core unknown');
            }

            if (graphqlError) {
                parts.push(`graphql error: ${graphqlError}`);
            } else if (graphqlRateLimit) {
                const resetAt = graphqlRateLimit.resetAt
                    ? new Date(graphqlRateLimit.resetAt).toLocaleTimeString()
                    : 'unknown';
                parts.push(
                    `graphql ${graphqlRateLimit.remaining}/${graphqlRateLimit.limit} reset @ ${resetAt}`
                );
            } else {
                parts.push('graphql unknown');
            }

            return `Rate limit: ${parts.join(' | ')}`;
        }

        function updateRateLimitBox() {
            const text = formatRateLimit(
                state.rateLimit,
                state.rateLimitError,
                state.graphqlRateLimit,
                state.graphqlRateLimitError
            );
            if (elements.rateLimitSummary) {
                elements.rateLimitSummary.textContent = text;
            } else {
                elements.rateLimitBox.textContent = text;
            }
        }

        async function refreshRestRateLimit() {
            try {
                const data = await fetchJson('/github/rest/rate_limit');
                state.rateLimit = data;
                state.rateLimitError = null;
                const nextReset = data?.resources?.core?.reset || null;
                if (
                    state.rateLimitLogResetAt &&
                    nextReset &&
                    nextReset !== state.rateLimitLogResetAt
                ) {
                    clearRateLimitLogs({ preserveSince: state.rateLimitLogRefreshStart });
                }
                state.rateLimitLogResetAt = nextReset;
            } catch (error) {
                state.rateLimitError = error.message || String(error);
            }
        }

        async function refreshGraphqlRateLimit() {
            try {
                const data = await fetchGraphqlForSync(
                    `
                        query {
                            rateLimit {
                                limit
                                remaining
                                resetAt
                            }
                        }
                    `,
                    {}
                );
                if (!data?.rateLimit) {
                    updateGraphqlRateLimit(null);
                }
                setGraphqlRateLimitError(null);
            } catch (error) {
                setGraphqlRateLimitError(error.message || String(error));
            }
        }

        async function refreshRateLimit({ skipGraphql = false } = {}) {
            state.rateLimitLogRefreshStart = Date.now();
            // REST /rate_limit is free; GraphQL rateLimit query costs 1 point
            const tasks = [refreshRestRateLimit()];
            if (!skipGraphql) {
                tasks.push(refreshGraphqlRateLimit());
            }
            await Promise.all(tasks);
            updateRateLimitBox();
            updateRateLimitLogStatus();
            state.rateLimitLogRefreshStart = null;
        }

        function updateGraphqlRateLimit(rateLimit) {
            state.graphqlRateLimit = rateLimit || null;
            state.graphqlRateLimitError = null;
            updateRateLimitBox();
        }

        function setGraphqlRateLimitError(error) {
            state.graphqlRateLimitError = error ? String(error) : null;
            updateRateLimitBox();
        }

        function getNotificationKey(notification) {
            return GhinboxNotificationIdentity.getNotificationKey(notification);
        }

        function getIssueNumber(notification) {
            return GhinboxNotificationIdentity.getIssueNumber(notification);
        }

        function getNotificationMatchKeyForRepo(notification, repo) {
            return GhinboxNotificationIdentity.getNotificationMatchKeyForRepo(notification, repo);
        }

        function getNotificationMatchKey(notification) {
            return GhinboxNotificationIdentity.getNotificationMatchKey(notification);
        }

        const {
            buildIncrementalRestLookupKeys,
            buildNotificationMatchKeySet,
            buildPreviousMatchMap,
            findIncrementalOverlapIndex,
            mergeIncrementalNotifications,
        } = GhinboxSyncMerge;
        const {
            mergeServerSnapshotCommentCache,
            pruneCommentCacheToNotifications,
        } = GhinboxCommentCachePolicy;

        function getRestNotificationMatchKey(notification) {
            return GhinboxNotificationIdentity.getRestNotificationMatchKey(notification);
        }

        async function fetchRestNotificationsMap(targetKeys) {
            const result = new Map();
            const maxPages = 5;
            for (let page = 1; page <= maxPages; page += 1) {
                const remainingCount = targetKeys.size - result.size;
                const params = new URLSearchParams();
                params.set('all', 'true');
                params.set('per_page', '50');
                params.set('page', String(page));
                const url = `/github/rest/notifications?${params}`;
                let payload = [];
                try {
                    showStatus(
                        `Last read lookup: requesting REST page ${page} (${remainingCount} remaining)`,
                        'info',
                        { flash: true }
                    );
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3000);
                    try {
                        payload = await fetchJson(url, { signal: controller.signal });
                    } finally {
                        clearTimeout(timeoutId);
                    }
                } catch (error) {
                    showStatus(`Rate limit fetch failed: ${error.message || error}`, 'info', {
                        flash: true,
                    });
                    break;
                }
                if (!Array.isArray(payload) || payload.length === 0) {
                    break;
                }
                payload.forEach((notif) => {
                    const key = getRestNotificationMatchKey(notif);
                    if (key && targetKeys.has(key)) {
                        result.set(key, notif);
                    }
                });
                showStatus(
                    `Last read lookup: received ${payload.length} notifications (matched ${result.size}/${targetKeys.size})`,
                    'info'
                );
                const remaining = [...targetKeys].filter((id) => !result.has(id));
                if (remaining.length === 0) {
                    break;
                }
            }
            return result;
        }

        async function ensureLastReadAtData(notifications, { restLookupKeys = null } = {}) {
            const missing = notifications.filter((notif) => !notif.last_read_at);
            if (!missing.length) {
                return notifications;
            }
            showStatus(
                `Last read lookup: ${missing.length} notifications missing last_read_at`,
                'info',
                { flash: true }
            );
            const cachedLastReadAt = new Map();
            missing.forEach((notif) => {
                const cached = state.commentCache.threads[getNotificationKey(notif)];
                if (cached?.lastReadAt && isCommentCacheFresh(cached)) {
                    cachedLastReadAt.set(getNotificationKey(notif), cached.lastReadAt);
                }
            });
            const missingKeys = new Set();
            missing.forEach((notif) => {
                if (cachedLastReadAt.has(getNotificationKey(notif))) {
                    return;
                }
                const key = getNotificationMatchKey(notif);
                if (!key) {
                    return;
                }
                if (restLookupKeys && !restLookupKeys.has(key)) {
                    return;
                }
                missingKeys.add(key);
            });
            const restMap =
                missingKeys.size > 0
                    ? await fetchRestNotificationsMap(missingKeys)
                    : new Map();
            const mergedNotifications = notifications.map((notif) => {
                const lastReadAtMissing = !notif.last_read_at;
                const cached = cachedLastReadAt.get(getNotificationKey(notif));
                if (cached && lastReadAtMissing) {
                    return { ...notif, last_read_at: cached, last_read_at_missing: true };
                }
                const rest = restMap.get(getNotificationMatchKey(notif));
                if (rest && rest.last_read_at && lastReadAtMissing) {
                    return {
                        ...notif,
                        last_read_at: rest.last_read_at,
                        last_read_at_missing: true,
                    };
                }
                if (lastReadAtMissing) {
                    return { ...notif, last_read_at_missing: true };
                }
                return notif;
            });
            await refreshRateLimit();
            return mergedNotifications;
        }

        function buildPullRequestStateQuery(issueNumbers) {
            const fields = issueNumbers
                .map((issueNumber) => `pr${issueNumber}: pullRequest(number: ${issueNumber}) { state isDraft }`)
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

        function normalizePullRequestState(state, isDraft) {
            if (state === 'MERGED') {
                return 'merged';
            }
            if (state === 'CLOSED') {
                return 'closed';
            }
            if (isDraft) {
                return 'draft';
            }
            if (state === 'OPEN') {
                return 'open';
            }
            return null;
        }

        async function fetchReviewRequestNotifications(repo) {
            if (!state.currentUserLogin && typeof checkAuth === 'function') {
                await checkAuth();
            }
            const payload = await fetchJson(GhinboxReviewRequests.buildReviewRequestSearchUrl(repo));
            return Array.isArray(payload?.notifications) ? payload.notifications : [];
        }

        async function fetchReviewRequestNotificationsForSource(source) {
            if (!state.currentUserLogin && typeof checkAuth === 'function') {
                await checkAuth();
            }
            const payload = await fetchJson(
                GhinboxReviewRequests.buildReviewRequestSearchUrlForSource(source)
            );
            return Array.isArray(payload?.notifications) ? payload.notifications : [];
        }

        function groupReviewRequestsByRepo(reviewRequests) {
            const groups = new Map();
            reviewRequests.forEach((notification) => {
                const repoInfo = getNotificationRepoInfo(notification);
                if (!repoInfo) {
                    return;
                }
                if (!groups.has(repoInfo.fullName)) {
                    groups.set(repoInfo.fullName, { repoInfo, notifications: [] });
                }
                groups.get(repoInfo.fullName).notifications.push(notification);
            });
            return Array.from(groups.values());
        }

        async function getReviewRequestNeedsReviewNumbers(repo, reviewRequests, syncLabel) {
            const numbers = Array.from(new Set(
                reviewRequests
                    .map((notification) => getIssueNumber(notification))
                    .filter((issueNumber) => typeof issueNumber === 'number')
            ));
            if (numbers.length === 0 || typeof buildReviewDecisionQuery !== 'function') {
                return new Set();
            }
            try {
                showStatus(
                    `${syncLabel}: checking which review requests need review`,
                    'info',
                    { flash: true }
                );
                const data = await fetchGraphqlForSync(buildReviewDecisionQuery(numbers), {
                    owner: repo.owner,
                    name: repo.repo,
                });
                const repoData = data?.repository || {};
                const needsReviewNumbers = new Set();
                reviewRequests.forEach((notification) => {
                    const number = getIssueNumber(notification);
                    if (typeof number !== 'number') {
                        return;
                    }
                    const subjectState = notification.subject?.state;
                    if (subjectState === 'draft' || subjectState === 'closed' || subjectState === 'merged') {
                        return;
                    }
                    const entry = repoData[`pr${number}`] || {};
                    const labels = Array.isArray(entry?.labels?.nodes)
                        ? entry.labels.nodes.map((label) => String(label?.name || '').toLowerCase())
                        : [];
                    if (labels.length) {
                        notification.labels = labels.map((name) => ({ name }));
                    }
                    if (typeof setReviewDecisionCache === 'function') {
                        setReviewDecisionCache(
                            notification,
                            entry?.reviewDecision ?? null,
                            entry?.authorAssociation ?? null,
                            entry?.author?.login ?? null,
                            labels,
                            { includeAuthorAssociation: true }
                        );
                        const threadId = getNotificationKey(notification);
                        state.commentCache.threads[threadId] = {
                            ...state.commentCache.threads[threadId],
                            additions: entry?.additions ?? null,
                            deletions: entry?.deletions ?? null,
                            changedFiles: entry?.changedFiles ?? null,
                        };
                    }
                    if (labels.includes('mergedog')) {
                        return;
                    }
                    if (entry?.reviewDecision === 'APPROVED') {
                        return;
                    }
                    needsReviewNumbers.add(number);
                });
                if (typeof saveCommentCache === 'function') {
                    saveCommentCache();
                }
                return needsReviewNumbers;
            } catch (error) {
                console.error('Review request metadata check failed:', error);
                showStatus(
                    `${syncLabel}: review request metadata check failed: ${error.message || error}`,
                    'error',
                    { flash: true }
                );
                return new Set();
            }
        }

        function mergeReviewRequestNotifications(notifications, reviewRequests, repo) {
            if (!reviewRequests.length) {
                return notifications;
            }
            const merged = notifications.map((notif) => ({ ...notif }));
            const indexById = new Map();
            merged.forEach((notif, index) => {
                indexById.set(notif.id, index);
            });
            reviewRequests.forEach((requestNotif) => {
                const existingIndex = indexById.get(requestNotif.id);
                if (existingIndex === undefined) {
                    indexById.set(requestNotif.id, merged.length);
                    merged.push(requestNotif);
                    return;
                }
                const existing = merged[existingIndex];
                merged[existingIndex] = {
                    ...existing,
                    ...requestNotif,
                    ui: existing.ui || requestNotif.ui,
                    responsibility_source: 'review-requested',
                };
            });
            return merged;
        }

        async function fetchGraphqlForSync(query, variables) {
            if (globalThis.GhinboxHttp?.fetchGraphql) {
                return globalThis.GhinboxHttp.fetchGraphql(query, variables);
            }
            return fetchGraphql(query, variables);
        }

        async function refreshPullRequestStates(
            repo,
            notifications,
            {
                syncLabel = 'Quick Sync',
                matchKeys = null,
            } = {}
        ) {
            if (!repo || !notifications.length) {
                return notifications;
            }
            const targets = notifications.filter((notif) => {
                if (notif.subject?.type !== 'PullRequest') {
                    return false;
                }
                if (typeof notif.subject?.number !== 'number') {
                    return false;
                }
                if (matchKeys && !matchKeys.has(getNotificationMatchKeyForRepo(notif, repo))) {
                    return false;
                }
                return true;
            });
            if (!targets.length) {
                return notifications;
            }
            const uniqueNumbers = Array.from(
                new Set(targets.map((notif) => getIssueNumber(notif)).filter(Boolean))
            );
            if (!uniqueNumbers.length) {
                return notifications;
            }
            const updates = new Map();
            try {
                showStatus(
                    `${syncLabel}: checking PR state for ${uniqueNumbers.length} notifications`,
                    'info',
                    { flash: true }
                );
                const batchSize = 25;
                for (let i = 0; i < uniqueNumbers.length; i += batchSize) {
                    const batch = uniqueNumbers.slice(i, i + batchSize);
                    const query = buildPullRequestStateQuery(batch);
                    const data = await fetchGraphqlForSync(query, {
                        owner: repo.owner,
                        name: repo.repo,
                    });
                    const repoData = data?.repository || {};
                    batch.forEach((issueNumber) => {
                        const entry = repoData[`pr${issueNumber}`];
                        if (!entry) {
                            return;
                        }
                        const nextState = normalizePullRequestState(entry.state, entry.isDraft);
                        if (nextState) {
                            updates.set(issueNumber, nextState);
                        }
                    });
                }
                setGraphqlRateLimitError(null);
            } catch (error) {
                setGraphqlRateLimitError(error.message || String(error));
                showStatus(
                    `${syncLabel}: PR state check failed: ${error.message || error}`,
                    'error'
                );
                return notifications;
            }
            if (!updates.size) {
                return notifications;
            }
            return notifications.map((notif) => {
                const number = getIssueNumber(notif);
                if (!number || notif.subject?.type !== 'PullRequest') {
                    return notif;
                }
                if (matchKeys && !matchKeys.has(getNotificationMatchKeyForRepo(notif, repo))) {
                    return notif;
                }
                const nextState = updates.get(number);
                if (!nextState || notif.subject.state === nextState) {
                    return notif;
                }
                return {
                    ...notif,
                    subject: {
                        ...notif.subject,
                        state: nextState,
                    },
                };
            });
        }

        function getServerSnapshotSyncedAtKey(repo) {
            return `ghnotif_server_snapshot_synced_at:${repo.owner}/${repo.repo}`;
        }

        function applyServerSnapshotCommentCache(snapshot) {
            const snapshotThreads = snapshot?.comment_cache?.threads;
            if (!snapshotThreads || typeof snapshotThreads !== 'object') {
                return;
            }
            state.commentCache = mergeServerSnapshotCommentCache(
                state.commentCache,
                snapshot.comment_cache
            );
            saveCommentCache();
        }

        function applyServerSnapshot(repo, snapshot, options = {}) {
            if (!snapshot || !Array.isArray(snapshot.notifications)) {
                return false;
            }
            const schedulePrefetch = options.schedulePrefetch !== false;
            state.repo = `${repo.owner}/${repo.repo}`;
            state.notifications = snapshot.notifications;
            state.lastSyncedRepo = state.repo;
            localStorage.setItem(LAST_SYNCED_REPO_KEY, state.repo);
            if (snapshot.authenticity_token) {
                state.authenticity_token = snapshot.authenticity_token;
                persistAuthenticityToken(snapshot.authenticity_token);
            }
            if (snapshot.synced_at) {
                localStorage.setItem(getServerSnapshotSyncedAtKey(repo), snapshot.synced_at);
            }
            persistNotifications();
            applyServerSnapshotCommentCache(snapshot);
            // The server snapshot is an authoritative upstream rebuild of the
            // notification list, so drop any orphaned comment-cache threads whose
            // notifications are no longer present. Without this, stale local
            // threads survive forever because applyServerSnapshotCommentCache
            // only merges in the snapshot's threads and never removes.
            if (state.commentCache) {
                state.commentCache = pruneCommentCacheToNotifications(
                    state.commentCache,
                    state.notifications
                );
                saveCommentCache();
            }
            if (schedulePrefetch) {
                scheduleCommentPrefetch(state.notifications);
            }
            return true;
        }

        async function fetchServerSnapshot(repo) {
            const response = await fetch(
                `/api/snapshots/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
            );
            if (!response.ok) {
                return null;
            }
            return response.json();
        }

        function formatSnapshotTimestamp(value) {
            if (!value) {
                return 'server';
            }
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) {
                return 'server';
            }
            return date.toLocaleString();
        }

        async function loadServerSnapshotOnInit({ forceApply = false } = {}) {
            const repo = parseRepoInput(state.repo || localStorage.getItem(REPO_KEY) || '');
            if (!repo) {
                return false;
            }
            try {
                const data = await fetchServerSnapshot(repo);
                const snapshot = data?.snapshot;
                let applied = false;
                if (snapshot && Array.isArray(snapshot.notifications)) {
                    const localSyncedAt = localStorage.getItem(getServerSnapshotSyncedAtKey(repo));
                    const shouldApply =
                        forceApply ||
                        state.notifications.length === 0 ||
                        (snapshot.synced_at && snapshot.synced_at !== localSyncedAt);
                    if (shouldApply && applyServerSnapshot(repo, snapshot)) {
                        applied = true;
                        showStatus(
                            `Loaded server snapshot from ${formatSnapshotTimestamp(snapshot.synced_at)}`,
                            'info',
                            { flash: true }
                        );
                    }
                }
                if (data?.sync?.status === 'running') {
                    pollServerSync(repo).catch((error) => {
                        showStatus(`Full Sync failed: ${error.message || error}`, 'error');
                    });
                }
                return applied;
            } catch (error) {
                console.error('Failed to load server snapshot:', error);
                return false;
            }
        }

        function formatServerSyncProgressDetails(sync) {
            const details = [];
            const phase = typeof sync.phase === 'string' ? sync.phase : '';
            if (phase && !['idle', 'running', 'notifications', 'complete'].includes(phase)) {
                details.push(phase);
            }
            if (Number.isFinite(sync.pages_fetched)) {
                details.push(`${sync.pages_fetched} pages`);
            }
            if (Number.isFinite(sync.notifications_count)) {
                details.push(`${sync.notifications_count} notifications`);
            }
            if (Number.isFinite(sync.comments_total) && sync.comments_total > 0) {
                const fetched = Number.isFinite(sync.comments_fetched)
                    ? sync.comments_fetched
                    : 0;
                let comments = `comments ${fetched}/${sync.comments_total}`;
                if (Number.isFinite(sync.comments_failed) && sync.comments_failed > 0) {
                    comments += `, ${sync.comments_failed} failed`;
                }
                details.push(comments);
            }
            return details.length > 0 ? ` (${details.join(', ')})` : '';
        }

        function shouldApplyRunningServerSnapshot(repo, snapshot) {
            if (!snapshot || !Array.isArray(snapshot.notifications) || !snapshot.synced_at) {
                return false;
            }
            return snapshot.synced_at !== localStorage.getItem(getServerSnapshotSyncedAtKey(repo));
        }

        async function pollServerSync(repo, options = {}) {
            const syncLabel = options.syncLabel || 'Full Sync';
            while (true) {
                const data = await fetchJson(
                    `/api/snapshots/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/sync`
                );
                const sync = data.sync || {};
                if (sync.status === 'running') {
                    if (shouldApplyRunningServerSnapshot(repo, data.snapshot)) {
                        applyServerSnapshot(repo, data.snapshot, { schedulePrefetch: false });
                        render();
                    }
                    const detailText = formatServerSyncProgressDetails(sync);
                    showStatus(
                        `${syncLabel} running on server for ${repo.owner}/${repo.repo}${detailText}...`,
                        'info'
                    );
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                }
                if (sync.status === 'success') {
                    if (applyServerSnapshot(repo, data.snapshot)) {
                        showStatus(`Synced ${state.notifications.length} notifications`, 'success');
                        render();
                    }
                    return sync;
                }
                if (sync.status === 'error') {
                    throw new Error(sync.error || 'Server sync failed');
                }
                return sync;
            }
        }

        async function runServerSnapshotSyncForSource(source, options = {}) {
            const syncLabel = options.syncLabel || 'Full Sync';
            const fallbackMode = options.fallbackMode || null;
            const fallbackOnUnavailable = Boolean(options.fallbackOnUnavailable);
            const repo = source.fullName;
            const parsed = {
                owner: source.owner,
                repo: source.repo,
            };
            state.repo = repo;
            localStorage.setItem(REPO_KEY, repo);
            state.loading = true;
            state.error = null;
            render();
            showStatus(`${syncLabel} starting on server for ${repo}...`, 'info', { flash: true });

            try {
                await fetchJson(
                    `/api/snapshots/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/sync`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mode: 'full' }),
                    }
                );
                showStatus(`${syncLabel} running on server for ${repo}...`, 'info');
                await pollServerSync(parsed, { syncLabel });
                return true;
            } catch (error) {
                const message = error.message || String(error);
                const unavailable =
                    error.status === 503 || message.includes('No GitHub fetcher configured');
                if (unavailable && fallbackOnUnavailable) {
                    state.loading = false;
                    render();
                    return false;
                }
                if (unavailable && fallbackMode) {
                    state.loading = false;
                    render();
                    await handleSync({ mode: fallbackMode, allowServer: false });
                    return true;
                }
                state.error = message;
                showStatus(`${syncLabel} failed: ${message}`, 'error');
                return true;
            } finally {
                state.loading = false;
                render();
            }
        }

        async function tryServerQuickSync(sources) {
            if (sources.length !== 1 || sources[0].kind !== 'repo') {
                return false;
            }
            return runServerSnapshotSyncForSource(sources[0], {
                syncLabel: 'Quick Sync',
                fallbackOnUnavailable: true,
            });
        }

        async function handleServerFullSync() {
            const entries = getCurrentProfileEntries();
            if (!entries.length) {
                showStatus('Please enter a repository or query', 'error');
                return;
            }
            if (state.loading) {
                return;
            }
            updateActiveProfileEntries(entries);

            const sources = entries.map(classifyProfileEntry);
            const invalid = sources.find((source) => !source.value);
            if (invalid) {
                showStatus('Invalid empty profile entry', 'error');
                return;
            }
            const invalidFormat = sources.find((source) => source.kind === 'invalid');
            if (invalidFormat) {
                showStatus(`Invalid format: ${invalidFormat.value}`, 'error');
                return;
            }
            if (sources.length !== 1 || sources[0].kind !== 'repo') {
                await handleSync({ mode: 'full', allowServer: false });
                return;
            }

            await runServerSnapshotSyncForSource(sources[0], {
                syncLabel: 'Full Sync',
                fallbackMode: 'full',
            });
        }

        async function handleServerSnapshotRefresh() {
            const repo = elements.repoInput.value.trim();
            const parsed = parseRepoInput(repo);
            if (!parsed) {
                showStatus(repo ? 'Invalid format. Use owner/repo' : 'Please enter a repository (owner/repo)', 'error');
                return;
            }
            if (state.loading) {
                return;
            }

            state.repo = repo;
            localStorage.setItem(REPO_KEY, repo);
            state.loading = true;
            state.error = null;
            render();
            showStatus(`Loading server snapshot for ${repo}...`, 'info', { flash: true });

            try {
                const applied = await loadServerSnapshotOnInit({ forceApply: true });
                if (applied) {
                    showStatus(`Loaded ${state.notifications.length} notifications from server snapshot`, 'success');
                    render();
                    return;
                }
                showStatus('No server snapshot available', 'info');
            } catch (error) {
                const message = error.message || String(error);
                state.error = message;
                showStatus(`Server Refresh failed: ${message}`, 'error');
            } finally {
                state.loading = false;
                render();
            }
        }
