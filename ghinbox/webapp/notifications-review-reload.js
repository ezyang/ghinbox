// Targeted review queue reload without doing a full notification sync.
(function () {
    const reloadReviewsBtn = document.getElementById('reload-reviews-btn');
    if (!reloadReviewsBtn) {
        return;
    }

    function readCurrentReviewEntries() {
        if (typeof getCurrentProfileEntries === 'function') {
            return getCurrentProfileEntries();
        }
        const raw = String(elements?.repoInput?.value || state?.repo || '');
        return raw
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    function getReviewReloadTarget(entries, sources) {
        const storageValue = entries.length === 1 ? entries[0] : entries.join('\n');
        const singleRepo = sources.length === 1 && sources[0].kind === 'repo'
            ? sources[0]
            : null;
        const cacheKey = singleRepo
            ? singleRepo.fullName
            : (typeof getProfileSignature === 'function'
                ? getProfileSignature()
                : storageValue);
        return {
            cacheKey,
            fullName: cacheKey,
            storageValue,
        };
    }

    function getCurrentReviewReloadConfig() {
        const entries = readCurrentReviewEntries();
        if (!entries.length) {
            return {
                error: 'Please enter a repository or query',
            };
        }
        if (typeof updateActiveProfileEntries === 'function') {
            updateActiveProfileEntries(entries);
        }
        const sources = entries.map((entry) =>
            typeof classifyProfileEntry === 'function'
                ? classifyProfileEntry(entry)
                : { kind: 'invalid', value: entry, query: entry }
        );
        const invalid = sources.find((source) => !source.value);
        if (invalid) {
            return {
                error: 'Invalid empty profile entry',
            };
        }
        const invalidFormat = sources.find((source) => source.kind === 'invalid');
        if (invalidFormat) {
            return {
                error: 'Invalid format: ' + invalidFormat.value,
            };
        }
        return {
            entries,
            sources,
            target: getReviewReloadTarget(entries, sources),
        };
    }

    function groupNotificationsByRepo(notifications) {
        const groups = new Map();
        notifications.forEach((notification) => {
            const repo = getNotificationRepoInfo(notification);
            if (!repo) {
                return;
            }
            const key = repo.fullName;
            if (!groups.has(key)) {
                groups.set(key, {
                    repoInfo: repo,
                    notifications: [],
                });
            }
            groups.get(key).notifications.push(notification);
        });
        return Array.from(groups.values());
    }

    function getReviewQueueNotifications(notifications) {
        const classifier = typeof makeNotificationClassifier === 'function'
            ? makeNotificationClassifier()
            : GhinboxFiltering.makeClassifier({
                currentUserLogin: state.currentUserLogin,
                commentCache: state.commentCache,
            });
        return notifications.filter((notification) =>
            classifier.isNotificationReviewQueue(notification)
        );
    }

    function sortNotificationsByUpdatedAt(notifications) {
        return notifications.sort((a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
    }

    function commitReloadedReviewNotifications(notifications, repo, { renderNow = true } = {}) {
        state.notifications = sortNotificationsByUpdatedAt(notifications);
        state.lastSyncedRepo = repo.cacheKey || repo.fullName;
        localStorage.setItem(LAST_SYNCED_REPO_KEY, state.lastSyncedRepo);
        persistNotifications();
        if (renderNow) {
            render();
        }
    }

    function seedSearchMetadataCache(notification) {
        if (!state.commentCache?.threads || typeof getNotificationKey !== 'function') {
            return;
        }
        const threadId = getNotificationKey(notification);
        const existing = state.commentCache.threads[threadId] || {};
        const nowIso = new Date().toISOString();
        const authorLogin = notification?.actors?.[0]?.login;
        const hasLabels = Array.isArray(notification?.labels);
        const labelNames = hasLabels
            ? notification.labels
                .map((label) => label?.name)
                .filter((name) => typeof name === 'string' && name.trim())
            : [];
        const next = {
            ...existing,
            notificationUpdatedAt: notification.updated_at || existing.notificationUpdatedAt,
        };
        if (authorLogin) {
            next.authorLogin = authorLogin;
            next.authorLoginFetchedAt = nowIso;
        }
        if (notification?.author_association !== undefined && notification?.author_association !== null) {
            next.authorAssociation = notification.author_association;
            next.authorAssociationFetchedAt = nowIso;
        }
        if (hasLabels) {
            next.labelNames = labelNames;
            next.labelNamesFetchedAt = nowIso;
        }
        state.commentCache.threads[threadId] = next;
    }

    async function fetchStreamingReviewRequestNotifications(source) {
        if (!state.currentUserLogin && typeof checkAuth === 'function') {
            await checkAuth();
        }
        const response = await fetch(
            GhinboxReviewRequests.buildReviewRequestSearchUrlForSource(source)
        );
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Review request search failed (${response.status}): ${detail}`);
        }
        const payload = await response.json();
        const notifications = Array.isArray(payload?.notifications) ? payload.notifications : [];
        notifications.forEach(seedSearchMetadataCache);
        return notifications;
    }

    async function refreshPullRequestStatesIncrementally(repo, repoInfo, matchKeys, syncLabel) {
        const targets = state.notifications.filter((notif) => {
            if (notif.subject?.type !== 'PullRequest') {
                return false;
            }
            if (typeof notif.subject?.number !== 'number') {
                return false;
            }
            return matchKeys.has(getNotificationMatchKeyForRepo(notif, repoInfo));
        });
        const uniqueNumbers = Array.from(
            new Set(targets.map((notif) => getIssueNumber(notif)).filter(Boolean))
        );
        if (!uniqueNumbers.length) {
            return;
        }

        const batchSize = 25;
        for (let i = 0; i < uniqueNumbers.length; i += batchSize) {
            const batch = uniqueNumbers.slice(i, i + batchSize);
            showStatus(
                `${syncLabel}: checking PR state ${Math.min(i + batch.length, uniqueNumbers.length)}/${uniqueNumbers.length}`,
                'info',
                { flash: true }
            );
            const data = await fetchGraphqlForSync(buildPullRequestStateQuery(batch), {
                owner: repoInfo.owner,
                name: repoInfo.repo,
            });
            const repoData = data?.repository || {};
            const updates = new Map();
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
            if (updates.size) {
                const notifications = state.notifications.map((notif) => {
                    const number = getIssueNumber(notif);
                    if (!number || !updates.has(number)) {
                        return notif;
                    }
                    if (!matchKeys.has(getNotificationMatchKeyForRepo(notif, repoInfo))) {
                        return notif;
                    }
                    const nextState = updates.get(number);
                    if (notif.subject?.state === nextState) {
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
                commitReloadedReviewNotifications(notifications, repo);
            }
        }
    }

    async function refreshReviewMetadataIncrementally(repo, repoInfo, notifications, syncLabel) {
        if (typeof buildReviewDecisionQuery !== 'function' ||
            typeof fetchGraphql !== 'function' ||
            typeof setReviewDecisionCache !== 'function') {
            return;
        }
        const issueNumbers = notifications
            .map((notif) => getIssueNumber(notif))
            .filter((issueNumber) => typeof issueNumber === 'number');
        const uniqueNumbers = Array.from(new Set(issueNumbers));
        if (!uniqueNumbers.length) {
            return;
        }

        const batchSize = typeof REVIEW_DECISION_BATCH_SIZE === 'number'
            ? REVIEW_DECISION_BATCH_SIZE
            : 40;
        for (let i = 0; i < uniqueNumbers.length; i += batchSize) {
            const batch = uniqueNumbers.slice(i, i + batchSize);
            showStatus(
                `${syncLabel}: refreshing review metadata ${Math.min(i + batch.length, uniqueNumbers.length)}/${uniqueNumbers.length}`,
                'info',
                { flash: true }
            );
            const data = await fetchGraphql(buildReviewDecisionQuery(batch), {
                owner: repoInfo.owner,
                name: repoInfo.repo,
            });
            const repoData = data?.repository || {};
            notifications.forEach((notif) => {
                const issueNumber = getIssueNumber(notif);
                if (!batch.includes(issueNumber)) {
                    return;
                }
                const entry = repoData[`pr${issueNumber}`] || {};
                const labelNames = Array.isArray(entry?.labels?.nodes)
                    ? entry.labels.nodes
                        .map((label) => label?.name)
                        .filter((name) => typeof name === 'string')
                    : [];
                setReviewDecisionCache(
                    notif,
                    entry?.reviewDecision ?? null,
                    entry?.authorAssociation ?? null,
                    entry?.author?.login ?? null,
                    labelNames,
                    { includeAuthorAssociation: true }
                );
                const threadId = getNotificationKey(notif);
                state.commentCache.threads[threadId] = {
                    ...state.commentCache.threads[threadId],
                    additions: entry?.additions ?? null,
                    deletions: entry?.deletions ?? null,
                    changedFiles: entry?.changedFiles ?? null,
                };
            });
            if (typeof saveCommentCache === 'function') {
                saveCommentCache();
            }
            render();
        }
    }

    async function refreshAuthorPermissionsIncrementally(repoInfo, notifications, syncLabel) {
        if (typeof prefetchAuthorPermissions !== 'function') {
            return;
        }
        showStatus(`${syncLabel}: checking author permissions`, 'info', { flash: true });
        await prefetchAuthorPermissions(repoInfo, notifications);
        if (typeof saveCommentCache === 'function') {
            saveCommentCache();
        }
        render();
    }

    function updateReloadReviewsButton() {
        reloadReviewsBtn.style.display =
            state?.view === 'others-prs' ? 'inline-flex' : 'none';
        reloadReviewsBtn.disabled = Boolean(state?.loading || state?.reviewsReloading);
    }

    async function handleReloadReviews() {
        const config = getCurrentReviewReloadConfig();
        if (config.error) {
            showStatus(config.error, 'error');
            return;
        }
        if (state.loading || state.reviewsReloading) {
            return;
        }

        const { sources, target } = config;
        const syncLabel = 'Reload Reviews';
        state.repo = target.storageValue;
        localStorage.setItem(REPO_KEY, target.storageValue);
        state.reviewsReloading = true;
        updateReloadReviewsButton();
        showStatus(`${syncLabel}: checking review requests assigned to you`, 'info');

        try {
            let reviewRequests = [];
            for (const source of sources) {
                const sourceReviewRequests =
                    await fetchStreamingReviewRequestNotifications(source);
                reviewRequests.push(...sourceReviewRequests);
            }
            let notifications = state.notifications
                .filter((notification) =>
                    !GhinboxReviewRequests.isSyntheticReviewRequest(notification)
                );
            for (const group of groupNotificationsByRepo(reviewRequests)) {
                notifications = mergeReviewRequestNotifications(
                    notifications,
                    group.notifications,
                    group.repoInfo
                );
            }
            commitReloadedReviewNotifications(notifications, target);
            showStatus(
                `${syncLabel}: loaded ${reviewRequests.length} active review request${reviewRequests.length === 1 ? '' : 's'}; refreshing metadata`,
                'info'
            );

            const reviewQueueNotifications = getReviewQueueNotifications(notifications);
            const authorPermissionPromises = [];
            for (const group of groupNotificationsByRepo(reviewQueueNotifications)) {
                const reviewQueueKeys = new Set(
                    group.notifications
                        .map((notification) =>
                            getNotificationMatchKeyForRepo(notification, group.repoInfo)
                        )
                        .filter(Boolean)
                );
                authorPermissionPromises.push(
                    refreshAuthorPermissionsIncrementally(
                        group.repoInfo,
                        group.notifications,
                        syncLabel
                    ).catch((error) => {
                        console.error('Review author permission refresh failed:', error);
                        showStatus(
                            `${syncLabel}: author permission check failed: ${error.message || error}`,
                            'error',
                            { flash: true }
                        );
                    })
                );
                await refreshPullRequestStatesIncrementally(
                    target,
                    group.repoInfo,
                    reviewQueueKeys,
                    syncLabel
                );
            }

            const refreshedReviewQueue = getReviewQueueNotifications(state.notifications);
            for (const group of groupNotificationsByRepo(refreshedReviewQueue)) {
                await refreshReviewMetadataIncrementally(
                    target,
                    group.repoInfo,
                    group.notifications,
                    syncLabel
                );
            }
            await Promise.all(authorPermissionPromises);

            const finalReviewQueue = getReviewQueueNotifications(state.notifications);
            commitReloadedReviewNotifications(state.notifications, target, { renderNow: false });
            showStatus(
                `Reloaded ${finalReviewQueue.length} review notification${finalReviewQueue.length === 1 ? '' : 's'}`,
                'success',
                { autoDismiss: true }
            );
        } catch (error) {
            console.error('Review reload failed:', error);
            showStatus(
                `${syncLabel} failed: ${error.message || error}`,
                'error'
            );
        } finally {
            state.reviewsReloading = false;
            render();
        }
    }

    reloadReviewsBtn.addEventListener('click', () => {
        withActionContext('Reload reviews', handleReloadReviews);
    });

    registerRenderHook(updateReloadReviewsButton);
    updateReloadReviewsButton();
})();
