        // Handle select all checkbox
        function handleSelectAll() {
            const filtered = getFilteredNotifications();
            const allSelected = filtered.every(n => state.selected.has(n.id));

            if (allSelected) {
                // Deselect all filtered
                filtered.forEach(n => state.selected.delete(n.id));
            } else {
                // Select all filtered
                filtered.forEach(n => state.selected.add(n.id));
            }

            state.lastClickedId = null;
            render();
        }

        // Handle individual notification checkbox click
        function handleNotificationCheckbox(notifId, event) {
            const filtered = getFilteredNotifications();
            const shouldSelect = event.target.checked;

            if (event.shiftKey && state.lastClickedId) {
                // Shift-click: apply the clicked state across the range.
                const applied = applyRangeSelection(
                    state.lastClickedId,
                    notifId,
                    filtered,
                    shouldSelect
                );
                if (!applied) {
                    setSelection(notifId, shouldSelect);
                }
            } else {
                // Regular click: match the checkbox state.
                setSelection(notifId, shouldSelect);
            }

            state.lastClickedId = notifId;
            render();
        }

        // Toggle a single notification's selection
        function toggleSelection(notifId) {
            if (state.selected.has(notifId)) {
                state.selected.delete(notifId);
            } else {
                state.selected.add(notifId);
            }
        }

        function setSelection(notifId, shouldSelect) {
            if (shouldSelect) {
                state.selected.add(notifId);
            } else {
                state.selected.delete(notifId);
            }
        }

        function buildNotificationActionLookup(notifIds, notificationLookup = null) {
            const lookup =
                notificationLookup instanceof Map ? new Map(notificationLookup) : new Map();
            notifIds.forEach((notifId) => {
                if (lookup.has(notifId)) {
                    return;
                }
                const notification = state.notifications.find(n => n.id === notifId);
                if (notification) {
                    lookup.set(notifId, notification);
                }
            });
            return lookup;
        }

        function getNotificationActionToken(action, notifIds, notificationLookup) {
            const firstNotification = notifIds
                .map(id => notificationLookup.get(id))
                .find(Boolean);
            return firstNotification?.ui?.action_tokens?.[action] || state.authenticity_token;
        }

        function readRetryAfterDelay(response) {
            const retryAfter = response.headers.get('Retry-After');
            return retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
        }

        async function postNotificationHtmlAction({
            action,
            notifIds,
            notificationLookup = null,
            persistWatermarks = false,
            parsedError = true,
            logLabel = null,
            successTarget = null,
        }) {
            const lookup = buildNotificationActionLookup(notifIds, notificationLookup);
            const authenticityToken = getNotificationActionToken(action, notifIds, lookup);

            if (!authenticityToken) {
                const error = `No authenticity token available for ${action} action`;
                if (logLabel) {
                    console.error(`[${logLabel}] ${error}`);
                }
                return { success: false, error };
            }

            const url = '/notifications/html/action';
            if (logLabel) {
                console.log(`[${logLabel}] HTML action request: POST ${url}`);
            }

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        action,
                        notification_ids: notifIds,
                        authenticity_token: authenticityToken,
                    }),
                });

                if (logLabel) {
                    console.log(
                        `[${logLabel}] HTML action response status: ${response.status} ${response.statusText}`
                    );
                }

                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    if (logLabel) {
                        console.warn(`[${logLabel}] Rate limited, retry after: ${retryAfter}s`);
                    }
                    return {
                        success: false,
                        rateLimited: true,
                        retryAfter: readRetryAfterDelay(response),
                    };
                }

                if (!response.ok) {
                    const actionError = await GhinboxHttp.readErrorDetail(response);
                    if (parsedError) {
                        if (logLabel) {
                            console.error(`[${logLabel}] ${actionError.message}`);
                        }
                        return {
                            success: false,
                            error: actionError.message,
                            status: response.status,
                            sessionExpired: actionError.sessionExpired,
                        };
                    }
                    const error = `HTTP ${response.status} ${response.statusText}`;
                    if (logLabel) {
                        console.error(`[${logLabel}] ${error}`, actionError.responseText);
                    }
                    return {
                        success: false,
                        error,
                        status: response.status,
                        responseBody: actionError.responseText,
                    };
                }

                const result = await response.json();
                if (result.status !== 'ok') {
                    const error = result.error || 'Unknown error from server';
                    if (logLabel) {
                        console.error(`[${logLabel}] Server error: ${error}`);
                    }
                    return { success: false, error };
                }

                if (persistWatermarks) {
                    await persistReadCommentWatermarks(notifIds, lookup);
                }
                if (logLabel) {
                    console.log(`[${logLabel}] HTML action success for ${successTarget || notifIds.length}`);
                }
                return { success: true };
            } catch (e) {
                const error = e.message || String(e);
                if (logLabel) {
                    console.error(`[${logLabel}] Exception:`, e);
                }
                return { success: false, error };
            }
        }

        // Apply a selection state across a range of notifications (for shift-click)
        function applyRangeSelection(fromId, toId, notifications, shouldSelect) {
            const ids = notifications.map(n => n.id);
            const fromIndex = ids.indexOf(fromId);
            const toIndex = ids.indexOf(toId);

            if (fromIndex === -1 || toIndex === -1) return false;

            const start = Math.min(fromIndex, toIndex);
            const end = Math.max(fromIndex, toIndex);

            for (let i = start; i <= end; i++) {
                setSelection(ids[i], shouldSelect);
            }
            return true;
        }

        // Clear all selections
        function clearSelection() {
            state.selected.clear();
            state.lastClickedId = null;
            render();
        }

        // Handle Mark Done button click
        function getMarkDoneTargets(filteredNotifications = getFilteredNotifications()) {
            if (state.view === 'cleaned') {
                return {
                    ids: [],
                    label: 'Mark selected as done',
                    show: false,
                };
            }
            const actionableNotifications = filteredNotifications.filter((notif) =>
                typeof hasNotificationHtmlAction !== 'function' ||
                hasNotificationHtmlAction(notif, 'archive')
            );
            if (state.selected.size > 0) {
                const actionableSelected = Array.from(state.selected).filter((id) => {
                    const notif = filteredNotifications.find((item) => item.id === id);
                    return notif && (
                        typeof hasNotificationHtmlAction !== 'function' ||
                        hasNotificationHtmlAction(notif, 'archive')
                    );
                });
                return {
                    ids: actionableSelected,
                    label: 'Mark selected as done',
                    show: actionableSelected.length > 0,
                };
            }
            if (actionableNotifications.length > 0) {
                return {
                    ids: actionableNotifications.map((notif) => notif.id),
                    label: 'Mark all as done',
                    show: true,
                };
            }
            return {
                ids: [],
                label: 'Mark selected as done',
                show: false,
            };
        }

        function getUnsubscribeAllTargets(filteredNotifications = getFilteredNotifications()) {
            if (state.view === 'cleaned') {
                return { ids: [], show: false };
            }
            // Only show when nothing is selected and we're in the approved filter
            if (state.selected.size > 0) {
                return { ids: [], show: false };
            }
            const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
            const stateFilter = viewFilters.state || 'all';
            if (stateFilter === 'approved' && filteredNotifications.length > 0) {
                return {
                    ids: filteredNotifications.map((notif) => notif.id),
                    show: true,
                };
            }
            return { ids: [], show: false };
        }

        function getOpenAllTargets(notifications = getFilteredNotifications()) {
            const openableNotifications = notifications.filter(
                (notif) => notif.subject && notif.subject.url
            );
            return {
                notifications: openableNotifications,
                show: openableNotifications.length > 0,
            };
        }

        // Shared done queue with bounded concurrency (pure state machine in
        // GhinboxDoneQueue; this file owns the per-item I/O).
        const doneQueue = GhinboxDoneQueue.createQueue();

        // Expose doneQueue on state for UI access
        state.doneQueue = doneQueue;

        function getCachedCommentIdSet(notification) {
            const cached = state.commentCache?.threads?.[getNotificationKey(notification)];
            const ids = new Set();
            if (Array.isArray(cached?.comments)) {
                cached.comments.forEach((comment) => {
                    if (comment.id != null) {
                        ids.add(Number(comment.id));
                    }
                });
            }
            return ids;
        }

        function enqueueDoneItems(ids, notificationLookup, options = {}) {
            doneQueue.sessionExpired = false;
            const items = ids.map(id => {
                const notification = notificationLookup.get(id);
                return {
                    notifId: id,
                    notification,
                    reloadedNotifications: options.reloadedNotifications || null,
                    cachedCommentIds: getCachedCommentIdSet(notification),
                };
            });
            GhinboxDoneQueue.enqueueItems(doneQueue, items);
        }

        function updateQueueProgress() {
            const status = GhinboxDoneQueue.getProgressStatus(doneQueue);
            if (status) {
                showStatus(status.message, status.type, { autoDismiss: status.autoDismiss });
            }
            render();
        }

        function showFinalQueueStatus() {
            if (doneQueue.sessionExpired) {
                const firstError = doneQueue.failedResults[0]?.error;
                GhinboxHttp.handleSessionExpired({
                    message: firstError || 'Stored browser session is expired.',
                    scheduleOnly: true,
                    state,
                    throwError: false,
                });
                return;
            }
            const status = GhinboxDoneQueue.getFinalStatus(doneQueue);
            showStatus(status.message, status.type, { autoDismiss: status.autoDismiss });
            if (status.type === 'error') {
                console.error('[MarkDone] Failures:', doneQueue.failedResults);
            }
        }

        async function processOneDoneItem(item) {
            const { notifId, notification, reloadedNotifications, cachedCommentIds } = item;
            try {
                const syncResult = await syncNotificationBeforeDone(notifId, notification, {
                    reloadedNotifications,
                    cachedCommentIds,
                });
                if (syncResult?.status === 'updated') {
                    GhinboxDoneQueue.recordSkipped(doneQueue);
                    return;
                }
                if (syncResult?.status === 'error') {
                    const errorDetail = syncResult.error || 'Failed to sync notification';
                    GhinboxDoneQueue.recordFailure(doneQueue, notifId, errorDetail);
                    return;
                }

                const result = await markNotificationDone(
                    notifId,
                    syncResult.updatedNotification || notification
                );

                if (result.rateLimited) {
                    // Re-enqueue with delay
                    const delay = result.retryAfter || 60000;
                    showStatus(`Rate limited. Waiting ${Math.ceil(delay / 1000)}s...`, 'info');
                    await sleep(delay);
                    GhinboxDoneQueue.requeueItem(doneQueue, item);
                    return;
                }

                if (result.success) {
                    GhinboxDoneQueue.recordSuccess(doneQueue, notifId);
                } else if (result.sessionExpired) {
                    doneQueue.sessionExpired = true;
                    const errorDetail = result.error || 'Stored browser session is expired.';
                    GhinboxDoneQueue.recordFailure(doneQueue, notifId, errorDetail);
                } else {
                    const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                    console.error(`[MarkDone] Failed for ${notifId}:`, errorDetail);
                    GhinboxDoneQueue.recordFailure(doneQueue, notifId, errorDetail);
                }
            } catch (e) {
                const errorDetail = e.message || String(e);
                console.error(`[MarkDone] Exception for ${notifId}:`, e);
                GhinboxDoneQueue.recordFailure(doneQueue, notifId, errorDetail);
            }
        }

        function processDoneQueue() {
            return GhinboxDoneQueue.processQueue(doneQueue, processOneDoneItem, {
                onProgress: updateQueueProgress,
            });
        }

        async function markNotificationsDoneBatch(notifIds, notificationLookup) {
            return postNotificationHtmlAction({
                action: 'archive',
                notifIds,
                notificationLookup,
                persistWatermarks: true,
                parsedError: true,
            });
        }

        async function persistReadCommentWatermarks(notifIds, notificationLookup) {
            const readAt = new Date().toISOString();
            const results = await Promise.allSettled(
                notifIds.map(async (notifId) => {
                    const notification = notificationLookup?.get(notifId);
                    const repo = getNotificationRepoInfo(notification) ||
                        parseRepoInput(state.repo || state.lastSyncedRepo || '');
                    if (!repo) {
                        return;
                    }
                    if (notification) {
                        notification.ui = {
                            ...(notification.ui || {}),
                            read_comment_watermark_at: readAt,
                        };
                    }
                    await fetchJson(
                        `/notifications/html/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/read-comment-watermarks/${encodeURIComponent(notifId)}`,
                        {
                            method: 'PUT',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                read_comment_watermark_at: readAt,
                            }),
                        }
                    );
                })
            );
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.warn(
                        `[MarkDone] Failed to save read comment watermark for ${notifIds[index]}:`,
                        result.reason
                    );
                }
            });
        }

        async function processDoneBatch(selectedIds, notificationLookup) {
            doneQueue.sessionExpired = false;
            GhinboxDoneQueue.resetForBatch(doneQueue, selectedIds.length);
            updateQueueProgress();

            try {
                while (true) {
                    const result = await markNotificationsDoneBatch(
                        selectedIds,
                        notificationLookup
                    );

                    if (result.rateLimited) {
                        const delay = result.retryAfter || 60000;
                        showStatus(
                            `Rate limited. Waiting ${Math.ceil(delay / 1000)}s...`,
                            'info'
                        );
                        await sleep(delay);
                        continue;
                    }

                    if (result.success) {
                        GhinboxDoneQueue.recordBatchSuccess(doneQueue, selectedIds);
                    } else if (result.sessionExpired) {
                        doneQueue.sessionExpired = true;
                        const errorDetail = result.error || 'Stored browser session is expired.';
                        GhinboxDoneQueue.recordBatchFailure(doneQueue, selectedIds, errorDetail);
                    } else {
                        const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                        GhinboxDoneQueue.recordBatchFailure(doneQueue, selectedIds, errorDetail);
                    }
                    break;
                }
            } finally {
                doneQueue.active = false;
                updateQueueProgress();
            }
        }

        async function handleMarkDone() {
            const filteredNotifications = getFilteredNotifications();
            const { ids, show } = getMarkDoneTargets(filteredNotifications);
            if (!show || ids.length === 0) return;

            const selectedIds = ids;
            const notificationLookup = new Map(
                state.notifications.map(notification => [notification.id, notification])
            );

            // Remove all selected notifications from UI immediately (optimistic update)
            const notificationsToRestore = selectedIds
                .map(id => notificationLookup.get(id))
                .filter(Boolean);
            const undoEntry = pushToUndoStack('done', notificationsToRestore);

            const selectedIdSet = new Set(selectedIds);
            const scrollAnchor = captureScrollAnchor(selectedIdSet);
            state.notifications = state.notifications.filter(
                notif => !selectedIdSet.has(notif.id)
            );

            // Clear selection for removed items
            selectedIds.forEach(id => state.selected.delete(id));

            // Update localStorage
            persistNotifications();
            render();
            restoreScrollAnchor(scrollAnchor);

            await processDoneBatch(selectedIds, notificationLookup);

            // Restore failed items
            if (doneQueue.failedResults.length > 0) {
                const failedNotifications = doneQueue.failedResults
                    .map(result => notificationLookup.get(result.id))
                    .filter(Boolean);
                restoreNotificationsInOrder(failedNotifications);
                failedNotifications.forEach(notification => state.selected.add(notification.id));
                persistNotifications();
            }

            // Show final status
            showFinalQueueStatus();

            const notificationsForUndo = doneQueue.successfulIds
                .map(id => notificationLookup.get(id))
                .filter(Boolean);
            updateUndoEntry(undoEntry, notificationsForUndo);

            await refreshRateLimit();
            render();
        }

        function handleOpenAllFiltered() {
            const { notifications, show } = getOpenAllTargets();
            if (!show) return;

            const urls = Array.from(
                new Set(notifications.map((notif) => notif.subject.url).filter(Boolean))
            );
            if (urls.length === 0) {
                return;
            }
            if (urls.length >= 10) {
                const confirmed = confirm(
                    `Open ${urls.length} notifications in new tabs?`
                );
                if (!confirmed) return;
            }

            const openAllStamp = Date.now();
            let openedCount = 0;
            let blockedCount = 0;
            urls.forEach((url, index) => {
                const windowName = `ghinbox-open-${openAllStamp}-${index}`;
                const openedWindow = window.open(url, windowName, 'noopener');
                if (openedWindow) {
                    openedCount += 1;
                } else {
                    blockedCount += 1;
                }
            });
            if (blockedCount > 0) {
                const openedLabel = openedCount
                    ? `Opened ${openedCount} notification${openedCount !== 1 ? 's' : ''}, but `
                    : '';
                showStatus(
                    `${openedLabel}${blockedCount} ${blockedCount !== 1 ? 'tabs were' : 'tab was'} blocked. Allow pop-ups to open all notifications.`,
                    'info'
                );
                return;
            }
            showStatus(
                `Opened ${openedCount} notification${openedCount !== 1 ? 's' : ''}`,
                'success',
                { autoDismiss: true }
            );
        }

        async function handleUnsubscribeAll() {
            if (state.unsubscribeInProgress) return;

            const filteredNotifications = getFilteredNotifications();
            const { ids, show } = getUnsubscribeAllTargets(filteredNotifications);
            if (!show || ids.length === 0) return;

            const selectedIds = ids;
            const notificationLookup = new Map(
                state.notifications.map(notification => [notification.id, notification])
            );

            // Confirm before unsubscribing
            if (selectedIds.length >= 3) {
                const confirmed = confirm(
                    `Are you sure you want to unsubscribe from ${selectedIds.length} notifications?`
                );
                if (!confirmed) return;
            }

            state.unsubscribeInProgress = true;

            // Save notifications for potential restoration
            const notificationsToSave = selectedIds
                .map(id => notificationLookup.get(id))
                .filter(Boolean);

            // Remove from UI immediately (optimistic update)
            const selectedIdSet = new Set(selectedIds);
            state.notifications = state.notifications.filter(
                notif => !selectedIdSet.has(notif.id)
            );
            selectedIds.forEach(id => state.selected.delete(id));
            persistNotifications();
            const undoEntry = notificationsToSave.length > 0
                ? pushToUndoStack('unsubscribe', notificationsToSave)
                : null;
            render();

            // Process unsubscribes in background
            const successfulIds = [];
            const failedResults = [];
            let rateLimitDelay = 0;

            for (let i = 0; i < selectedIds.length; i++) {
                const notifId = selectedIds[i];

                if (rateLimitDelay > 0) {
                    await sleep(rateLimitDelay);
                    rateLimitDelay = 0;
                }

                try {
                    const notification = notificationLookup.get(notifId);
                    const result = await unsubscribeNotification(notifId, notification);

                    if (result.rateLimited) {
                        rateLimitDelay = result.retryAfter || 60000;
                        showStatus(`Rate limited. Waiting ${Math.ceil(rateLimitDelay / 1000)}s...`, 'info');
                        i--;
                        continue;
                    }

                    if (result.success) {
                        successfulIds.push(notifId);
                    } else {
                        const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                        console.error(`[UnsubscribeAll] Failed for ${notifId}:`, errorDetail);
                        failedResults.push({ id: notifId, error: errorDetail });
                    }
                } catch (e) {
                    const errorDetail = e.message || String(e);
                    console.error(`[UnsubscribeAll] Exception for ${notifId}:`, e);
                    failedResults.push({ id: notifId, error: errorDetail });
                }

                // Small delay between requests to avoid rate limiting
                if (i < selectedIds.length - 1) {
                    await sleep(100);
                }
            }

            // Enqueue successfully unsubscribed notifications for mark-done via the shared queue
            if (successfulIds.length > 0) {
                enqueueDoneItems(successfulIds, notificationLookup);
                // Fire and forget - don't await, let it process in the background
                processDoneQueue();
            }

            // Restore failed items to UI
            if (failedResults.length > 0) {
                const failedIdSet = new Set(failedResults.map(r => r.id));
                const notificationsToRestore = notificationsToSave.filter(n => failedIdSet.has(n.id));
                if (notificationsToRestore.length > 0) {
                    restoreNotificationsInOrder(notificationsToRestore);
                    persistNotifications();
                    render();
                }
            }

            // Reset unsubscribe state
            state.unsubscribeInProgress = false;

            // Show result message with details
            if (failedResults.length === 0) {
                showStatus(
                    `Unsubscribed from ${successfulIds.length} notification${successfulIds.length !== 1 ? 's' : ''}`,
                    'success',
                    { autoDismiss: true }
                );
            } else if (successfulIds.length === 0) {
                const firstError = failedResults[0].error;
                showStatus(`Failed to unsubscribe: ${firstError}`, 'error');
                console.error('[UnsubscribeAll] All failed. Errors:', failedResults);
            } else {
                const firstError = failedResults[0].error;
                showStatus(`Unsubscribed from ${successfulIds.length}, ${failedResults.length} failed: ${firstError}`, 'error');
                console.error('[UnsubscribeAll] Partial failure. Errors:', failedResults);
            }

            // Update undo: remove if all failed, trim to successful if partial
            if (failedResults.length > 0 && successfulIds.length === 0) {
                removeUndoEntry(undoEntry);
            } else if (failedResults.length > 0) {
                const successfulIdSet2 = new Set(successfulIds);
                updateUndoEntry(undoEntry, notificationsToSave.filter(n => successfulIdSet2.has(n.id)));
            }

            await refreshRateLimit();
        }

        // Sleep helper for delays
        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        function ensureCurrentUserLogin() {
            if (state.currentUserLogin) {
                return state.currentUserLogin;
            }
            const cachedLogin = typeof getCachedAuth === 'function'
                ? getCachedAuth()?.login
                : null;
            if (cachedLogin) {
                state.currentUserLogin = cachedLogin;
            }
            return state.currentUserLogin;
        }

        async function reloadNotificationsFromServer() {
            const entries = typeof getCurrentProfileEntries === 'function'
                ? getCurrentProfileEntries()
                : [state.repo || ''];
            if (entries.length !== 1) {
                return { status: 'error', error: 'Reload requires a single repository profile.' };
            }
            const repo = parseRepoInput(entries[0] || '');
            if (!repo) {
                return { status: 'error', error: 'Missing repository.' };
            }
            let payload;
            try {
                const url = `/notifications/html/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
                payload = await fetchJson(url);
            } catch (error) {
                return { status: 'error', error: error.message || String(error) };
            }
            if (payload?.authenticity_token) {
                state.authenticity_token = payload.authenticity_token;
                persistAuthenticityToken(payload.authenticity_token);
            }
            const notifications = Array.isArray(payload?.notifications) ? payload.notifications : [];
            return { status: 'ok', notifications };
        }

        async function reloadNotificationFromServer(notification, options = {}) {
            if (!notification) {
                return { status: 'error', error: 'Missing notification.' };
            }
            let notifications = options.reloadedNotifications;
            if (!Array.isArray(notifications)) {
                const result = await reloadNotificationsFromServer();
                if (result.status !== 'ok') {
                    return result;
                }
                notifications = result.notifications;
            }
            let updated = notifications.find((candidate) => candidate.id === notification.id);
            if (!updated && typeof getNotificationMatchKey === 'function') {
                const matchKey = getNotificationMatchKey(notification);
                if (matchKey) {
                    updated = notifications.find(
                        (candidate) => getNotificationMatchKey(candidate) === matchKey
                    );
                }
            }
            if (!updated) {
                return { status: 'missing' };
            }
            return { status: 'ok', notification: updated };
        }

        async function syncNotificationBeforeDone(notifId, notification, options = {}) {
            try {
                // First, do HTML pull to check if notification is already Done on GitHub
                const reloadResult = await reloadNotificationFromServer(notification, {
                    reloadedNotifications: options.reloadedNotifications,
                });

                // If notification is missing from HTML response, it's already Done on GitHub
                if (reloadResult?.status === 'missing') {
                    return { status: 'ok' };
                }

                // If there was an error reloading, report it
                if (reloadResult?.status === 'error') {
                    return {
                        status: 'error',
                        error: reloadResult.error || 'Failed to reload notification.',
                    };
                }

                // Notification is still present - check for new comments by comparing IDs
                const refreshedNotification = reloadResult?.notification || notification;
                const commentCheck = await hasNewCommentsRelativeToCache(refreshedNotification, {
                    cachedCommentIds: options.cachedCommentIds,
                });

                if (!commentCheck || commentCheck.status !== 'ok') {
                    return {
                        status: 'error',
                        error: commentCheck?.error || 'Unable to verify new comments.',
                    };
                }

                if (!commentCheck.hasNew || commentCheck.allowDone) {
                    // No new interesting comments - allow Done
                    if (refreshedNotification) {
                        const index = state.notifications.findIndex(n => n.id === refreshedNotification.id);
                        if (index !== -1) {
                            state.notifications[index] = refreshedNotification;
                            persistNotifications();
                        }
                    }
                    return { status: 'ok', updatedNotification: refreshedNotification };
                }

                // There are new interesting comments - block Done and show them
                if (refreshedNotification) {
                    const index = state.notifications.findIndex(n => n.id === refreshedNotification.id);
                    if (index !== -1) {
                        state.notifications[index] = refreshedNotification;
                        persistNotifications();
                    }
                    if (typeof prefetchNotificationComments === 'function') {
                        await prefetchNotificationComments(refreshedNotification);
                        if (typeof saveCommentCache === 'function') {
                            saveCommentCache();
                        }
                    }
                }

                return {
                    status: 'updated',
                    reason: 'New comments detected',
                    updatedNotification: refreshedNotification,
                };
            } catch (error) {
                return { status: 'error', error: error.message || String(error) };
            }
        }

        async function hasNewCommentsRelativeToCache(notification, options = {}) {
            const repo = getNotificationRepoInfo(notification);
            const issueNumber = getIssueNumber(notification);
            if (!repo || !issueNumber) {
                return {
                    status: 'error',
                    error: 'Missing repository or issue number.',
                };
            }

            try {
                // Fetch all comments for the issue
                const commentUrl = `/github/rest/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${issueNumber}/comments`;
                const allComments = await fetchJson(commentUrl);
                if (!Array.isArray(allComments)) {
                    return {
                        status: 'error',
                        error: 'Unexpected comment response.',
                    };
                }

                const cachedCommentIds =
                    options.cachedCommentIds instanceof Set
                        ? options.cachedCommentIds
                        : getCachedCommentIdSet(notification);

                // Find truly new comments (IDs we haven't seen)
                const newComments = allComments.filter(comment => {
                    const commentId = comment.id != null ? Number(comment.id) : null;
                    return commentId && !cachedCommentIds.has(commentId);
                });

                if (newComments.length === 0) {
                    return { status: 'ok', hasNew: false, allowDone: true };
                }

                // Check if all new comments are from current user or uninteresting
                const currentUser = String(ensureCurrentUserLogin() || '').toLowerCase();
                const allowDone = newComments.every((comment) => {
                    const author = String(comment?.user?.login || '').toLowerCase();
                    const isOwn = Boolean(currentUser) && author === currentUser;
                    const isUninteresting =
                        typeof isUninterestingComment === 'function'
                            ? isUninterestingComment(comment)
                            : false;
                    return isOwn || isUninteresting;
                });

                return { status: 'ok', hasNew: true, allowDone };
            } catch (error) {
                console.error('[MarkDone] Comment sync failed:', error);
                return {
                    status: 'error',
                    error: error.message || String(error),
                };
            }
        }

        // Mark a single notification as done using the HTML action endpoint
        // notification parameter is optional - if provided, use it; otherwise look up from state
        async function markNotificationDone(notifId, notification = null) {
            console.log(`[MarkDone] Attempting to mark notification: ${notifId}`);

            const notif = notification || state.notifications.find(n => n.id === notifId);
            const notificationLookup = new Map();
            if (notif) {
                notificationLookup.set(notifId, notif);
            }
            return postNotificationHtmlAction({
                action: 'archive',
                notifIds: [notifId],
                notificationLookup,
                persistWatermarks: true,
                parsedError: true,
                logLabel: 'MarkDone',
                successTarget: notifId,
            });
        }

        // notification parameter is optional - if provided, use it; otherwise look up from state
        async function unsubscribeNotification(notifId, notification = null) {
            console.log(`[Unsubscribe] Attempting to unsubscribe: ${notifId}`);

            const notif = notification || state.notifications.find(n => n.id === notifId);
            const notificationLookup = new Map();
            if (notif) {
                notificationLookup.set(notifId, notif);
            }
            return postNotificationHtmlAction({
                action: 'unsubscribe',
                notifIds: [notifId],
                notificationLookup,
                persistWatermarks: false,
                parsedError: false,
                logLabel: 'Unsubscribe',
                successTarget: notifId,
            });
        }

        // Helper function to extract PR info from notification
        function extractPRInfo(notification) {
            const match = notification.subject.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
            if (!match) {
                throw new Error('Invalid PR URL');
            }
            return {
                owner: match[1],
                repo: match[2],
                prNumber: parseInt(match[3], 10)
            };
        }

        // Remove current user as reviewer from a PR using the REST API
        async function removeReviewer(owner, repo, prNumber, username) {
            console.log(`[RemoveReviewer] Removing ${username} from PR ${owner}/${repo}#${prNumber}`);

            const url = `/github/rest/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`;
            console.log(`[RemoveReviewer] REST request: DELETE ${url}`);

            const response = await fetch(url, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    reviewers: [username]
                }),
            });

            console.log(`[RemoveReviewer] Response status: ${response.status}`);

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                console.warn(`[RemoveReviewer] Rate limited, retry after: ${retryAfter}s`);
                return {
                    success: false,
                    rateLimited: true,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000
                };
            }

            if (!response.ok && response.status !== 204) {
                const responseText = await response.text();
                const error = `REST error: ${response.status} ${response.statusText}`;
                console.error(`[RemoveReviewer] ${error}`, responseText);
                return {
                    success: false,
                    error,
                    status: response.status
                };
            }

            console.log(`[RemoveReviewer] Success`);
            return { success: true };
        }

        // Handle inline Mark Done button click for a single notification
        async function handleInlineMarkDone(notifId, button) {
            button.disabled = true;

            // Find and save the notification for undo before removing
            const notificationToRemove = state.notifications.find(n => n.id === notifId);
            const notificationLookup = new Map();
            if (notificationToRemove) {
                notificationLookup.set(notifId, notificationToRemove);
            }

            // Remove from UI immediately (optimistic update)
            const filteredBeforeRemoval = getFilteredNotifications();
            const scrollAnchor = captureScrollAnchor(notifId);
            advanceActiveNotificationBeforeRemoval(notifId, filteredBeforeRemoval);
            state.notifications = state.notifications.filter(
                n => n.id !== notifId
            );
            state.selected.delete(notifId);
            persistNotifications();
            const undoEntry = notificationToRemove
                ? pushToUndoStack('done', [notificationToRemove])
                : null;
            render();
            restoreScrollAnchor(scrollAnchor);

            // Enqueue and process - fire and forget (don't block UI)
            enqueueDoneItems([notifId], notificationLookup);
            await processDoneQueue();

            // After queue drains, check results for this item
            const failed = doneQueue.failedResults.find(r => r.id === notifId);
            const skipped = !failed && !doneQueue.successfulIds.includes(notifId);

            if (failed) {
                if (doneQueue.sessionExpired) {
                    if (notificationToRemove) {
                        restoreNotificationsInOrder([notificationToRemove]);
                        persistNotifications();
                        render();
                    }
                    removeUndoEntry(undoEntry);
                    button.disabled = false;
                    GhinboxHttp.handleSessionExpired({
                        message: failed.error || 'Stored browser session is expired.',
                        scheduleOnly: true,
                        state,
                        throwError: false,
                    });
                    return;
                }
                showStatus(`Failed to mark notification: ${failed.error}`, 'error');
                if (notificationToRemove) {
                    restoreNotificationsInOrder([notificationToRemove]);
                    persistNotifications();
                    render();
                }
                removeUndoEntry(undoEntry);
                button.disabled = false;
                return;
            }

            if (skipped) {
                // Skipped due to new comments
                showStatus('New comments detected. Skipped marking done.', 'info', { autoDismiss: true });
                removeUndoEntry(undoEntry);
                button.disabled = false;
                return;
            }

            // Success
            showFinalQueueStatus();
            await refreshRateLimit();
        }

        async function handleInlineUnsubscribe(notifId, button) {
            button.disabled = true;

            // Find and save the notification for undo before removing
            const notificationToRemove = state.notifications.find(n => n.id === notifId);

            // Remove from UI immediately (optimistic update)
            const filteredBeforeRemoval = getFilteredNotifications();
            const scrollAnchor = captureScrollAnchor(notifId);
            advanceActiveNotificationBeforeRemoval(notifId, filteredBeforeRemoval);
            state.notifications = state.notifications.filter(n => n.id !== notifId);
            state.selected.delete(notifId);
            persistNotifications();
            const undoEntry = notificationToRemove
                ? pushToUndoStack('unsubscribe', [notificationToRemove])
                : null;
            render();
            restoreScrollAnchor(scrollAnchor);

            try {
                const result = await unsubscribeNotification(notifId, notificationToRemove);

                if (result.rateLimited || !result.success) {
                    const msg = result.rateLimited
                        ? 'Rate limited. Please try again shortly.'
                        : `Failed to unsubscribe: ${result.error || `HTTP ${result.status || 'unknown'}`}`;
                    showStatus(msg, result.rateLimited ? 'info' : 'error');
                    if (notificationToRemove) {
                        restoreNotificationsInOrder([notificationToRemove]);
                        persistNotifications();
                        render();
                    }
                    removeUndoEntry(undoEntry);
                    return;
                }

                // Enqueue mark-done into the shared queue
                const notificationLookup = new Map();
                if (notificationToRemove) {
                    notificationLookup.set(notifId, notificationToRemove);
                }
                enqueueDoneItems([notifId], notificationLookup);
                // Fire and forget - don't await
                processDoneQueue();
            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Failed to unsubscribe: ${errorDetail}`, 'error');
                if (notificationToRemove) {
                    restoreNotificationsInOrder([notificationToRemove]);
                    persistNotifications();
                    render();
                }
                removeUndoEntry(undoEntry);
                return;
            }

            await refreshRateLimit();
        }

        // Handle inline Remove Reviewer button click for a single notification
        async function handleInlineRemoveReviewer(notifId, button) {
            button.disabled = true;

            const notification = state.notifications.find(n => n.id === notifId);
            if (!notification) {
                showStatus('Notification not found', 'error');
                button.disabled = false;
                return;
            }

            let owner, repo, prNumber;
            try {
                ({ owner, repo, prNumber } = extractPRInfo(notification));
            } catch (e) {
                showStatus(`Failed: ${e.message || String(e)}`, 'error');
                button.disabled = false;
                return;
            }

            const currentUser = ensureCurrentUserLogin();
            if (!currentUser) {
                showStatus('Unable to determine current user. Make sure you are authenticated (check top-left status).', 'error');
                button.disabled = false;
                return;
            }

            // Remove from UI immediately (optimistic update)
            const filteredBeforeRemoval = getFilteredNotifications();
            const scrollAnchor = captureScrollAnchor(notifId);
            advanceActiveNotificationBeforeRemoval(notifId, filteredBeforeRemoval);
            state.notifications = state.notifications.filter(n => n.id !== notifId);
            state.selected.delete(notifId);
            persistNotifications();
            const undoEntry = pushToUndoStack('remove_reviewer', [notification]);
            render();
            restoreScrollAnchor(scrollAnchor);

            try {
                // Remove reviewer
                const removeResult = await removeReviewer(owner, repo, prNumber, currentUser);

                if (removeResult.rateLimited) {
                    showStatus('Rate limited. Please try again shortly.', 'info');
                    restoreNotificationsInOrder([notification]);
                    persistNotifications();
                    removeUndoEntry(undoEntry);
                    render();
                    return;
                }

                // If removal failed, show message but continue with unsubscribe
                if (!removeResult.success) {
                    const errorDetail = removeResult.error || `HTTP ${removeResult.status || 'unknown'}`;
                    showStatus(`Failed to remove reviewer: ${errorDetail}. Proceeding with unsubscribe...`, 'info');
                }

                const canUnsubscribe =
                    typeof hasNotificationHtmlAction === 'function' &&
                    hasNotificationHtmlAction(notification, 'unsubscribe');
                const canMarkDone =
                    typeof hasNotificationHtmlAction !== 'function' ||
                    hasNotificationHtmlAction(notification, 'archive');

                if (canUnsubscribe) {
                    const unsubResult = await unsubscribeNotification(notifId, notification);

                    if (unsubResult.rateLimited || !unsubResult.success) {
                        const msg = unsubResult.rateLimited
                            ? 'Rate limited. Please try again shortly.'
                            : `Failed to unsubscribe: ${unsubResult.error || `HTTP ${unsubResult.status || 'unknown'}`}`;
                        showStatus(msg, unsubResult.rateLimited ? 'info' : 'error');
                        restoreNotificationsInOrder([notification]);
                        persistNotifications();
                        removeUndoEntry(undoEntry);
                        render();
                        return;
                    }
                }

                if (canMarkDone) {
                    const notificationLookup = new Map();
                    notificationLookup.set(notifId, notification);
                    enqueueDoneItems([notifId], notificationLookup);
                    processDoneQueue();
                }
            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Failed: ${errorDetail}`, 'error');
                restoreNotificationsInOrder([notification]);
                persistNotifications();
                removeUndoEntry(undoEntry);
                render();
                return;
            }

            await refreshRateLimit();
        }

        function clearUndoState() {
            state.undoStack = [];
            state.undoInProgress = false;
        }

        function restoreNotificationsInOrder(notifications) {
            GhinboxUndo.insertByUpdatedAt(state.notifications, notifications);
        }

        function removeTrashNotifications(notifications) {
            const ids = new Set(
                notifications
                    .map(notification => notification?.id)
                    .filter(Boolean)
            );
            if (ids.size === 0 || !Array.isArray(state.trashNotifications)) {
                return;
            }
            state.trashNotifications = state.trashNotifications.filter(
                notification => !ids.has(notification.id)
            );
        }

        function pushToUndoStack(action, notifications) {
            return GhinboxUndo.pushEntry(state.undoStack, action, notifications, Date.now());
        }

        function removeUndoEntry(undoEntry) {
            GhinboxUndo.removeEntry(state.undoStack, undoEntry);
        }

        function updateUndoEntry(undoEntry, notifications) {
            GhinboxUndo.updateEntry(state.undoStack, undoEntry, notifications);
        }

        async function parseUndoResponse(response) {
            let result = null;
            try {
                result = await response.json();
            } catch (e) {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                throw new Error('Invalid response from server');
            }

            if (!response.ok) {
                const errorDetail =
                    result.error || result.detail || `HTTP ${response.status}`;
                throw new Error(errorDetail);
            }
            if (!result || result.status !== 'ok') {
                throw new Error(result?.error || 'Unknown error');
            }
            return result;
        }

        async function handleUndo() {
            if (state.undoStack.length === 0 || state.undoInProgress) {
                return;
            }

            const undoItem = state.undoStack[state.undoStack.length - 1];
            if (!undoItem) {
                return;
            }

            // Check if undo is still valid (within 30 seconds)
            if (GhinboxUndo.isExpired(undoItem, Date.now())) {
                showStatus('Undo expired. Actions can only be undone within 30 seconds.', 'info');
                state.undoStack.pop();
                return;
            }

            state.undoInProgress = true;
            showStatus('Undo in progress...', 'info');

            try {
                const action = GhinboxUndo.getUndoAction(undoItem.action);
                const { groups: notificationsByToken, missingToken } = GhinboxUndo.groupByToken(
                    undoItem.notifications,
                    action,
                    state.authenticity_token
                );

                if (missingToken) {
                    showStatus(
                        'Cannot undo: no authenticity token available. Try syncing first.',
                        'error'
                    );
                    return;
                }

                const restoredNotifications = [];
                const failedNotifications = [];
                let errorDetail = null;

                for (const [token, notifications] of notificationsByToken.entries()) {
                    try {
                        const response = await fetch('/notifications/html/action', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                action: action,
                                notification_ids: notifications.map(
                                    notification => notification.id
                                ),
                                authenticity_token: token,
                            }),
                        });
                        await parseUndoResponse(response);
                        restoredNotifications.push(...notifications);
                    } catch (e) {
                        errorDetail = e.message || String(e);
                        failedNotifications.push(...notifications);
                    }
                }

                if (restoredNotifications.length > 0) {
                    removeTrashNotifications(restoredNotifications);
                    restoreNotificationsInOrder(restoredNotifications);
                    persistNotifications();
                    render();
                }

                if (failedNotifications.length === 0) {
                    state.undoStack.pop();
                } else {
                    updateUndoEntry(undoItem, failedNotifications);
                }
                const status = GhinboxUndo.getCompletionStatus({
                    restoredCount: restoredNotifications.length,
                    failedCount: failedNotifications.length,
                    errorDetail,
                });
                showStatus(status.message, status.type, { autoDismiss: status.autoDismiss });

            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Undo failed: ${errorDetail}`, 'error');
            } finally {
                state.undoInProgress = false;
            }
        }
