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
            buildServerProfileSyncEntries,
            canUseIncrementalOverlapMerge,
            dedupAndSortNotifications,
            findIncrementalOverlapIndex,
            getServerSnapshotKey,
            getServerSnapshotLastSyncedRepo,
            getServerSnapshotSourceKey,
            mergeIncrementalNotifications,
            shouldPruneIncrementalNotifications,
            shouldApplyServerSnapshot,
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
                    let labels = [];
                    if (typeof setReviewMetadataCacheEntry === 'function') {
                        const cached = setReviewMetadataCacheEntry(
                            notification,
                            entry,
                            {
                                includeAuthorAssociation: true,
                                lowercaseLabelNames: true,
                            }
                        );
                        labels = Array.isArray(cached?.labelNames) ? cached.labelNames : [];
                    } else if (globalThis.GhinboxCommentCachePolicy?.buildReviewMetadataCacheEntry) {
                        const cached = globalThis.GhinboxCommentCachePolicy
                            .buildReviewMetadataCacheEntry(
                                notification,
                                {},
                                entry,
                                { lowercaseLabelNames: true }
                            );
                        labels = Array.isArray(cached?.labelNames) ? cached.labelNames : [];
                    }
                    if (labels.length) {
                        notification.labels = labels.map((name) => ({ name }));
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
                queryRepo = repo,
                matchRepo = repo,
                statusMode = 'summary',
                commitEachBatch = false,
                onNotificationsUpdated = null,
                clearGraphqlRateLimitErrorOnSuccess = true,
                catchErrors = true,
                requirePullRequestOnRewrite = true,
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
                if (matchKeys && !matchKeys.has(getNotificationMatchKeyForRepo(notif, matchRepo))) {
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
            const run = async () => {
                if (statusMode !== 'batch') {
                    showStatus(
                        `${syncLabel}: checking PR state for ${uniqueNumbers.length} notifications`,
                        'info',
                        { flash: true }
                    );
                }
                const batchSize = 25;
                let currentNotifications = notifications;
                for (let i = 0; i < uniqueNumbers.length; i += batchSize) {
                    const batch = uniqueNumbers.slice(i, i + batchSize);
                    if (statusMode === 'batch') {
                        showStatus(
                            `${syncLabel}: checking PR state ${Math.min(i + batch.length, uniqueNumbers.length)}/${uniqueNumbers.length}`,
                            'info',
                            { flash: true }
                        );
                    }
                    const query = buildPullRequestStateQuery(batch);
                    const data = await fetchGraphqlForSync(query, {
                        owner: queryRepo.owner,
                        name: queryRepo.repo,
                    });
                    const repoData = data?.repository || {};
                    const batchUpdates = new Map();
                    batch.forEach((issueNumber) => {
                        const entry = repoData[`pr${issueNumber}`];
                        if (!entry) {
                            return;
                        }
                        const nextState = normalizePullRequestState(entry.state, entry.isDraft);
                        if (nextState) {
                            updates.set(issueNumber, nextState);
                            batchUpdates.set(issueNumber, nextState);
                        }
                    });
                    if (commitEachBatch && batchUpdates.size) {
                        currentNotifications = applyPullRequestStateUpdates(
                            currentNotifications,
                            batchUpdates,
                            {
                                matchKeys,
                                repo: matchRepo,
                                requirePullRequest: requirePullRequestOnRewrite,
                            }
                        );
                        if (typeof onNotificationsUpdated === 'function') {
                            onNotificationsUpdated(currentNotifications);
                        }
                    }
                }
                if (clearGraphqlRateLimitErrorOnSuccess) {
                    setGraphqlRateLimitError(null);
                }
                if (commitEachBatch) {
                    return currentNotifications;
                }
                if (!updates.size) {
                    return notifications;
                }
                return applyPullRequestStateUpdates(notifications, updates, {
                    matchKeys,
                    repo: matchRepo,
                    requirePullRequest: requirePullRequestOnRewrite,
                });
            };
            if (!catchErrors) {
                return run();
            }
            try {
                return await run();
            } catch (error) {
                setGraphqlRateLimitError(error.message || String(error));
                showStatus(
                    `${syncLabel}: PR state check failed: ${error.message || error}`,
                    'error'
                );
                return notifications;
            }
        }

        function applyPullRequestStateUpdates(
            notifications,
            updates,
            {
                matchKeys = null,
                repo = null,
                requirePullRequest = true,
            } = {}
        ) {
            return notifications.map((notif) => {
                const number = getIssueNumber(notif);
                if (!number) {
                    return notif;
                }
                if (requirePullRequest && notif.subject?.type !== 'PullRequest') {
                    return notif;
                }
                if (matchKeys && !matchKeys.has(getNotificationMatchKeyForRepo(notif, repo))) {
                    return notif;
                }
                const nextState = updates.get(number);
                if (!nextState || notif.subject?.state === nextState) {
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

        function getProfileEntriesStorageValue(entries) {
            return entries.length === 1 ? entries[0] : entries.join('\n');
        }

        function getServerSnapshotSyncedAtKey(snapshotKey) {
            return `ghnotif_server_snapshot_synced_at:${snapshotKey}`;
        }

        function isSingleRepoSnapshotSource(sources) {
            return Array.isArray(sources) && sources.length === 1 && sources[0]?.kind === 'repo';
        }

        function getRepoServerSnapshotTarget(source) {
            const snapshotKey = getServerSnapshotSourceKey(source);
            if (!snapshotKey || source?.kind !== 'repo') {
                return null;
            }
            const owner = source.owner;
            const repo = source.repo;
            return {
                kind: 'repo',
                source,
                snapshotKey,
                label: source.fullName || `${owner}/${repo}`,
                snapshotUrl: `/api/snapshots/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
                syncUrl: `/api/snapshots/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/sync`,
                syncBody: { mode: 'full' },
            };
        }

        function getProfileServerSnapshotTarget(profileName, sources) {
            const snapshotKey = getServerSnapshotKey(sources, profileName);
            if (!snapshotKey) {
                return null;
            }
            const name = String(profileName || '').trim();
            const entries = buildServerProfileSyncEntries(sources);
            return {
                kind: 'profile',
                snapshotKey,
                label: name,
                snapshotUrl: `/api/snapshots/profile/${encodeURIComponent(name)}`,
                syncUrl: `/api/snapshots/profile/${encodeURIComponent(name)}/sync`,
                syncBody: { mode: 'full', entries },
            };
        }

        function getServerSnapshotTarget(sources) {
            if (isSingleRepoSnapshotSource(sources)) {
                return getRepoServerSnapshotTarget(sources[0]);
            }
            return getProfileServerSnapshotTarget(state.profileId, sources);
        }

        function getServerSnapshotStorageValue(entries, sources) {
            if (sources.length === 1 && sources[0].kind === 'repo') {
                return sources[0].fullName;
            }
            return getProfileEntriesStorageValue(entries);
        }

        function getServerSnapshotApplyConfig(entries, sources) {
            const profileSignature = getProfileSignature();
            return {
                storageValue: getServerSnapshotStorageValue(entries, sources),
                lastSyncedRepo: getServerSnapshotLastSyncedRepo(sources, profileSignature),
            };
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

        function applyServerSnapshot(target, snapshot, options = {}) {
            if (!snapshot || !Array.isArray(snapshot.notifications)) {
                return false;
            }
            const schedulePrefetch = options.schedulePrefetch !== false;
            const storageValue = options.storageValue || state.repo || '';
            const lastSyncedRepo = options.lastSyncedRepo || storageValue;
            state.repo = storageValue || state.repo;
            if (storageValue) {
                localStorage.setItem(REPO_KEY, storageValue);
            }
            state.notifications = snapshot.notifications;
            state.lastSyncedRepo = lastSyncedRepo;
            if (lastSyncedRepo) {
                localStorage.setItem(LAST_SYNCED_REPO_KEY, lastSyncedRepo);
            }
            if (snapshot.authenticity_token) {
                state.authenticity_token = snapshot.authenticity_token;
                persistAuthenticityToken(snapshot.authenticity_token);
            }
            if (snapshot.synced_at) {
                localStorage.setItem(
                    getServerSnapshotSyncedAtKey(target.snapshotKey),
                    snapshot.synced_at
                );
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

        async function fetchServerSnapshot(target) {
            const response = await fetch(target.snapshotUrl);
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
            const entries = getCurrentProfileEntries();
            if (!entries.length) {
                return false;
            }
            const sources = entries.map(classifyProfileEntry);
            if (sources.some((source) => !source.value || source.kind === 'invalid')) {
                return false;
            }
            const target = getServerSnapshotTarget(sources);
            if (!target) {
                return false;
            }
            const { storageValue, lastSyncedRepo } = getServerSnapshotApplyConfig(entries, sources);
            try {
                const data = await fetchServerSnapshot(target);
                const snapshot = data?.snapshot;
                let applied = false;
                const shouldApply = shouldApplyServerSnapshot({
                    forceApply,
                    currentNotificationCount: state.notifications.length,
                    snapshot,
                    localSyncedAt: localStorage.getItem(
                        getServerSnapshotSyncedAtKey(target.snapshotKey)
                    ),
                });
                if (
                    shouldApply &&
                    applyServerSnapshot(target, snapshot, { storageValue, lastSyncedRepo })
                ) {
                    applied = true;
                    showStatus(
                        `Loaded server snapshot from ${formatSnapshotTimestamp(snapshot.synced_at)}`,
                        'info',
                        { flash: true }
                    );
                }
                if (data?.sync?.status === 'running') {
                    pollServerSync(target, {
                        lastSyncedRepo,
                        storageValue,
                    }).catch((error) => {
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

        function shouldApplyRunningServerSnapshot(target, snapshot) {
            return shouldApplyServerSnapshot({
                currentNotificationCount: state.notifications.length,
                snapshot,
                localSyncedAt: localStorage.getItem(
                    getServerSnapshotSyncedAtKey(target.snapshotKey)
                ),
            });
        }

        function isServerSnapshotUnavailable(error) {
            const message = error?.message || String(error);
            return error?.status === 503 || message.includes('No GitHub fetcher configured');
        }

        async function startServerSnapshotSync(target) {
            await fetchJson(target.syncUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(target.syncBody || { mode: 'full' }),
            });
        }

        async function pollServerSync(target, options = {}) {
            const syncLabel = options.syncLabel || 'Full Sync';
            const applySnapshot = options.applySnapshot !== false;
            while (true) {
                const data = await fetchJson(target.syncUrl);
                const sync = data.sync || {};
                if (sync.status === 'running') {
                    if (applySnapshot && shouldApplyRunningServerSnapshot(target, data.snapshot)) {
                        applyServerSnapshot(target, data.snapshot, {
                            lastSyncedRepo: options.lastSyncedRepo,
                            schedulePrefetch: false,
                            storageValue: options.storageValue,
                        });
                        render();
                    }
                    const detailText = formatServerSyncProgressDetails(sync);
                    showStatus(
                        `${syncLabel} running on server for ${target.label}${detailText}...`,
                        'info'
                    );
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                }
                if (sync.status === 'success') {
                    if (applySnapshot && applyServerSnapshot(target, data.snapshot, {
                        lastSyncedRepo: options.lastSyncedRepo,
                        storageValue: options.storageValue,
                    })) {
                        showStatus(`Synced ${state.notifications.length} notifications`, 'success');
                        render();
                    }
                    return {
                        data,
                        snapshot: data.snapshot,
                        sync,
                    };
                }
                if (sync.status === 'error') {
                    throw new Error(sync.error || 'Server sync failed');
                }
                return {
                    data,
                    snapshot: data.snapshot,
                    sync,
                };
            }
        }

        async function runServerSnapshotSyncForSource(source, options = {}) {
            const syncLabel = options.syncLabel || 'Full Sync';
            const fallbackMode = options.fallbackMode || null;
            const fallbackOnUnavailable = Boolean(options.fallbackOnUnavailable);
            const target = getRepoServerSnapshotTarget(source);
            if (!target) {
                showStatus('Invalid profile entry for server sync', 'error');
                return {
                    handled: true,
                };
            }
            const storageValue = options.storageValue || source.fullName || source.value;
            const profileSignature = getProfileSignature();
            const lastSyncedRepo =
                options.lastSyncedRepo ||
                getServerSnapshotLastSyncedRepo([source], profileSignature);
            state.repo = storageValue;
            localStorage.setItem(REPO_KEY, storageValue);
            state.loading = true;
            state.error = null;
            render();
            showStatus(`${syncLabel} starting on server for ${target.label}...`, 'info', { flash: true });

            try {
                await startServerSnapshotSync(target);
                showStatus(`${syncLabel} running on server for ${target.label}...`, 'info');
                await pollServerSync(target, { lastSyncedRepo, storageValue, syncLabel });
                return {
                    handled: true,
                };
            } catch (error) {
                const message = error.message || String(error);
                const unavailable = isServerSnapshotUnavailable(error);
                if (unavailable && fallbackOnUnavailable) {
                    state.loading = false;
                    render();
                    return {
                        handled: false,
                        unavailable: true,
                    };
                }
                if (unavailable && fallbackMode) {
                    state.loading = false;
                    render();
                    await handleSync({ mode: fallbackMode, allowServer: false });
                    return {
                        fallback: true,
                        handled: true,
                    };
                }
                state.error = message;
                showStatus(`${syncLabel} failed: ${message}`, 'error');
                return {
                    error,
                    handled: true,
                };
            } finally {
                state.loading = false;
                render();
            }
        }

        async function tryServerQuickSync(sources) {
            if (sources.length !== 1 || sources[0].kind !== 'repo') {
                return false;
            }
            const result = await runServerSnapshotSyncForSource(sources[0], {
                syncLabel: 'Quick Sync',
                fallbackOnUnavailable: true,
            });
            return result.handled;
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
            if (isSingleRepoSnapshotSource(sources)) {
                await runServerSnapshotSyncForSource(sources[0], {
                    syncLabel: 'Full Sync',
                    fallbackMode: 'full',
                });
                return;
            }

            const { storageValue, lastSyncedRepo } =
                getServerSnapshotApplyConfig(entries, sources);
            const target = getServerSnapshotTarget(sources);
            const syncEntries = buildServerProfileSyncEntries(sources);
            if (!target || syncEntries.length !== sources.length) {
                showStatus('Invalid profile entry for server sync', 'error');
                return;
            }
            target.syncBody = { mode: 'full', entries: syncEntries };
            state.repo = storageValue;
            localStorage.setItem(REPO_KEY, storageValue);
            state.loading = true;
            state.error = null;
            render();

            try {
                showStatus(
                    `Full Sync starting on server for ${target.label}...`,
                    'info',
                    { flash: true }
                );
                await startServerSnapshotSync(target);
                showStatus(`Full Sync running on server for ${target.label}...`, 'info');
                const result = await pollServerSync(target, {
                    lastSyncedRepo,
                    storageValue,
                    syncLabel: 'Full Sync',
                });
                if (!result.snapshot || !Array.isArray(result.snapshot.notifications)) {
                    showStatus('No server snapshot available', 'info');
                }
            } catch (error) {
                if (isServerSnapshotUnavailable(error)) {
                    state.loading = false;
                    render();
                    await handleSync({ mode: 'full', allowServer: false });
                    return;
                }
                const message = error.message || String(error);
                state.error = message;
                showStatus(`Full Sync failed: ${message}`, 'error');
            } finally {
                state.loading = false;
                render();
            }
        }

        async function handleServerSnapshotRefresh() {
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

            const { storageValue } = getServerSnapshotApplyConfig(entries, sources);
            state.repo = storageValue;
            localStorage.setItem(REPO_KEY, storageValue);
            state.loading = true;
            state.error = null;
            render();
            showStatus(`Loading server snapshot for ${storageValue}...`, 'info', { flash: true });

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
