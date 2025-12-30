        function getSelectableNotifications() {
            return getFilteredNotifications();
        }

        function getNotificationElement(notifId) {
            return elements.notificationsList.querySelector(
                `[data-id="${CSS.escape(String(notifId))}"]`
            );
        }

        function scrollActiveNotificationIntoView() {
            if (!state.activeNotificationId) {
                return;
            }
            const item = getNotificationElement(state.activeNotificationId);
            if (item) {
                item.scrollIntoView({ block: 'nearest' });
            }
        }

        function setActiveNotification(notifId, { scroll = false } = {}) {
            if (state.activeNotificationId === notifId) {
                return;
            }
            updateActiveNotificationClass(state.activeNotificationId, notifId);
            state.activeNotificationId = notifId;
            if (scroll) {
                scrollActiveNotificationIntoView();
            }
        }

        function moveActiveNotification(delta) {
            const selectable = getSelectableNotifications();
            if (selectable.length === 0) {
                return;
            }
            let index = selectable.findIndex(notif => notif.id === state.activeNotificationId);
            if (index === -1) {
                index = delta > 0 ? -1 : selectable.length;
            }
            const nextIndex = Math.min(
                selectable.length - 1,
                Math.max(0, index + delta)
            );
            const newActiveId = selectable[nextIndex].id;
            updateActiveNotificationClass(state.activeNotificationId, newActiveId);
            state.activeNotificationId = newActiveId;
            scrollActiveNotificationIntoView();
        }

        // Update keyboard-selected class directly on DOM elements without full re-render
        function updateActiveNotificationClass(oldId, newId) {
            if (oldId === newId) {
                return;
            }
            if (oldId) {
                const oldItem = getNotificationElement(oldId);
                if (oldItem) {
                    oldItem.classList.remove('keyboard-selected');
                    oldItem.removeAttribute('aria-current');
                }
            }
            if (newId) {
                const newItem = getNotificationElement(newId);
                if (newItem) {
                    newItem.classList.add('keyboard-selected');
                    newItem.setAttribute('aria-current', 'true');
                }
            }
        }

        function smoothScrollTo(targetY, duration = 150) {
            const startY = window.scrollY;
            const distance = targetY - startY;
            const startTime = performance.now();

            function step(currentTime) {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                // Ease-out cubic for smooth deceleration
                const eased = 1 - Math.pow(1 - progress, 3);
                window.scrollTo(0, startY + distance * eased);
                if (progress < 1) {
                    requestAnimationFrame(step);
                }
            }
            requestAnimationFrame(step);
        }

        function scrollToTop() {
            smoothScrollTo(0);
        }

        function scrollToBottom() {
            smoothScrollTo(document.body.scrollHeight);
        }

        async function triggerActiveNotificationAction(action) {
            if (!state.activeNotificationId) {
                return;
            }
            const item = getNotificationElement(state.activeNotificationId);
            if (!item) {
                return;
            }
            if (action === 'done') {
                const doneButton = item.querySelector('.notification-done-btn');
                if (doneButton) {
                    await withActionContext('Mark done (inline)', () =>
                        handleInlineMarkDone(state.activeNotificationId, doneButton)
                    );
                }
                return;
            }
            if (action === 'unsubscribe') {
                const unsubscribeButton = item.querySelector('.notification-unsubscribe-btn');
                if (!unsubscribeButton) {
                    showStatus('Unsubscribe is not available for this notification.', 'info');
                    return;
                }
                await withActionContext('Unsubscribe (inline)', () =>
                    handleInlineUnsubscribe(state.activeNotificationId, unsubscribeButton)
                );
            }
        }

        function ensureActiveNotification(filteredNotifications) {
            if (filteredNotifications.length === 0) {
                state.activeNotificationId = null;
                return;
            }
            if (!state.activeNotificationId) {
                return;
            }
            const exists = filteredNotifications.some(
                notif => notif.id === state.activeNotificationId
            );
            if (!exists) {
                state.activeNotificationId = filteredNotifications[0].id;
            }
        }

        // Move active notification to the next one before removing a notification.
        // This ensures the selection moves to the next notification, not the first.
        function advanceActiveNotificationBeforeRemoval(removedId, filteredNotifications) {
            if (state.activeNotificationId !== removedId) {
                return;
            }
            const index = filteredNotifications.findIndex(n => n.id === removedId);
            if (index === -1) {
                return;
            }
            // Try to move to the next notification, or the previous if at the end
            if (index + 1 < filteredNotifications.length) {
                state.activeNotificationId = filteredNotifications[index + 1].id;
            } else if (index > 0) {
                state.activeNotificationId = filteredNotifications[index - 1].id;
            } else {
                state.activeNotificationId = null;
            }
        }

        // Handle keyboard shortcuts
        async function handleKeyDown(e) {
            // Don't handle shortcuts when typing in inputs
            if (
                e.target.tagName === 'INPUT' ||
                e.target.tagName === 'TEXTAREA' ||
                e.target.isContentEditable
            ) {
                return;
            }

            const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
            if (!hasModifier && !e.shiftKey) {
                if (e.key === 'j') {
                    moveActiveNotification(1);
                    e.preventDefault();
                    return;
                }
                if (e.key === 'k') {
                    moveActiveNotification(-1);
                    e.preventDefault();
                    return;
                }
                if (e.key === 'g') {
                    const now = Date.now();
                    if (now - state.lastGKeyTime < 500) {
                        // gg - scroll to top
                        scrollToTop();
                        state.lastGKeyTime = 0;
                        state.scrollLock = null;
                        e.preventDefault();
                        return;
                    }
                    const scrollTop = window.scrollY;
                    const guardUntil = now + 700;
                    state.lastGKeyTime = now;
                    state.scrollLock = { top: scrollTop, until: guardUntil };
                    const guardId = setInterval(() => {
                        if (state.lastGKeyTime !== now) {
                            clearInterval(guardId);
                            return;
                        }
                        if (Date.now() > guardUntil) {
                            clearInterval(guardId);
                            state.lastGKeyTime = 0;
                            return;
                        }
                        if (window.scrollY !== scrollTop) {
                            window.scrollTo(0, scrollTop);
                        }
                    }, 50);
                    e.preventDefault();
                    return;
                }
                if (e.key === 'e') {
                    e.preventDefault();
                    await triggerActiveNotificationAction('done');
                    return;
                }
                if (e.key === 'm') {
                    e.preventDefault();
                    await triggerActiveNotificationAction('unsubscribe');
                    return;
                }
                if (e.key === 'r') {
                    e.preventDefault();
                    location.reload();
                    return;
                }
                if (e.key === 'u') {
                    e.preventDefault();
                    handleUndo();
                    return;
                }
                if (e.key === 't') {
                    if (state.activeNotificationId) {
                        e.preventDefault();
                        toggleSelection(state.activeNotificationId);
                        render();
                    }
                    return;
                }
                if (e.key === 'Enter') {
                    const item = getNotificationElement(state.activeNotificationId);
                    const link = item?.querySelector('.notification-title');
                    if (link?.href) {
                        e.preventDefault();
                        window.open(link.href, '_blank');
                    }
                    return;
                }
            }

            // G (shift+g) - scroll to bottom
            if (!hasModifier && e.shiftKey && e.key === 'G') {
                scrollToBottom();
                e.preventDefault();
                return;
            }

            // ? (shift+/) - show keyboard shortcuts help
            if (!hasModifier && e.key === '?') {
                showKeyboardShortcutsOverlay();
                e.preventDefault();
                return;
            }

            // Escape: Close keyboard shortcuts overlay first, then clear selection
            if (e.key === 'Escape') {
                if (isKeyboardShortcutsOverlayOpen()) {
                    hideKeyboardShortcutsOverlay();
                    e.preventDefault();
                    return;
                }
                if (state.selected.size > 0) {
                    clearSelection();
                    e.preventDefault();
                }
                return;
            }

            // Ctrl/Cmd + A: Select all (when notifications exist)
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                const filtered = getFilteredNotifications();
                if (filtered.length > 0 && !state.markingInProgress) {
                    e.preventDefault();
                    filtered.forEach(n => state.selected.add(n.id));
                    render();
                }
            }
        }

        // Keyboard shortcuts overlay functions
        function isKeyboardShortcutsOverlayOpen() {
            return elements.keyboardShortcutsOverlay.classList.contains('visible');
        }

        function showKeyboardShortcutsOverlay() {
            elements.keyboardShortcutsOverlay.classList.add('visible');
        }

        function hideKeyboardShortcutsOverlay() {
            elements.keyboardShortcutsOverlay.classList.remove('visible');
        }

        // Get appropriate empty state message
        function getEmptyStateMessage() {
            if (state.notifications.length === 0) {
                return {
                    title: 'No notifications',
                    message: 'Enter a repository and click Quick Sync to load notifications.',
                };
            }

            const viewLabels = {
                'issues': 'issue',
                'my-prs': 'PR',
                'others-prs': 'PR'
            };
            const viewLabel = viewLabels[state.view];
            const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
            const stateFilter = viewFilters.state || 'all';
            const authorFilter = viewFilters.author || 'all';

            // Check if view has no notifications at all
            const viewCounts = getViewCounts();
            const viewCount = state.view === 'issues' ? viewCounts.issues :
                              state.view === 'my-prs' ? viewCounts.myPrs :
                              viewCounts.othersPrs;

            if (viewCount === 0) {
                if (state.view === 'issues') {
                    return {
                        title: 'No issue notifications',
                        message: 'No issue notifications in this repository.',
                    };
                }
                if (state.view === 'my-prs') {
                    return {
                        title: 'No notifications for your PRs',
                        message: 'No notifications for pull requests you authored.',
                    };
                }
                if (state.view === 'others-prs') {
                    return {
                        title: "No notifications for others' PRs",
                        message: 'No notifications for pull requests authored by others.',
                    };
                }
            }

            // Have notifications but subfilter shows none
            if (stateFilter === 'open') {
                return {
                    title: `No open ${viewLabel} notifications`,
                    message: `All ${viewLabel} notifications in this view are closed or merged.`,
                };
            }

            if (stateFilter === 'closed') {
                return {
                    title: `No closed ${viewLabel} notifications`,
                    message: `All ${viewLabel} notifications in this view are still open.`,
                };
            }

            if (stateFilter === 'draft') {
                return {
                    title: `No draft ${viewLabel} notifications`,
                    message: `All ${viewLabel} notifications in this view are ready for review.`,
                };
            }

            if (stateFilter === 'needs-review') {
                return {
                    title: 'No PRs need review',
                    message: 'No PRs need your review right now.',
                };
            }

            if (stateFilter === 'approved') {
                return {
                    title: 'No approved PRs',
                    message: 'No approved PR notifications are pending.',
                };
            }

            if (authorFilter === 'committer') {
                return {
                    title: 'No committer PRs',
                    message: 'No pull requests from repository committers match this view.',
                };
            }

            if (authorFilter === 'external') {
                return {
                    title: 'No external PRs',
                    message: 'No pull requests from external contributors match this view.',
                };
            }

            return {
                title: 'No notifications',
                message: 'No notifications match the current filter.',
            };
        }

        // Check authentication status
        async function checkAuth() {
            try {
                const response = await fetch('/github/rest/user');
                const data = await response.json();

                if (response.ok && data.login) {
                    elements.authStatus.textContent = `Signed in as ${data.login}`;
                    elements.authStatus.className = 'auth-status authenticated';
                    state.currentUserLogin = data.login;
                    // Re-render to update view counts that depend on current user
                    render();
                } else {
                    elements.authStatus.textContent = 'Not authenticated';
                    elements.authStatus.className = 'auth-status error';
                    state.currentUserLogin = null;
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
            state.selected.clear();
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
                        throw new Error(errorData.detail || `HTTP ${response.status}`);
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

                if (syncMode === 'incremental' && overlapIndex !== null) {
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
                        matchKeys: cachedKeys,
                    });
                }

                state.notifications = notifications;
                state.loading = false;
                state.lastSyncedRepo = repo;
                localStorage.setItem(LAST_SYNCED_REPO_KEY, repo);

                // Save to localStorage
                persistNotifications();

                state.commentQueue = [];
                scheduleCommentPrefetch(notifications);

                showStatus(`Synced ${notifications.length} notifications`, 'success', {
                    autoDismiss: true,
                });
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

        const DEFAULT_FLASH_DURATION_MS = 500;
        const DEFAULT_AUTO_DISMISS_MS = 1500;

        function clearStatusAutoDismiss() {
            if (state.statusAutoDismissTimer) {
                clearTimeout(state.statusAutoDismissTimer);
                state.statusAutoDismissTimer = null;
            }
            elements.statusBar.classList.remove('auto-dismiss');
            elements.statusBar.style.removeProperty('--status-dismiss-duration');
        }

        function freezeStatusAutoDismiss() {
            if (state.statusAutoDismissTimer) {
                clearTimeout(state.statusAutoDismissTimer);
                state.statusAutoDismissTimer = null;
            }
            if (state.statusState) {
                state.statusState.autoDismiss = false;
            }
            elements.statusBar.classList.remove('auto-dismiss');
            elements.statusBar.style.removeProperty('--status-dismiss-duration');
            elements.statusBar.classList.add('status-pinned');
        }

        function clearStatusBar() {
            if (state.statusTimer) {
                clearTimeout(state.statusTimer);
                state.statusTimer = null;
            }
            clearStatusAutoDismiss();
            elements.statusBar.classList.remove('status-pinned');
            elements.statusBar.textContent = '';
            elements.statusBar.className = 'status-bar';
            state.statusState = null;
            state.lastPersistentStatus = null;
        }

        elements.statusBar.addEventListener('click', () => {
            if (!elements.statusBar.classList.contains('visible')) {
                return;
            }
            if (elements.statusBar.classList.contains('auto-dismiss')) {
                freezeStatusAutoDismiss();
                return;
            }
            clearStatusBar();
        });

        // Show status message
        function showStatus(message, type, options) {
            const settings = options || {};
            const flash = Boolean(settings.flash);
            const autoDismiss = Boolean(settings.autoDismiss) && !flash;
            const flashDurationMs = Number.isFinite(settings.durationMs)
                ? settings.durationMs
                : DEFAULT_FLASH_DURATION_MS;
            const autoDismissDurationMs = Number.isFinite(settings.autoDismissMs)
                ? settings.autoDismissMs
                : (Number.isFinite(settings.durationMs)
                    ? settings.durationMs
                    : DEFAULT_AUTO_DISMISS_MS);

            if (
                flash &&
                state.statusState &&
                !state.statusState.isFlash &&
                state.statusState.type !== 'info'
            ) {
                return;
            }

            clearStatusAutoDismiss();
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
                    autoDismiss: false,
                };
            }

            const flashId = flash ? (state.statusFlashId += 1) : null;
            applyStatus(message, type, flash, flashId);

            if (!flash && !autoDismiss) {
                state.lastPersistentStatus = { message, type };
                return;
            }
            if (autoDismiss) {
                state.lastPersistentStatus = null;
                if (state.statusState) {
                    state.statusState.autoDismiss = true;
                }
                const autoDismissId = (state.statusAutoDismissId += 1);
                elements.statusBar.classList.remove('status-pinned');
                elements.statusBar.classList.add('auto-dismiss');
                elements.statusBar.style.setProperty(
                    '--status-dismiss-duration',
                    `${autoDismissDurationMs}ms`
                );
                state.statusAutoDismissTimer = setTimeout(() => {
                    if (!state.statusState || state.statusAutoDismissId !== autoDismissId) {
                        return;
                    }
                    clearStatusBar();
                }, autoDismissDurationMs);
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
                clearStatusBar();
            }, flashDurationMs);
        }

        // SVG Icons
        const icons = {
            issue: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"></path></svg>`,
            issueClosed: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"></path><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path></svg>`,
            issueNotPlanned: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"></path></svg>`,
            pr: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"></path></svg>`,
            prMerged: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"></path></svg>`,
            prClosed: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.28a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l.94-.94-2.94.001a1 1 0 0 0-1 1v2.5a.75.75 0 0 1-1.5 0V5.251a2.5 2.5 0 0 1 2.5-2.5l2.94-.001-.94-.94a.75.75 0 0 1 0-1.06ZM3.25 12.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"></path></svg>`,
            prDraft: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM3.25 12.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"></path></svg>`,
            discussion: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"></path></svg>`,
            commit: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path></svg>`,
            release: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"></path></svg>`,
            check: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>`,
            bellSlash: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="m4.182 4.31.016.011 10.104 7.316.013.01 1.375.996a.75.75 0 1 1-.88 1.214L13.626 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947V5.305L.31 3.357a.75.75 0 1 1 .88-1.214Zm7.373 7.19L4.5 6.391v1.556c0 .346-.102.683-.294.97l-1.703 2.556a.017.017 0 0 0-.003.01c0 .005.002.009.005.012l.006.004.007.001ZM8 1.5c-.997 0-1.895.416-2.534 1.086A.75.75 0 1 1 4.38 1.55 5 5 0 0 1 13 5v2.373a.75.75 0 0 1-1.5 0V5A3.5 3.5 0 0 0 8 1.5ZM8 16a2 2 0 0 1-1.985-1.75c-.017-.137.097-.25.235-.25h3.5c.138 0 .252.113.235.25A2 2 0 0 1 8 16Z"></path></svg>`,
            openInNewTab: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 3A2.25 2.25 0 0 0 1 5.25v6.5A2.25 2.25 0 0 0 3.25 14h6.5A2.25 2.25 0 0 0 12 11.75v-2.5a.75.75 0 0 0-1.5 0v2.5a.75.75 0 0 1-.75.75h-6.5a.75.75 0 0 1-.75-.75v-6.5A.75.75 0 0 1 3.25 4.5h2.5a.75.75 0 0 0 0-1.5Zm3.5-1a.75.75 0 0 0 0 1.5h2.69L6.97 5.97a.75.75 0 1 0 1.06 1.06L10.5 4.56v2.69a.75.75 0 0 0 1.5 0V2.75A.75.75 0 0 0 11.25 2h-4.5Z"></path></svg>`,
        };

        // Get icon for notification type and state
        function getNotificationIcon(notif) {
            const type = notif.subject.type;
            const state = notif.subject.state;
            const stateReason = notif.subject.state_reason;

            if (type === 'Issue') {
                if (state === 'closed') {
                    if (stateReason === 'not_planned') return icons.issueNotPlanned;
                    return icons.issueClosed;
                }
                return icons.issue;
            }
            if (type === 'PullRequest') {
                if (state === 'merged') return icons.prMerged;
                if (state === 'closed') return icons.prClosed;
                if (state === 'draft') return icons.prDraft;
                return icons.pr;
            }
            if (type === 'Discussion') return icons.discussion;
            if (type === 'Commit') return icons.commit;
            if (type === 'Release') return icons.release;
            return icons.issue; // fallback
        }

        // Get icon state class
        function getIconStateClass(notif) {
            const state = notif.subject.state;
            if (state === 'merged') return 'merged';
            if (state === 'closed') return 'closed';
            if (state === 'draft') return 'draft';
            return 'open';
        }

        // Format relative time
        function formatRelativeTime(dateString) {
            const date = new Date(dateString);
            const now = new Date();
            const diffMs = now - date;
            const diffSecs = Math.floor(diffMs / 1000);
            const diffMins = Math.floor(diffSecs / 60);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            const diffWeeks = Math.floor(diffDays / 7);
            const diffMonths = Math.floor(diffDays / 30);
            const diffYears = Math.floor(diffDays / 365);

            if (diffSecs < 60) return 'just now';
            if (diffMins < 60) return `${diffMins}m ago`;
            if (diffHours < 24) return `${diffHours}h ago`;
            if (diffDays < 7) return `${diffDays}d ago`;
            if (diffWeeks < 4) return `${diffWeeks}w ago`;
            if (diffMonths < 12) return `${diffMonths}mo ago`;
            return `${diffYears}y ago`;
        }

        // Format reason for display
        function formatReason(reason) {
            const reasonMap = {
                'author': 'Author',
                'comment': 'Comment',
                'mention': 'Mentioned',
                'review_requested': 'Review requested',
                'subscribed': 'Subscribed',
                'team_mention': 'Team mentioned',
                'assign': 'Assigned',
                'state_change': 'State change',
                'ci_activity': 'CI activity',
            };
            return reasonMap[reason] || reason;
        }

        // Get state badge HTML
        function getStateBadge(notif) {
            const type = notif.subject.type;
            const state = notif.subject.state;
            const stateReason = notif.subject.state_reason;

            if (!state) return '';

            let label = state.charAt(0).toUpperCase() + state.slice(1);
            let cssClass = state;

            if (state === 'closed' && stateReason === 'completed') {
                cssClass = 'closed completed';
            }

            if (type === 'PullRequest' && state === 'merged') {
                label = 'Merged';
            }

            return `<span class="state-badge ${cssClass}" data-state="${state}">${label}</span>`;
        }

        function getPullRequestAuthorLogin(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return null;
            }
            const cached = state.commentCache?.threads?.[getNotificationKey(notification)];
            if (!cached || cached.error) {
                return null;
            }
            const login = cached.authorLogin;
            if (!login) {
                return null;
            }
            if (typeof isAuthorLoginFresh === 'function' && !isAuthorLoginFresh(cached)) {
                return null;
            }
            return String(login);
        }

        function getDiffstatHue(total, range) {
            if (!range || range.min === null || range.max === null) {
                return null;
            }
            if (range.min === range.max) {
                return 60;
            }
            const scale = (total - range.min) / (range.max - range.min);
            return Math.round(120 * (1 - scale));
        }

        // Render the UI
        function render() {
            // Show/hide loading state
            elements.loading.className = state.loading ? 'loading visible' : 'loading';

            // Get filtered notifications
            const filteredNotifications = state.loading ? [] : getFilteredNotifications();
            const displayNotifications = filteredNotifications;
            ensureActiveNotification(filteredNotifications);

            // Show/hide empty state with dynamic message
            const showEmpty =
                !state.loading &&
                !state.markingInProgress &&
                filteredNotifications.length === 0;
            elements.emptyState.style.display = showEmpty ? 'block' : 'none';
            if (showEmpty) {
                const emptyMsg = getEmptyStateMessage();
                elements.emptyState.innerHTML = `
                    <h3>${emptyMsg.title}</h3>
                    <p>${emptyMsg.message}</p>
                `;
            }

            // Update view tab counts and active state
            const viewCounts = getViewCounts();
            elements.viewTabs.forEach(tab => {
                const view = tab.dataset.view;
                const isActive = view === state.view;
                tab.classList.toggle('active', isActive);
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');

                // Update count badge
                const countSpan = tab.querySelector('.count');
                if (countSpan) {
                    if (view === 'issues') countSpan.textContent = viewCounts.issues;
                    else if (view === 'my-prs') countSpan.textContent = viewCounts.myPrs;
                    else if (view === 'others-prs') countSpan.textContent = viewCounts.othersPrs;
                }
            });

            // Update subfilter tab counts and active state
            const subfilterCounts = getSubfilterCounts();
            const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
            const currentStateFilter = viewFilters.state || 'all';
            const currentAuthorFilter = viewFilters.author || 'all';
            elements.subfilterTabs.forEach(tab => {
                const subfilter = tab.dataset.subfilter;
                const tabView = tab.closest('.subfilter-tabs')?.dataset.forView;
                const group = tab.closest('.subfilter-tabs')?.dataset.subfilterGroup || 'state';
                const currentSubfilter =
                    group === 'author' ? currentAuthorFilter : currentStateFilter;
                const isActive =
                    tabView === state.view &&
                    currentSubfilter !== 'all' &&
                    subfilter === currentSubfilter;
                tab.classList.toggle('active', isActive);
                tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');

                // Update count badge for visible tabs
                if (tabView === state.view) {
                    const countSpan = tab.querySelector('.count');
                    if (countSpan) {
                        if (isActive) {
                            countSpan.textContent = '';
                        } else {
                            const countMap =
                                group === 'author' ? subfilterCounts.author : subfilterCounts.state;
                            const countKey =
                                group === 'state' && subfilter === 'needs-review'
                                    ? 'needsReview'
                                    : subfilter;
                            countSpan.textContent = countMap[countKey] ?? 0;
                        }
                    }
                }
            });

            // Ensure correct subfilter tabs are visible
            updateSubfilterVisibility();
            updateCommentCacheStatus();

            // Update notification count header
            if (filteredNotifications.length > 0) {
                elements.notificationCount.textContent = `${filteredNotifications.length} notifications`;
            } else {
                elements.notificationCount.textContent = '';
            }

            // Show/hide select all row
            const showSelectAll =
                filteredNotifications.length > 0 ||
                (state.markingInProgress && state.markProgress.total > 0);
            elements.selectAllRow.style.display = showSelectAll ? 'flex' : 'none';

            // Update select all checkbox state
            if (showSelectAll) {
                const selectedInFilter = filteredNotifications.filter(n => state.selected.has(n.id)).length;
                const allSelected = selectedInFilter === filteredNotifications.length;
                const someSelected = selectedInFilter > 0 && !allSelected;

                elements.selectAllCheckbox.checked = allSelected;
                elements.selectAllCheckbox.indeterminate = someSelected;

                // Update selection count
                if (state.selected.size > 0) {
                    elements.selectionCount.textContent = `${state.selected.size} selected`;
                    elements.selectionCount.className = 'selection-count has-selection';
                } else {
                    elements.selectionCount.textContent = '';
                    elements.selectionCount.className = 'selection-count';
                }

                const markDoneState = getMarkDoneTargets(filteredNotifications);
                elements.markDoneBtn.style.display = markDoneState.show ? 'inline-block' : 'none';
                if (markDoneState.show) {
                    elements.markDoneBtn.textContent = markDoneState.label;
                }

                const openAllState = getOpenAllTargets(filteredNotifications);
                elements.openUnreadBtn.style.display = openAllState.show ? 'inline-flex' : 'none';

                const unsubscribeAllState = getUnsubscribeAllTargets(filteredNotifications);
                elements.unsubscribeAllBtn.style.display = unsubscribeAllState.show ? 'inline-block' : 'none';
            }

            // Update progress bar
            if (state.markingInProgress) {
                elements.progressContainer.className = 'progress-container visible';
                const percent = (state.markProgress.current / state.markProgress.total) * 100;
                elements.progressBarFill.style.width = `${percent}%`;
                elements.progressText.textContent = `Marking ${state.markProgress.current} of ${state.markProgress.total}...`;
            } else {
                elements.progressContainer.className = 'progress-container';
            }

            // Render notifications list
            elements.notificationsList.innerHTML = '';

            if (displayNotifications.length > 0) {
                const diffstatInfoById = new Map();
                const diffstatTotals = [];
                displayNotifications.forEach(notif => {
                    const info = getDiffstatInfo(notif);
                    if (info) {
                        diffstatInfoById.set(notif.id, info);
                        diffstatTotals.push(info.total);
                    }
                });
                const diffstatRange = diffstatTotals.length
                    ? {
                        min: Math.min(...diffstatTotals),
                        max: Math.max(...diffstatTotals),
                    }
                    : { min: null, max: null };
                displayNotifications.forEach(notif => {
                    const li = document.createElement('li');
                    const isSelected = state.selected.has(notif.id);
                    const isActive = state.activeNotificationId === notif.id;
                    li.className = 'notification-item' +
                        (notif.unread ? ' unread' : '') +
                        (isSelected ? ' selected' : '') +
                        (isActive ? ' keyboard-selected' : '');
                    li.setAttribute('data-id', notif.id);
                    li.setAttribute('data-type', notif.subject.type);
                    li.setAttribute('data-state', notif.subject.state || '');
                    if (isActive) {
                        li.setAttribute('aria-current', 'true');
                    }

                    // Build notification HTML
                    const iconClass = getIconStateClass(notif);
                    const iconSvg = getNotificationIcon(notif);
                    const stateBadge = getStateBadge(notif);
                    const relativeTime = formatRelativeTime(notif.updated_at);
                    const reason = formatReason(notif.reason);
                    const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
                    const stateFilter = viewFilters.state || 'all';
                    const commentStatus = getCommentStatus(notif);
                    const commentBadge = commentStatus
                        ? `<span class="comment-tag ${commentStatus.className}">${escapeHtml(commentStatus.label)}</span>`
                        : '';
                    const diffstatInfo = diffstatInfoById.get(notif.id);
                    const diffstatHue = diffstatInfo
                        ? getDiffstatHue(diffstatInfo.total, diffstatRange)
                        : null;
                    const diffstatHtml = diffstatInfo
                        ? `<span class="diffstat-tag" style="--diffstat-hue: ${diffstatHue}" title="${escapeHtml(diffstatInfo.title)}">+${diffstatInfo.additions}/-${diffstatInfo.deletions}</span>`
                        : '';
                    const authorLogin = getPullRequestAuthorLogin(notif);
                    const authorHtml = authorLogin
                        ? `<span class="notification-author">by ${escapeHtml(authorLogin)}</span>`
                        : '';
                    const commentItems = getCommentItems(notif);
                    const commentList = commentItems
                        ? `<ul class="comment-list">${commentItems}</ul>`
                        : '';
                    const bottomActions = commentItems
                        ? `
                            <div class="notification-actions-bottom">
                                <button
                                    type="button"
                                    class="notification-open-btn notification-open-btn-bottom"
                                    aria-label="Open notification in new tab"
                                    ${state.markingInProgress ? 'disabled' : ''}
                                >
                                    ${icons.openInNewTab}
                                    <span>Open in new tab</span>
                                </button>
                                <button
                                    type="button"
                                    class="notification-unsubscribe-btn notification-unsubscribe-btn-bottom"
                                    aria-label="Unsubscribe from notification"
                                    ${state.markingInProgress ? 'disabled' : ''}
                                >
                                    ${icons.bellSlash}
                                    <span>Unsubscribe</span>
                                </button>
                                <button
                                    type="button"
                                    class="notification-done-btn notification-done-btn-bottom"
                                    aria-label="Mark notification as done"
                                    ${state.markingInProgress ? 'disabled' : ''}
                                >
                                    ${icons.check}
                                    <span>Done</span>
                                </button>
                            </div>
                        `
                        : '';
                    const doneButton = `
                        <button
                            type="button"
                            class="notification-done-btn"
                            aria-label="Mark notification as done"
                            ${state.markingInProgress ? 'disabled' : ''}
                        >
                            ${icons.check}
                        </button>
                    `;
                    const unsubscribeButton = `
                        <button
                            type="button"
                            class="notification-unsubscribe-btn"
                            aria-label="Unsubscribe from notification"
                            ${state.markingInProgress ? 'disabled' : ''}
                        >
                            ${icons.bellSlash}
                        </button>
                    `;

                    // Actors HTML
                    let actorsHtml = '';
                    if (notif.actors && notif.actors.length > 0) {
                        actorsHtml = '<div class="notification-actors">';
                        notif.actors.slice(0, 3).forEach(actor => {
                            actorsHtml += `<img class="actor-avatar" src="${actor.avatar_url}" alt="${actor.login}" title="${actor.login}">`;
                        });
                        actorsHtml += '</div>';
                    }

                    li.innerHTML = `
                        <input
                            type="checkbox"
                            class="notification-checkbox"
                            ${isSelected ? 'checked' : ''}
                            ${state.markingInProgress ? 'disabled' : ''}
                            aria-label="Select notification: ${escapeHtml(notif.subject.title)}"
                        >
                        <div class="notification-icon ${iconClass}" data-type="${notif.subject.type}">
                            ${iconSvg}
                        </div>
                        <div class="notification-content">
                            <div class="notification-header">
                                <a href="${notif.subject.url}" class="notification-title" target="_blank" rel="noopener">
                                    ${renderInlineCode(notif.subject.title)}
                                </a>
                                ${authorHtml}
                                <div class="notification-meta">
                                    ${notif.subject.number ? `<span class="notification-number">#${notif.subject.number}</span>` : ''}
                                    ${stateBadge}
                                    <span class="notification-reason">${reason}</span>
                                    ${diffstatHtml}
                                    ${commentBadge}
                                </div>
                            </div>
                            ${commentList}
                            ${bottomActions}
                        </div>
                        ${actorsHtml}
                        <div class="notification-actions-inline">
                            <time class="notification-time" datetime="${notif.updated_at}" title="${new Date(notif.updated_at).toLocaleString()}">
                                ${relativeTime}
                            </time>
                            ${doneButton}
                            ${unsubscribeButton}
                        </div>
                    `;

                    // Add checkbox click handler
                    const checkbox = li.querySelector('.notification-checkbox');
                    checkbox.addEventListener('click', (e) => {
                        e.stopPropagation();
                        handleNotificationCheckbox(notif.id, e);
                    });

                    const doneButtons = li.querySelectorAll('.notification-done-btn');
                    doneButtons.forEach((doneBtn) => {
                        doneBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            withActionContext('Mark done (inline)', () =>
                                handleInlineMarkDone(notif.id, doneBtn)
                            );
                        });
                    });

                    const unsubscribeButtons = li.querySelectorAll('.notification-unsubscribe-btn');
                    unsubscribeButtons.forEach((unsubscribeBtn) => {
                        unsubscribeBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            withActionContext('Unsubscribe (inline)', () =>
                                handleInlineUnsubscribe(notif.id, unsubscribeBtn)
                            );
                        });
                    });

                    const openButtons = li.querySelectorAll('.notification-open-btn');
                    openButtons.forEach((openBtn) => {
                        openBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            window.open(notif.subject.url, '_blank', 'noopener');
                        });
                    });

                    li.addEventListener('click', () => {
                        setActiveNotification(notif.id);
                    });

                    elements.notificationsList.appendChild(li);
                });
            }

            if (state.scrollLock) {
                const now = Date.now();
                if (now <= state.scrollLock.until) {
                    if (window.scrollY !== state.scrollLock.top) {
                        window.scrollTo(0, state.scrollLock.top);
                    }
                } else {
                    state.scrollLock = null;
                }
            }
        }

        let markdownConfigured = false;

        function renderInlineCode(text) {
            const escaped = escapeHtml(String(text || ''));
            return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
        }

        function renderMarkdown(text) {
            if (!window.marked || !window.DOMPurify) {
                return escapeHtml(String(text || ''));
            }
            if (!markdownConfigured) {
                window.marked.setOptions({
                    gfm: true,
                    breaks: true,
                    mangle: false,
                    headerIds: false,
                });
                markdownConfigured = true;
            }
            return window.DOMPurify.sanitize(window.marked.parse(String(text || '')));
        }

        // Escape HTML to prevent XSS
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function parseRepoInput(value) {
            const trimmed = value.trim();
            if (!trimmed) {
                return null;
            }
            const parts = trimmed.split('/');
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
                return null;
            }
            return { owner: parts[0], repo: parts[1] };
        }
