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
                    label: 'Mark selected as Done',
                    show: true,
                };
            }
            const currentSubfilter = state.viewFilters[state.view];
            const isClosed = currentSubfilter === 'closed';
            if (isClosed && filteredNotifications.length > 0) {
                return {
                    ids: filteredNotifications.map((notif) => notif.id),
                    label: 'Mark all as Done',
                    show: true,
                };
            }
            return {
                ids: [],
                label: 'Mark selected as Done',
                show: false,
            };
        }

        function getUnsubscribeAllTargets(filteredNotifications = getFilteredNotifications()) {
            // Only show when nothing is selected and we're in the approved filter
            if (state.selected.size > 0) {
                return { ids: [], show: false };
            }
            const currentSubfilter = state.viewFilters[state.view];
            if (currentSubfilter === 'approved' && filteredNotifications.length > 0) {
                return {
                    ids: filteredNotifications.map((notif) => notif.id),
                    show: true,
                };
            }
            return { ids: [], show: false };
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

            const successfulIds = [];
            const failedResults = []; // Store {id, error} for detailed reporting
            let rateLimitDelay = 0;

            for (let i = 0; i < selectedIds.length; i++) {
                const notifId = selectedIds[i];
                state.markProgress.current = i + 1;
                render();

                // If we hit a rate limit, wait before retrying
                if (rateLimitDelay > 0) {
                    await sleep(rateLimitDelay);
                    rateLimitDelay = 0;
                }

                try {
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
                    } else {
                        const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                        console.error(`[MarkDone] Failed for ${notifId}:`, errorDetail);
                        failedResults.push({ id: notifId, error: errorDetail });
                    }
                } catch (e) {
                    const errorDetail = e.message || String(e);
                    console.error(`[MarkDone] Exception for ${notifId}:`, e);
                    failedResults.push({ id: notifId, error: errorDetail });
                }

                // Small delay between requests to avoid rate limiting
                if (i < selectedIds.length - 1) {
                    await sleep(100);
                }
            }

            const filteredBeforeRemoval = getFilteredNotifications();
            const scrollAnchor = captureScrollAnchor(successfulIds, filteredBeforeRemoval);
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
            elements.markDoneBtn.disabled = false;
            elements.selectAllCheckbox.disabled = false;

            // Show result message with details
            if (failedResults.length === 0) {
                showStatus(`Marked ${successfulIds.length} notification${successfulIds.length !== 1 ? 's' : ''} as done`, 'success');
            } else if (successfulIds.length === 0) {
                // All failed - show first error for context
                const firstError = failedResults[0].error;
                showStatus(`Failed to mark notifications: ${firstError}`, 'error');
                console.error('[MarkDone] All failed. Errors:', failedResults);
            } else {
                // Partial failure
                const firstError = failedResults[0].error;
                showStatus(`Marked ${successfulIds.length} done, ${failedResults.length} failed: ${firstError}`, 'error');
                console.error('[MarkDone] Partial failure. Errors:', failedResults);
            }

            if (notificationsToRestore.length > 0) {
                pushToUndoStack('done', notificationsToRestore);
            }

            await refreshRateLimit();
            render();
            requestAnimationFrame(() => {
                restoreScrollAnchor(scrollAnchor);
            });
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
                        const markDoneResult = await markNotificationDone(notifId);
                        if (markDoneResult.rateLimited) {
                            rateLimitDelay = markDoneResult.retryAfter || 60000;
                            showStatus(`Rate limited. Waiting ${Math.ceil(rateLimitDelay / 1000)}s...`, 'info');
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

            const filteredBeforeRemoval = getFilteredNotifications();
            const scrollAnchor = captureScrollAnchor(successfulIds, filteredBeforeRemoval);
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
                showStatus(`Unsubscribed from ${successfulIds.length} notification${successfulIds.length !== 1 ? 's' : ''}`, 'success');
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
            requestAnimationFrame(() => {
                restoreScrollAnchor(scrollAnchor);
            });
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

            button.disabled = true;
            let scrollAnchor = null;

            // Find and save the notification for undo before removing
            const notificationToRemove = state.notifications.find(n => n.id === notifId);

            try {
                const result = await markNotificationDone(notifId);

                if (result.rateLimited) {
                    showStatus('Rate limited. Please try again shortly.', 'info');
                    button.disabled = false;
                    return;
                }

                if (!result.success) {
                    const errorDetail = result.error || `HTTP ${result.status || 'unknown'}`;
                    showStatus(`Failed to mark notification: ${errorDetail}`, 'error');
                    button.disabled = false;
                    return;
                }

                const filteredBeforeRemoval = getFilteredNotifications();
                scrollAnchor = captureScrollAnchor([notifId], filteredBeforeRemoval);
                advanceActiveNotificationBeforeRemoval(notifId, filteredBeforeRemoval);
                state.notifications = state.notifications.filter(
                    n => n.id !== notifId
                );
                state.selected.delete(notifId);
                persistNotifications();

                // Save for undo
                if (notificationToRemove) {
                    pushToUndoStack('done', [notificationToRemove]);
                }
                showStatus('Marked 1 notification as done', 'success');
            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Failed to mark notification: ${errorDetail}`, 'error');
                button.disabled = false;
                return;
            }

            await refreshRateLimit();
            render();
            requestAnimationFrame(() => {
                restoreScrollAnchor(scrollAnchor);
            });
        }

        async function handleInlineUnsubscribe(notifId, button) {
            if (state.markingInProgress) return;

            button.disabled = true;
            let scrollAnchor = null;

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

                const markDoneResult = await markNotificationDone(notifId);
                if (markDoneResult.rateLimited) {
                    showStatus(
                        'Unsubscribed, but rate limited when marking as done. Please try again shortly.',
                        'info'
                    );
                } else if (!markDoneResult.success) {
                    const errorDetail =
                        markDoneResult.error || `HTTP ${markDoneResult.status || 'unknown'}`;
                    showStatus(`Unsubscribed, but failed to mark as done: ${errorDetail}`, 'error');
                } else {
                    showStatus('Unsubscribed and marked 1 notification as done', 'success');
                }

                const filteredBeforeRemoval = getFilteredNotifications();
                scrollAnchor = captureScrollAnchor([notifId], filteredBeforeRemoval);
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
            requestAnimationFrame(() => {
                restoreScrollAnchor(scrollAnchor);
            });
        }

        function clearUndoState() {
            state.undoStack = [];
            state.undoInProgress = false;
        }

        function pushToUndoStack(action, notifications) {
            const normalizedNotifications = Array.isArray(notifications)
                ? notifications
                : [notifications];
            if (normalizedNotifications.length === 0) {
                return;
            }
            state.undoStack.push({
                action,
                notifications: normalizedNotifications,
                timestamp: Date.now(),
            });
            // Keep only the most recent undo (single action undo)
            if (state.undoStack.length > 1) {
                state.undoStack = [state.undoStack[state.undoStack.length - 1]];
            }
        }

        async function handleUndo() {
            if (state.undoStack.length === 0 || state.undoInProgress) {
                return;
            }

            const undoItem = state.undoStack.pop();
            if (!undoItem) {
                return;
            }

            // Check if undo is still valid (within 30 seconds)
            const elapsed = Date.now() - undoItem.timestamp;
            if (elapsed > 30000) {
                showStatus('Undo expired. Actions can only be undone within 30 seconds.', 'info');
                return;
            }

            // Check if we have a token
            if (!state.authenticity_token) {
                showStatus('Cannot undo: no authenticity token available. Try syncing first.', 'error');
                return;
            }

            state.undoInProgress = true;

            try {
                const action = undoItem.action === 'done' ? 'unarchive' : 'subscribe';
                const response = await fetch('/notifications/html/action', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        action: action,
                        notification_ids: undoItem.notifications.map(notification => notification.id),
                        authenticity_token: state.authenticity_token,
                    }),
                });

                const result = await response.json();

                if (result.status !== 'ok') {
                    throw new Error(result.error || 'Unknown error');
                }

                // Restore notifications to the list in updated_at order
                const notificationsToRestore = undoItem.notifications
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

                persistNotifications();
                const restoredCount = undoItem.notifications.length;
                showStatus(
                    `Undo successful: restored ${restoredCount} notification${restoredCount !== 1 ? 's' : ''}`,
                    'success'
                );
                render();

            } catch (e) {
                const errorDetail = e.message || String(e);
                showStatus(`Undo failed: ${errorDetail}`, 'error');
                // Put the item back on the stack so user can retry
                state.undoStack.push(undoItem);
            } finally {
                state.undoInProgress = false;
            }
        }
