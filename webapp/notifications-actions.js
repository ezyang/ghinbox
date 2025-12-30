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
            if (state.selected.size > 0) {
                return {
                    ids: Array.from(state.selected),
                    label: 'Mark selected as done',
                    show: true,
                };
            }
            if (filteredNotifications.length > 0) {
                return {
                    ids: filteredNotifications.map((notif) => notif.id),
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

        function updateDoneSnapshotStatus() {
            const pending = state.doneSnapshot.pending;
            const done = state.doneSnapshot.done;
            const total = pending + done;
            if (total === 0) {
                return;
            }
            showStatus(`Done ${done}/${total} (${pending} pending)`, 'success', {
                autoDismiss: pending === 0,
            });
        }

        function queueDoneSnapshot(count) {
            state.doneSnapshot.pending += count;
            updateDoneSnapshotStatus();
        }

        function resolveDoneSnapshot(success, options = {}) {
            state.doneSnapshot.pending = Math.max(0, state.doneSnapshot.pending - 1);
            if (success) {
                state.doneSnapshot.done += 1;
            }
            if (options.suppressStatus) {
                return;
            }
            updateDoneSnapshotStatus();
        }

        async function handleMarkDone() {
            if (state.markingInProgress) return;

            const filteredNotifications = getFilteredNotifications();
            const { ids, show } = getMarkDoneTargets(filteredNotifications);
            if (!show || ids.length === 0) return;

            const selectedIds = ids;
            const notificationLookup = new Map(
                state.notifications.map(notification => [notification.id, notification])
            );

            // Confirm if marking many items
            if (selectedIds.length >= 10) {
                const confirmed = confirm(
                    `Are you sure you want to mark ${selectedIds.length} notifications as done?`
                );
                if (!confirmed) return;
            }

            state.markingInProgress = true;
            state.markProgress = { current: 0, total: selectedIds.length };

            // Disable UI during operation
            elements.markDoneBtn.disabled = true;
            elements.selectAllCheckbox.disabled = true;
            render();

            const notificationsToRestoreById = new Map(notificationLookup);
            const successfulIds = [];
            const preflightFailedResults = [];
            const blockedResults = []; // Store {id, reason} when updated comments block completion
            const allowedIds = [];

            for (let i = 0; i < selectedIds.length; i++) {
                const notifId = selectedIds[i];
                try {
                    const notification = notificationLookup.get(notifId);
                    const syncResult = await syncNotificationBeforeDone(notifId, notification);
                    if (syncResult?.updatedNotification) {
                        notificationsToRestoreById.set(notifId, syncResult.updatedNotification);
                    }
                    if (syncResult?.status === 'updated') {
                        blockedResults.push({
                            id: notifId,
                            reason: syncResult.reason || 'New comments detected',
                        });
                        continue;
                    }
                    if (syncResult?.status === 'error') {
                        preflightFailedResults.push({
                            id: notifId,
                            error: syncResult.error || 'Failed to sync notification',
                        });
                        continue;
                    }
                    allowedIds.push(notifId);
                } catch (e) {
                    const errorDetail = e.message || String(e);
                    preflightFailedResults.push({ id: notifId, error: errorDetail });
                }
            }

            if (allowedIds.length === 0) {
                state.markingInProgress = false;
                state.markProgress = { current: 0, total: 0 };
                elements.markDoneBtn.disabled = false;
                elements.selectAllCheckbox.disabled = false;
                if (preflightFailedResults.length > 0) {
                    const firstError = preflightFailedResults[0]?.error || 'Unknown error';
                    showStatus(`Failed to sync notifications: ${firstError}`, 'error');
                } else {
                    showStatus(
                        `Skipped ${blockedResults.length} notification${blockedResults.length !== 1 ? 's' : ''}: new comments found`,
                        'info',
                        { autoDismiss: true }
                    );
                }
                render();
                return;
            }

            state.markProgress = { current: 0, total: allowedIds.length };

            const allowedIdSet = new Set(allowedIds);
            const notificationsToRestoreOnFailure = allowedIds
                .map(id => notificationsToRestoreById.get(id))
                .filter(Boolean);
            const undoEntry = pushToUndoStack('done', notificationsToRestoreOnFailure);

            state.notifications = state.notifications.filter(
                notif => !allowedIdSet.has(notif.id)
            );

            // Clear selection for removed items
            allowedIds.forEach(id => state.selected.delete(id));

            // Update localStorage
            persistNotifications();
            render();

            const failedResults = []; // Store {id, error} for detailed reporting
            const queuedDoneIds = new Set();
            let rateLimitDelay = 0;

            for (let i = 0; i < allowedIds.length; i++) {
                const notifId = allowedIds[i];
                state.markProgress.current = i + 1;
                render();

                // If we hit a rate limit, wait before retrying
                if (rateLimitDelay > 0) {
                    await sleep(rateLimitDelay);
                    rateLimitDelay = 0;
                }

                try {
                    if (!queuedDoneIds.has(notifId)) {
                        queueDoneSnapshot(1);
                        queuedDoneIds.add(notifId);
                    }
                    const result = await markNotificationDone(notifId);

                    if (result.rateLimited) {
                        // Rate limited - wait and retry
                        rateLimitDelay = result.retryAfter || 60000;
                        showStatus(`Rate limited. Waiting ${Math.ceil(rateLimitDelay / 1000)}s...`, 'info');
                        i--; // Retry this item
                        continue;
                    }

                    if (result.success) {
                        successfulIds.push(notifId);
                        resolveDoneSnapshot(true);
                    } else {
                        const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                        console.error(`[MarkDone] Failed for ${notifId}:`, errorDetail);
                        failedResults.push({ id: notifId, error: errorDetail });
                        resolveDoneSnapshot(false);
                    }
                } catch (e) {
                    const errorDetail = e.message || String(e);
                    console.error(`[MarkDone] Exception for ${notifId}:`, e);
                    failedResults.push({ id: notifId, error: errorDetail });
                    resolveDoneSnapshot(false);
                }

                // Small delay between requests to avoid rate limiting
                if (i < allowedIds.length - 1) {
                    await sleep(100);
                }
            }

            if (failedResults.length > 0) {
                const failedNotifications = failedResults
                    .map(result => notificationsToRestoreById.get(result.id))
                    .filter(Boolean);
                restoreNotificationsInOrder(failedNotifications);
                failedNotifications.forEach(notification => state.selected.add(notification.id));
                persistNotifications();
            }

            // Reset marking state
            state.markingInProgress = false;
            state.markProgress = { current: 0, total: 0 };
            elements.markDoneBtn.disabled = false;
            elements.selectAllCheckbox.disabled = false;

            // Show result message with details
            const allFailedResults = [...preflightFailedResults, ...failedResults];
            if (allFailedResults.length === 0 && blockedResults.length === 0) {
                updateDoneSnapshotStatus();
            } else if (successfulIds.length === 0 && allFailedResults.length === 0) {
                showStatus(
                    `Skipped ${blockedResults.length} notification${blockedResults.length !== 1 ? 's' : ''}: new comments found`,
                    'info',
                    { autoDismiss: true }
                );
            } else if (successfulIds.length === 0) {
                // All failed - show first error for context
                const firstError = allFailedResults[0]?.error || 'Unknown error';
                const blockedSuffix = blockedResults.length
                    ? ` (${blockedResults.length} skipped for new comments)`
                    : '';
                showStatus(`Failed to mark notifications: ${firstError}${blockedSuffix}`, 'error');
                console.error('[MarkDone] All failed. Errors:', allFailedResults);
            } else if (allFailedResults.length === 0) {
                showStatus(
                    `Marked ${successfulIds.length} done, ${blockedResults.length} skipped (new comments)`,
                    'info',
                    { autoDismiss: true }
                );
            } else {
                // Partial failure
                const firstError = allFailedResults[0]?.error || 'Unknown error';
                const blockedSuffix = blockedResults.length
                    ? `, ${blockedResults.length} skipped (new comments)`
                    : '';
                showStatus(
                    `Marked ${successfulIds.length} done, ${allFailedResults.length} failed${blockedSuffix}: ${firstError}`,
                    'error'
                );
                console.error('[MarkDone] Partial failure. Errors:', allFailedResults);
            }

            const notificationsForUndo = successfulIds
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
            if (state.markingInProgress) return;

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

            state.markingInProgress = true;
            state.markProgress = { current: 0, total: selectedIds.length };

            // Disable UI during operation
            elements.unsubscribeAllBtn.disabled = true;
            elements.selectAllCheckbox.disabled = true;
            render();

            const successfulIds = [];
            const failedResults = [];
            let rateLimitDelay = 0;

            for (let i = 0; i < selectedIds.length; i++) {
                const notifId = selectedIds[i];
                state.markProgress.current = i + 1;
                render();

                if (rateLimitDelay > 0) {
                    await sleep(rateLimitDelay);
                    rateLimitDelay = 0;
                }

                try {
                    const result = await unsubscribeNotification(notifId);

                    if (result.rateLimited) {
                        rateLimitDelay = result.retryAfter || 60000;
                        showStatus(`Rate limited. Waiting ${Math.ceil(rateLimitDelay / 1000)}s...`, 'info');
                        i--;
                        continue;
                    }

                    if (result.success) {
                        // Also mark as done after unsubscribing
                        queueDoneSnapshot(1);
                        const markDoneResult = await markNotificationDone(notifId);
                        if (markDoneResult.rateLimited) {
                            rateLimitDelay = markDoneResult.retryAfter || 60000;
                            showStatus(`Rate limited. Waiting ${Math.ceil(rateLimitDelay / 1000)}s...`, 'info');
                            resolveDoneSnapshot(false);
                        } else if (!markDoneResult.success) {
                            resolveDoneSnapshot(false);
                        } else {
                            resolveDoneSnapshot(true);
                        }
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

            const successfulIdSet = new Set(successfulIds);
            const notificationsToRestore = successfulIds
                .map(id => notificationLookup.get(id))
                .filter(Boolean);
            state.notifications = state.notifications.filter(
                notif => !successfulIdSet.has(notif.id)
            );

            // Clear selection for successful items
            successfulIds.forEach(id => state.selected.delete(id));

            // Update localStorage
            persistNotifications();

            // Reset marking state
            state.markingInProgress = false;
            state.markProgress = { current: 0, total: 0 };
            elements.unsubscribeAllBtn.disabled = false;
            elements.selectAllCheckbox.disabled = false;

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

            if (notificationsToRestore.length > 0) {
                pushToUndoStack('unsubscribe', notificationsToRestore);
            }

            await refreshRateLimit();
            render();
        }

        // Sleep helper for delays
        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // Check if ID is a GitHub node ID (starts with prefix like NT_, PR_, etc.)
        function isNodeId(id) {
            return typeof id === 'string' && /^[A-Z]+_/.test(id);
        }

        // Extract REST API thread_id from a GitHub node ID
        // Node IDs are base64 encoded and contain "thread_id:user_id"
        function extractThreadIdFromNodeId(nodeId) {
            if (!nodeId.startsWith('NT_')) {
                return null;
            }

            try {
                const suffix = nodeId.slice(3); // Remove 'NT_'
                // Base64 decode
                const decoded = atob(suffix);
                // Extract thread_id:user_id pattern (the numeric part after binary prefix)
                const match = decoded.match(/(\d{10,}):\d+/);
                if (match) {
                    return match[1];
                }
            } catch (e) {
                console.error(`[MarkDone] Failed to decode node ID ${nodeId}:`, e);
            }

            return null;
        }

        const MARK_DONE_AUTH_CACHE_KEY = 'ghnotif_auth_cache';
        const MARK_DONE_AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

        function getCachedAuthLogin() {
            try {
                const raw = localStorage.getItem(MARK_DONE_AUTH_CACHE_KEY);
                if (!raw) {
                    return null;
                }
                const cached = JSON.parse(raw);
                if (!cached || !cached.login || !cached.timestamp) {
                    return null;
                }
                if (Date.now() - cached.timestamp > MARK_DONE_AUTH_CACHE_TTL_MS) {
                    return null;
                }
                return cached.login;
            } catch (error) {
                return null;
            }
        }

        function ensureCurrentUserLogin() {
            if (state.currentUserLogin) {
                return state.currentUserLogin;
            }
            const cachedLogin = getCachedAuthLogin();
            if (cachedLogin) {
                state.currentUserLogin = cachedLogin;
            }
            return state.currentUserLogin;
        }

        async function reloadNotificationFromServer(notification) {
            const repo = parseRepoInput(state.repo || '');
            if (!repo || !notification) {
                return { status: 'error', error: 'Missing repository or notification.' };
            }
            let response;
            try {
                const url = `/notifications/html/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
                response = await fetch(url);
            } catch (error) {
                return { status: 'error', error: error.message || String(error) };
            }
            if (!response.ok) {
                let detail = '';
                try {
                    detail = await response.text();
                } catch (error) {
                    detail = String(error);
                }
                return {
                    status: 'error',
                    error: `Reload failed: ${response.status} ${response.statusText} ${detail}`,
                };
            }
            let payload;
            try {
                payload = await response.json();
            } catch (error) {
                return { status: 'error', error: error.message || String(error) };
            }
            if (payload?.authenticity_token) {
                state.authenticity_token = payload.authenticity_token;
                persistAuthenticityToken(payload.authenticity_token);
            }
            const notifications = Array.isArray(payload?.notifications) ? payload.notifications : [];
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

        async function syncNotificationBeforeDone(notifId, notification) {
            try {
                // First, do HTML pull to check if notification is already Done on GitHub
                const reloadResult = await reloadNotificationFromServer(notification);

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
                const commentCheck = await hasNewCommentsRelativeToCache(notification);

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

        async function hasNewCommentsRelativeToCache(notification) {
            const repo = parseRepoInput(state.repo || '');
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

                // Get cached comment IDs (use optional chaining to handle undefined state)
                const cached = state.commentCache?.threads?.[getNotificationKey(notification)];
                const cachedCommentIds = new Set();
                if (cached?.comments && Array.isArray(cached.comments)) {
                    cached.comments.forEach(comment => {
                        if (comment.id != null) {
                            cachedCommentIds.add(Number(comment.id));
                        }
                    });
                }

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

        // Mark a single notification as done using the REST API
        async function markNotificationDone(notifId) {
            console.log(`[MarkDone] Attempting to mark notification: ${notifId}`);

            let threadId = notifId;

            // If it's a node ID, extract the REST API thread_id
            if (isNodeId(notifId)) {
                console.log(`[MarkDone] ID is a node ID, extracting thread_id...`);
                const extracted = extractThreadIdFromNodeId(notifId);
                if (!extracted) {
                    const error = `Failed to extract thread_id from node ID: ${notifId}`;
                    console.error(`[MarkDone] ${error}`);
                    return { success: false, error };
                }
                threadId = extracted;
                console.log(`[MarkDone] Extracted thread_id: ${threadId}`);
            }

            // Use REST API with the thread_id
            // DELETE marks as "Done", PATCH only marks as "Read"
            const url = `/github/rest/notifications/threads/${threadId}`;
            console.log(`[MarkDone] REST request: DELETE ${url}`);

            const response = await fetch(url, {
                method: 'DELETE',
            });

            console.log(`[MarkDone] REST response status: ${response.status} ${response.statusText}`);

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                console.warn(`[MarkDone] Rate limited, retry after: ${retryAfter}s`);
                return {
                    success: false,
                    rateLimited: true,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000
                };
            }

            // DELETE returns 204 No Content on success
            if (!response.ok && response.status !== 204) {
                const responseText = await response.text();
                const error = `REST error: ${response.status} ${response.statusText}`;
                console.error(`[MarkDone] ${error}`, responseText);
                return { success: false, error, status: response.status, responseBody: responseText };
            }

            console.log(`[MarkDone] REST success for ${notifId} (thread_id: ${threadId})`);
            return { success: true };
        }

        async function unsubscribeNotification(notifId) {
            console.log(`[Unsubscribe] Attempting to unsubscribe: ${notifId}`);

            let threadId = notifId;

            if (isNodeId(notifId)) {
                console.log(`[Unsubscribe] ID is a node ID, extracting thread_id...`);
                const extracted = extractThreadIdFromNodeId(notifId);
                if (!extracted) {
                    const error = `Failed to extract thread_id from node ID: ${notifId}`;
                    console.error(`[Unsubscribe] ${error}`);
                    return { success: false, error };
                }
                threadId = extracted;
                console.log(`[Unsubscribe] Extracted thread_id: ${threadId}`);
            }

            const url = `/github/rest/notifications/threads/${threadId}/subscription`;
            console.log(`[Unsubscribe] REST request: DELETE ${url}`);

            const response = await fetch(url, {
                method: 'DELETE',
            });

            console.log(`[Unsubscribe] REST response status: ${response.status} ${response.statusText}`);

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                console.warn(`[Unsubscribe] Rate limited, retry after: ${retryAfter}s`);
                return {
                    success: false,
                    rateLimited: true,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000,
                };
            }

            if (!response.ok && response.status !== 204) {
                const responseText = await response.text();
                const error = `REST error: ${response.status} ${response.statusText}`;
                console.error(`[Unsubscribe] ${error}`, responseText);
                return { success: false, error, status: response.status, responseBody: responseText };
            }

            console.log(`[Unsubscribe] REST success for ${notifId} (thread_id: ${threadId})`);
            return { success: true };
        }

        // Handle inline Mark Done button click for a single notification
        async function handleInlineMarkDone(notifId, button) {
            if (state.markingInProgress) return;

            showStatus('Checking for new comments...', 'info');
            button.disabled = true;

            // Find and save the notification for undo before removing
            const notificationToRemove = state.notifications.find(n => n.id === notifId);
            const wasSelected = state.selected.has(notifId);

            const syncResult = await syncNotificationBeforeDone(notifId, notificationToRemove);
            if (syncResult?.status === 'updated') {
                showStatus('New comments found. Reloaded notification.', 'info', {
                    autoDismiss: true,
                });
                if (syncResult.updatedNotification) {
                    const index = state.notifications.findIndex(
                        notification => notification.id === notifId
                    );
                    if (index !== -1) {
                        state.notifications[index] = syncResult.updatedNotification;
                        persistNotifications();
                    }
                }
                render();
                button.disabled = false;
                return;
            }
            if (syncResult?.status === 'error') {
                const errorDetail = syncResult.error || 'Failed to sync notification';
                showStatus(`Failed to sync notification: ${errorDetail}`, 'error');
                button.disabled = false;
                return;
            }

            const filteredBeforeRemoval = getFilteredNotifications();
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

            try {
                queueDoneSnapshot(1);
                const result = await markNotificationDone(notifId);

                if (result.rateLimited) {
                    showStatus('Rate limited. Please try again shortly.', 'info');
                    resolveDoneSnapshot(false, { suppressStatus: true });
                    if (notificationToRemove) {
                        restoreNotificationsInOrder([notificationToRemove]);
                        if (wasSelected) {
                            state.selected.add(notifId);
                        }
                        persistNotifications();
                        render();
                    }
                    removeUndoEntry(undoEntry);
                    button.disabled = false;
                    return;
                }

                if (!result.success) {
                    const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                    showStatus(`Failed to mark notification: ${errorDetail}`, 'error');
                    resolveDoneSnapshot(false);
                    if (notificationToRemove) {
                        restoreNotificationsInOrder([notificationToRemove]);
                        if (wasSelected) {
                            state.selected.add(notifId);
                        }
                        persistNotifications();
                        render();
                    }
                    removeUndoEntry(undoEntry);
                    button.disabled = false;
                    return;
                }

                resolveDoneSnapshot(true);
            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Failed to mark notification: ${errorDetail}`, 'error');
                resolveDoneSnapshot(false);
                if (notificationToRemove) {
                    restoreNotificationsInOrder([notificationToRemove]);
                    if (wasSelected) {
                        state.selected.add(notifId);
                    }
                    persistNotifications();
                    render();
                }
                removeUndoEntry(undoEntry);
                button.disabled = false;
                return;
            }

            await refreshRateLimit();
        }

        async function handleInlineUnsubscribe(notifId, button) {
            if (state.markingInProgress) return;

            button.disabled = true;

            // Find and save the notification for undo before removing
            const notificationToRemove = state.notifications.find(n => n.id === notifId);

            try {
                const result = await unsubscribeNotification(notifId);

                if (result.rateLimited) {
                    showStatus('Rate limited. Please try again shortly.', 'info');
                    button.disabled = false;
                    return;
                }

                if (!result.success) {
                    const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                    showStatus(`Failed to unsubscribe: ${errorDetail}`, 'error');
                    button.disabled = false;
                    return;
                }

                queueDoneSnapshot(1);
                const markDoneResult = await markNotificationDone(notifId);
                if (markDoneResult.rateLimited) {
                    showStatus(
                        'Unsubscribed, but rate limited when marking as done. Please try again shortly.',
                        'info'
                    );
                    resolveDoneSnapshot(false, { suppressStatus: true });
                } else if (!markDoneResult.success) {
                    const errorDetail =
                        markDoneResult.error || `HTTP ${markDoneResult.status || 'unknown'}`;
                    showStatus(`Unsubscribed, but failed to mark as done: ${errorDetail}`, 'error');
                    resolveDoneSnapshot(false);
                } else {
                    resolveDoneSnapshot(true);
                }

                const filteredBeforeRemoval = getFilteredNotifications();
                advanceActiveNotificationBeforeRemoval(notifId, filteredBeforeRemoval);
                state.notifications = state.notifications.filter(
                    n => n.id !== notifId
                );
                state.selected.delete(notifId);
                persistNotifications();

                // Save for undo
                if (notificationToRemove) {
                    pushToUndoStack('unsubscribe', [notificationToRemove]);
                }
            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Failed to unsubscribe: ${errorDetail}`, 'error');
                button.disabled = false;
                return;
            }

            await refreshRateLimit();
            render();
        }

        function clearUndoState() {
            state.undoStack = [];
            state.undoInProgress = false;
        }

        function restoreNotificationsInOrder(notifications) {
            const notificationsToRestore = notifications
                .slice()
                .sort(
                    (a, b) =>
                        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
                );
            notificationsToRestore.forEach(notification => {
                const insertIndex = state.notifications.findIndex(
                    n => new Date(n.updated_at) < new Date(notification.updated_at)
                );
                if (insertIndex === -1) {
                    state.notifications.push(notification);
                } else {
                    state.notifications.splice(insertIndex, 0, notification);
                }
            });
        }

        function pushToUndoStack(action, notifications) {
            const normalizedNotifications = Array.isArray(notifications)
                ? notifications
                : [notifications];
            if (normalizedNotifications.length === 0) {
                return null;
            }
            const undoEntry = {
                action,
                notifications: normalizedNotifications,
                timestamp: Date.now(),
            };
            state.undoStack.push(undoEntry);
            // Keep only the most recent undo (single action undo)
            if (state.undoStack.length > 1) {
                state.undoStack = [state.undoStack[state.undoStack.length - 1]];
            }
            return undoEntry;
        }

        function removeUndoEntry(undoEntry) {
            if (!undoEntry) {
                return;
            }
            const index = state.undoStack.indexOf(undoEntry);
            if (index !== -1) {
                state.undoStack.splice(index, 1);
            }
        }

        function updateUndoEntry(undoEntry, notifications) {
            if (!undoEntry) {
                return;
            }
            const normalizedNotifications = Array.isArray(notifications)
                ? notifications
                : [notifications];
            if (normalizedNotifications.length === 0) {
                removeUndoEntry(undoEntry);
                return;
            }
            undoEntry.notifications = normalizedNotifications;
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
            const elapsed = Date.now() - undoItem.timestamp;
            if (elapsed > 30000) {
                showStatus('Undo expired. Actions can only be undone within 30 seconds.', 'info');
                state.undoStack.pop();
                return;
            }

            state.undoInProgress = true;
            showStatus('Undo in progress...', 'info');

            try {
                const action = undoItem.action === 'done' ? 'unarchive' : 'subscribe';
                const notificationsByToken = new Map();
                let missingToken = false;

                undoItem.notifications.forEach(notification => {
                    const token =
                        notification?.ui?.action_tokens?.[action] ||
                        state.authenticity_token;
                    if (!token) {
                        missingToken = true;
                        return;
                    }
                    const group = notificationsByToken.get(token) || [];
                    group.push(notification);
                    notificationsByToken.set(token, group);
                });

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
                    restoreNotificationsInOrder(restoredNotifications);
                    persistNotifications();
                    render();
                }

                if (failedNotifications.length === 0) {
                    state.undoStack.pop();
                    const restoredCount = restoredNotifications.length;
                    showStatus(
                        `Undo successful: restored ${restoredCount} notification${
                            restoredCount !== 1 ? 's' : ''
                        }`,
                        'success',
                        { autoDismiss: true }
                    );
                } else {
                    updateUndoEntry(undoItem, failedNotifications);
                    const restoredCount = restoredNotifications.length;
                    const failedCount = failedNotifications.length;
                    const detailSuffix = errorDetail ? ` (${errorDetail})` : '';
                    showStatus(
                        `Undo failed: restored ${restoredCount}, failed ${failedCount}${detailSuffix}`,
                        'error'
                    );
                }

            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Undo failed: ${errorDetail}`, 'error');
            } finally {
                state.undoInProgress = false;
            }
        }
