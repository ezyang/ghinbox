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
                const response = await fetch('/github/rest/rate_limit');
                if (!response.ok) {
                    throw new Error(`Request failed (${response.status})`);
                }
                const data = await response.json();
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
            return String(notification.id);
        }

        function getIssueNumber(notification) {
            const number = notification?.subject?.number;
            return typeof number === 'number' ? number : null;
        }

        function getNotificationMatchKeyForRepo(notification, repo) {
            const number = notification?.subject?.number;
            const type = notification?.subject?.type || 'unknown';
            if (repo && typeof number === 'number') {
                return `${repo.owner}/${repo.repo}:${type}:${number}`;
            }
            return `id:${getNotificationKey(notification)}`;
        }

        function getNotificationMatchKey(notification) {
            const repo = parseRepoInput(state.repo || '');
            return getNotificationMatchKeyForRepo(notification, repo);
        }

        function getNotificationDedupKey(notification) {
            return getNotificationMatchKey(notification) || getNotificationKey(notification);
        }

        function getUpdatedAtSignature(updatedAt) {
            const parsed = Date.parse(updatedAt);
            if (Number.isNaN(parsed)) {
                return String(updatedAt || '');
            }
            return `ms:${parsed}`;
        }

        function formatCursorLabel(cursor) {
            if (!cursor) {
                return 'initial';
            }
            const raw = String(cursor);
            if (raw.length <= 10) {
                return `after ${raw}`;
            }
            return `after ${raw.slice(0, 4)}...${raw.slice(-4)}`;
        }

        function countMissingLastReadAt(notifications) {
            return notifications.filter((notif) => !notif.last_read_at).length;
        }

        function countMissingLastReadAtForKeys(notifications, restLookupKeys) {
            if (!restLookupKeys) {
                return countMissingLastReadAt(notifications);
            }
            let count = 0;
            notifications.forEach((notif) => {
                if (notif.last_read_at) {
                    return;
                }
                const key = getNotificationMatchKey(notif);
                if (key && restLookupKeys.has(key)) {
                    count += 1;
                }
            });
            return count;
        }

        function buildPreviousMatchMap(notifications) {
            const map = new Map();
            notifications.forEach((notif, index) => {
                const key = getNotificationMatchKey(notif);
                if (!key || map.has(key)) {
                    return;
                }
                map.set(key, { updatedAt: getUpdatedAtSignature(notif.updated_at), index });
            });
            return map;
        }

        function buildNotificationMatchKeySet(notifications, repo = null) {
            const keys = new Set();
            notifications.forEach((notif) => {
                const key = repo
                    ? getNotificationMatchKeyForRepo(notif, repo)
                    : getNotificationMatchKey(notif);
                if (key) {
                    keys.add(key);
                }
            });
            return keys;
        }

        function buildIncrementalRestLookupKeys(notifications, previousMatchMap) {
            const keys = new Set();
            notifications.forEach((notif) => {
                const key = getNotificationMatchKey(notif);
                if (!key) {
                    return;
                }
                const previous = previousMatchMap.get(key);
                if (previous && previous.updatedAt === getUpdatedAtSignature(notif.updated_at)) {
                    return;
                }
                keys.add(key);
            });
            return keys;
        }

        function findIncrementalOverlapIndex(notifications, previousMatchMap) {
            for (const notif of notifications) {
                const key = getNotificationMatchKey(notif);
                if (!key) {
                    continue;
                }
                const previous = previousMatchMap.get(key);
                if (previous && previous.updatedAt === getUpdatedAtSignature(notif.updated_at)) {
                    return previous.index;
                }
            }
            return null;
        }

        function mergeIncrementalNotifications(newNotifications, previousNotifications, startIndex) {
            const merged = newNotifications.slice();
            const seenKeys = new Set();
            merged.forEach((notif) => {
                const key = getNotificationDedupKey(notif);
                if (key) {
                    seenKeys.add(key);
                }
            });
            for (let i = startIndex; i < previousNotifications.length; i += 1) {
                const notif = previousNotifications[i];
                const key = getNotificationDedupKey(notif);
                if (key && seenKeys.has(key)) {
                    continue;
                }
                merged.push(notif);
                if (key) {
                    seenKeys.add(key);
                }
            }
            return merged;
        }

        function getRestNotificationMatchKey(notification) {
            const repo = notification?.repository?.full_name;
            const type = notification?.subject?.type || 'unknown';
            const url = notification?.subject?.url || '';
            const match = url.match(/\/(issues|pulls)\/(\d+)/);
            if (!repo || !match) {
                return null;
            }
            return `${repo}:${type}:${match[2]}`;
        }

        async function fetchJson(url, options = {}) {
            const response = await fetch(url, options);
            if (!response.ok) {
                let detail = '';
                try {
                    const errorData = await response.json();
                    // Check for session expired (401 with session_expired error)
                    if (response.status === 401 && errorData.detail?.error === 'session_expired') {
                        showStatus('Session expired. Redirecting to login...', 'error');
                        // Small delay so user sees the message
                        await new Promise(resolve => setTimeout(resolve, 1500));
                        // Use session_refresh=1 to bypass the needs-login check
                        window.location.href = '/app/login.html?session_refresh=1';
                        throw new Error('Session expired');
                    }
                    detail = JSON.stringify(errorData);
                } catch (error) {
                    if (error.message === 'Session expired') throw error;
                    detail = String(error);
                }
                throw new Error(`Request failed: ${url} (${response.status}) ${detail}`);
            }
            return response.json();
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

        function buildReviewRequestSearchUrl(repo, login) {
            const query = [
                `repo:${repo.owner}/${repo.repo}`,
                'is:pr',
                'is:open',
                'user-review-requested:@me',
            ].join(' ');
            return `/github/rest/search/issues?q=${encodeURIComponent(query)}&per_page=100`;
        }

        function searchItemToResponsibilityNotification(repo, item) {
            const user = item.user || {};
            const state = item.draft ? 'draft' : 'open';
            return {
                id: `review-request:${repo.owner}/${repo.repo}#${item.number}`,
                unread: false,
                reason: 'review_requested',
                responsibility_source: 'review-requested',
                updated_at: item.updated_at || item.created_at || new Date().toISOString(),
                last_read_at: null,
                subject: {
                    title: item.title || `Pull request #${item.number}`,
                    url: item.html_url || `https://github.com/${repo.owner}/${repo.repo}/pull/${item.number}`,
                    type: 'PullRequest',
                    number: item.number,
                    state,
                    state_reason: null,
                },
                actors: user.login
                    ? [{
                        login: user.login,
                        avatar_url: user.avatar_url || '',
                    }]
                    : [],
                ui: {
                    saved: false,
                    done: false,
                    action_tokens: {},
                },
            };
        }

        async function fetchReviewRequestNotifications(repo) {
            if (!state.currentUserLogin && typeof checkAuth === 'function') {
                await checkAuth();
            }
            const login = String(state.currentUserLogin || '').trim();
            if (!login) {
                return [];
            }
            const response = await fetch(buildReviewRequestSearchUrl(repo, login));
            if (!response.ok) {
                const detail = await response.text();
                throw new Error(`Review request search failed (${response.status}): ${detail}`);
            }
            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            return items
                .filter((item) => item?.number && item?.pull_request)
                .map((item) => searchItemToResponsibilityNotification(repo, item));
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
                    const state = notification.subject?.state;
                    if (state === 'draft' || state === 'closed' || state === 'merged') {
                        return;
                    }
                    const entry = repoData[`pr${number}`] || {};
                    const labels = Array.isArray(entry?.labels?.nodes)
                        ? entry.labels.nodes.map((label) => String(label?.name || '').toLowerCase())
                        : [];
                    if (labels.includes('mergedog')) {
                        return;
                    }
                    if (entry?.reviewDecision === 'APPROVED') {
                        return;
                    }
                    needsReviewNumbers.add(number);
                });
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
            if (typeof fetchGraphql === 'function') {
                return fetchGraphql(query, variables);
            }
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
            state.commentCache = state.commentCache || { version: 1, threads: {} };
            state.commentCache.version = state.commentCache.version || 1;
            state.commentCache.threads = state.commentCache.threads || {};
            Object.entries(snapshotThreads).forEach(([key, snapshotEntry]) => {
                const existingEntry = state.commentCache.threads[key];
                const existingFetchedAt = Date.parse(existingEntry?.fetchedAt || '');
                const snapshotFetchedAt = Date.parse(snapshotEntry?.fetchedAt || '');
                if (
                    !existingEntry ||
                    Number.isNaN(existingFetchedAt) ||
                    (!Number.isNaN(snapshotFetchedAt) && snapshotFetchedAt >= existingFetchedAt)
                ) {
                    state.commentCache.threads[key] = snapshotEntry;
                }
            });
            saveCommentCache();
        }

        function applyServerSnapshot(repo, snapshot) {
            if (!snapshot || !Array.isArray(snapshot.notifications)) {
                return false;
            }
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
            scheduleCommentPrefetch(state.notifications);
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
            const repo = parseRepoInput(state.repo || localStorage.getItem('ghnotif_repo') || '');
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

        async function pollServerSync(repo) {
            while (true) {
                const response = await fetch(
                    `/api/snapshots/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/sync`
                );
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const detail = typeof errorData.detail === 'string'
                        ? errorData.detail
                        : `HTTP ${response.status}`;
                    throw new Error(detail);
                }
                const data = await response.json();
                const sync = data.sync || {};
                if (sync.status === 'running') {
                    const details = [];
                    if (Number.isFinite(sync.pages_fetched)) {
                        details.push(`${sync.pages_fetched} pages`);
                    }
                    if (Number.isFinite(sync.notifications_count)) {
                        details.push(`${sync.notifications_count} notifications`);
                    }
                    const detailText = details.length > 0 ? ` (${details.join(', ')})` : '';
                    showStatus(
                        `Full Sync running on server for ${repo.owner}/${repo.repo}${detailText}...`,
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

        async function handleServerFullSync() {
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
            localStorage.setItem('ghnotif_repo', repo);
            state.loading = true;
            state.error = null;
            render();
            showStatus(`Full Sync starting on server for ${repo}...`, 'info', { flash: true });

            try {
                const response = await fetch(
                    `/api/snapshots/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/sync`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mode: 'full' }),
                    }
                );
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                showStatus(`Full Sync running on server for ${repo}...`, 'info');
                await pollServerSync(parsed);
            } catch (error) {
                const message = error.message || String(error);
                if (message.includes('No GitHub fetcher configured') || message.includes('HTTP 503')) {
                    state.loading = false;
                    await handleSync({ mode: 'full' });
                    return;
                }
                state.error = message;
                showStatus(`Full Sync failed: ${message}`, 'error');
            } finally {
                state.loading = false;
                render();
            }
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
            localStorage.setItem('ghnotif_repo', repo);
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
        // Check authentication status
        const AUTH_CACHE_KEY = 'ghnotif_auth_cache';
        const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

        function getCachedAuth() {
            try {
                const raw = localStorage.getItem(AUTH_CACHE_KEY);
                if (!raw) return null;
                const cached = JSON.parse(raw);
                if (Date.now() - cached.timestamp > AUTH_CACHE_TTL_MS) {
                    return null;
                }
                return cached;
            } catch {
                return null;
            }
        }

        function setCachedAuth(login) {
            try {
                localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
                    login,
                    timestamp: Date.now(),
                }));
            } catch {
                // Ignore storage errors
            }
        }

        async function checkAuth({ force = false } = {}) {
            // Use cached auth if available and not forcing refresh
            if (!force) {
                const cached = getCachedAuth();
                if (cached) {
                    if (cached.login) {
                        elements.authStatus.textContent = `Signed in as ${cached.login}`;
                        elements.authStatus.className = 'auth-status authenticated';
                        state.currentUserLogin = cached.login;
                    } else {
                        elements.authStatus.textContent = 'Not authenticated';
                        elements.authStatus.className = 'auth-status error';
                        state.currentUserLogin = null;
                    }
                    return;
                }
            }

            try {
                const response = await fetch('/github/rest/user');
                const data = await response.json();

                if (response.ok && data.login) {
                    elements.authStatus.textContent = `Signed in as ${data.login}`;
                    elements.authStatus.className = 'auth-status authenticated';
                    state.currentUserLogin = data.login;
                    setCachedAuth(data.login);
                } else {
                    elements.authStatus.textContent = 'Not authenticated';
                    elements.authStatus.className = 'auth-status error';
                    state.currentUserLogin = null;
                    setCachedAuth(null);
                }
            } catch (e) {
                elements.authStatus.textContent = 'Auth check failed';
                elements.authStatus.className = 'auth-status error';
                state.currentUserLogin = null;
            }
        }

        // Handle sync button click
        async function handleSync({ mode = 'incremental' } = {}) {
            const repo = elements.repoInput.value.trim();
            if (!repo) {
                showStatus('Please enter a repository (owner/repo)', 'error');
                return;
            }
            state.repo = repo;
            localStorage.setItem('ghnotif_repo', repo);
            if (state.loading) {
                return;
            }

            // Parse owner/repo
            const parts = repo.split('/');
            if (parts.length !== 2) {
                showStatus('Invalid format. Use owner/repo', 'error');
                return;
            }

            const [owner, repoName] = parts;
            const repoInfo = { owner, repo: repoName };
            const previousNotifications = state.notifications.slice();
            const previousSelected = new Set(state.selected);
            const syncMode = mode === 'full' ? 'full' : 'incremental';
            const syncLabel = syncMode === 'full' ? 'Full Sync' : 'Quick Sync';
            const previousMatchMap =
                syncMode === 'incremental' &&
                previousNotifications.length > 0 &&
                state.lastSyncedRepo === repo
                    ? buildPreviousMatchMap(previousNotifications)
                    : null;
            state.loading = true;
            state.error = null;
            state.notifications = [];
            state.trashNotifications = [];
            state.selected.clear();
            state.commentQueue = [];
            state.commentQueueKeys.clear();
            state.commentPrefetchProgress.active = false;
            state.authenticity_token = null;
            persistAuthenticityToken(null);
            clearUndoState();
            render();

            showStatus(`${syncLabel} starting for ${repo}...`, 'info', { flash: true });
            showStatus(`${syncLabel} in progress...`, 'info');

            try {
                const allNotifications = [];
                let afterCursor = null;
                let pageCount = 0;
                let overlapIndex = null;

                // Fetch all pages
                do {
                    pageCount++;
                    showStatus(
                        `${syncLabel}: requesting page ${pageCount} (${formatCursorLabel(afterCursor)})`,
                        'info',
                        { flash: true }
                    );

                    let url = `/notifications/html/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
                    if (afterCursor) {
                        url += `?after=${encodeURIComponent(afterCursor)}`;
                    }

                    const response = await fetch(url);

                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}));
                        // Check for session expired (401 with session_expired error)
                        if (response.status === 401 && errorData.detail?.error === 'session_expired') {
                            showStatus('Session expired. Redirecting to login...', 'error');
                            // Small delay so user sees the message
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            // Use session_refresh=1 to bypass the needs-login check
                            window.location.href = '/app/login.html?session_refresh=1';
                            return;
                        }
                        const errorMsg = typeof errorData.detail === 'object'
                            ? JSON.stringify(errorData.detail)
                            : (errorData.detail || `HTTP ${response.status}`);
                        throw new Error(errorMsg);
                    }

                    const data = await response.json();
                    allNotifications.push(...data.notifications);
                    // Store authenticity_token from first page (valid for the session)
                    if (data.authenticity_token && !state.authenticity_token) {
                        state.authenticity_token = data.authenticity_token;
                        persistAuthenticityToken(data.authenticity_token);
                    }
                    afterCursor = data.pagination.has_next ? data.pagination.after_cursor : null;
                    if (previousMatchMap && overlapIndex === null) {
                        overlapIndex = findIncrementalOverlapIndex(
                            data.notifications,
                            previousMatchMap
                        );
                        if (overlapIndex !== null) {
                            showStatus(
                                `${syncLabel}: overlap found at index ${overlapIndex} (stopping early)`,
                                'info',
                                { flash: true }
                            );
                            afterCursor = null;
                        }
                    }
                    state.notifications = allNotifications.slice();
                    showStatus(
                        `${syncLabel}: received page ${pageCount} (${data.notifications.length} notifications, total ${allNotifications.length})`,
                        'info'
                    );
                    render();
                    if (syncMode === 'full') {
                        scheduleSyncPageCommentPrefetch(data.notifications);
                    }

                } while (afterCursor);

                let mergedNotifications = allNotifications;
                if (previousMatchMap && overlapIndex !== null) {
                    showStatus(
                        `${syncLabel}: merging fetched results with cached list`,
                        'info',
                        { flash: true }
                    );
                    mergedNotifications = mergeIncrementalNotifications(
                        allNotifications,
                        previousNotifications,
                        overlapIndex + 1
                    );
                    const carriedCount = mergedNotifications.length - allNotifications.length;
                    showStatus(
                        `${syncLabel}: merged ${allNotifications.length} fetched + ${carriedCount} cached`,
                        'info'
                    );
                } else if (previousMatchMap) {
                    showStatus(
                        `${syncLabel}: no overlap found, using fetched pages only`,
                        'info'
                    );
                }

                let reviewRequests = [];
                try {
                    showStatus(
                        `${syncLabel}: checking review requests assigned to you`,
                        'info',
                        { flash: true }
                    );
                    reviewRequests = await fetchReviewRequestNotifications(repoInfo);
                    mergedNotifications = mergeReviewRequestNotifications(
                        mergedNotifications,
                        reviewRequests,
                        repoInfo
                    );
                    if (reviewRequests.length > 0) {
                        showStatus(
                            `${syncLabel}: found ${reviewRequests.length} active review requests`,
                            'info',
                            { flash: true }
                        );
                    }
                } catch (error) {
                    console.error('Review request sync failed:', error);
                    showStatus(
                        `${syncLabel}: review request check failed: ${error.message || error}`,
                        'error',
                        { flash: true }
                    );
                }

                // Sort by updated_at descending
                showStatus(
                    `${syncLabel}: sorting ${mergedNotifications.length} notifications`,
                    'info',
                    { flash: true }
                );
                const sortedNotifications = mergedNotifications.sort((a, b) =>
                    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
                );

                const restLookupKeys =
                    syncMode === 'incremental' && overlapIndex !== null && previousMatchMap
                        ? buildIncrementalRestLookupKeys(allNotifications, previousMatchMap)
                        : null;
                const missingCount = countMissingLastReadAt(sortedNotifications);
                const restMissingCount = countMissingLastReadAtForKeys(
                    sortedNotifications,
                    restLookupKeys
                );
                if (missingCount > 0) {
                    showStatus(
                        restLookupKeys && restMissingCount !== missingCount
                            ? `${syncLabel}: fetching last_read_at for ${restMissingCount}/${missingCount} notifications`
                            : `${syncLabel}: fetching last_read_at for ${missingCount} notifications`,
                        'info',
                        { flash: true }
                    );
                } else {
                    showStatus(
                        `${syncLabel}: last_read_at already present`,
                        'info'
                    );
                }
                let notifications = await ensureLastReadAtData(sortedNotifications, {
                    restLookupKeys,
                });
                const remainingMissing = countMissingLastReadAt(notifications);
                const filledCount = Math.max(missingCount - remainingMissing, 0);
                if (missingCount > 0) {
                    showStatus(
                        `${syncLabel}: filled last_read_at for ${filledCount}/${missingCount} notifications`,
                        'info'
                    );
                }

                if (syncMode === 'incremental') {
                    const fetchedKeys = buildNotificationMatchKeySet(allNotifications, repoInfo);
                    const cachedKeys = new Set();
                    notifications.forEach((notif) => {
                        const key = getNotificationMatchKeyForRepo(notif, repoInfo);
                        if (key && !fetchedKeys.has(key)) {
                            cachedKeys.add(key);
                        }
                    });
                    notifications = await refreshPullRequestStates(repoInfo, notifications, {
                        syncLabel,
                        matchKeys: overlapIndex !== null ? cachedKeys : null,
                    });
                }

                const needsReviewPrNumbers = await getReviewRequestNeedsReviewNumbers(
                    repoInfo,
                    reviewRequests,
                    syncLabel
                );
                notifications = await cleanNeedsReviewFeedDuplicates(notifications, syncLabel, {
                    needsReviewPrNumbers,
                });
                notifications = await autoMarkTrashNotificationsDone(notifications, syncLabel);

                state.notifications = notifications;
                state.loading = false;
                state.lastSyncedRepo = repo;
                localStorage.setItem(LAST_SYNCED_REPO_KEY, repo);

                // Save to localStorage
                persistNotifications();

                scheduleCommentPrefetch(notifications);

                showStatus(`Synced ${notifications.length} notifications`, 'success');
                render();

            } catch (e) {
                state.loading = false;
                state.error = e.message;
                state.notifications = previousNotifications;
                state.selected = previousSelected;
                showStatus(`Sync failed: ${e.message}`, 'error');
                render();
            }
        }

        // Show status message
        function showStatus(message, type, options) {
            const settings = options || {};
            const flash = Boolean(settings.flash);
            const flashDurationMs = Number.isFinite(settings.durationMs)
                ? settings.durationMs
                : 1500;

            if (
                flash &&
                state.statusState &&
                !state.statusState.isFlash &&
                state.statusState.type !== 'info'
            ) {
                return;
            }

            if (state.statusTimer) {
                clearTimeout(state.statusTimer);
                state.statusTimer = null;
            }

            function applyStatus(nextMessage, nextType, isFlash, flashId) {
                elements.statusBar.textContent = nextMessage;
                elements.statusBar.className = `status-bar visible ${nextType}`;
                state.statusState = {
                    message: nextMessage,
                    type: nextType,
                    isFlash,
                    flashId,
                };
            }

            const flashId = flash ? (state.statusFlashId += 1) : null;
            applyStatus(message, type, flash, flashId);

            if (!flash) {
                state.lastPersistentStatus = { message, type };
                return;
            }

            state.statusTimer = setTimeout(() => {
                if (!state.statusState || state.statusState.flashId !== flashId) {
                    return;
                }
                const last = state.lastPersistentStatus;
                if (last) {
                    applyStatus(last.message, last.type, false, null);
                    return;
                }
                elements.statusBar.textContent = '';
                elements.statusBar.className = 'status-bar';
                state.statusState = null;
            }, flashDurationMs);
        }
