// Comment-related constants are in notifications-comments.js
        const TYPE_FILTER_KEY = 'ghnotif_type_filter';
        const LAST_SYNCED_REPO_KEY = 'ghnotif_last_synced_repo';

        // Application state
        const state = {
            repo: null,
            notifications: [],
            loading: false,
            error: null,
            filter: 'all', // 'all', 'open', 'closed', 'needs-review', 'approved', 'uninteresting'
            typeFilter: 'all', // 'all', 'issue', 'pull'
            selected: new Set(), // Set of selected notification IDs
            activeNotificationId: null, // Keyboard selection cursor
            lastClickedId: null, // For shift-click range selection
            markingInProgress: false, // Whether Mark Done is in progress
            markProgress: { current: 0, total: 0 }, // Progress tracking
            commentPrefetchEnabled: false,
            commentExpandEnabled: false,
            commentHideUninteresting: false,
            commentQueue: [],
            commentQueueRunning: false,
            commentCache: loadCommentCache(),
            rateLimit: null,
            rateLimitError: null,
            currentUserLogin: null,
            commentBodyExpanded: new Set(),
            lastSyncedRepo: null,
            // Undo support
            authenticity_token: null, // CSRF token for HTML form actions
            undoStack: [], // Stack of {action, notifications, timestamp}
            undoInProgress: false,
        };

        // DOM elements
        const elements = {
            repoInput: document.getElementById('repo-input'),
            syncBtn: document.getElementById('sync-btn'),
            fullSyncBtn: document.getElementById('full-sync-btn'),
            authStatus: document.getElementById('auth-status'),
            statusBar: document.getElementById('status-bar'),
            commentPrefetchToggle: document.getElementById('comment-prefetch-toggle'),
            commentExpandToggle: document.getElementById('comment-expand-toggle'),
            commentHideUninterestingToggle: document.getElementById('comment-hide-uninteresting-toggle'),
            commentCacheStatus: document.getElementById('comment-cache-status'),
            clearCommentCacheBtn: document.getElementById('clear-comment-cache-btn'),
            rateLimitBox: document.getElementById('rate-limit-box'),
            loading: document.getElementById('loading'),
            emptyState: document.getElementById('empty-state'),
            notificationsList: document.getElementById('notifications-list'),
            notificationCount: document.getElementById('notification-count'),
            filterTabs: document.querySelectorAll('.filter-tab'),
            typeFilterButtons: document.querySelectorAll('.type-filter-btn'),
            countAll: document.getElementById('count-all'),
            countOpen: document.getElementById('count-open'),
            countClosed: document.getElementById('count-closed'),
            countNeedsReview: document.getElementById('count-needs-review'),
            countApproved: document.getElementById('count-approved'),
            countUninteresting: document.getElementById('count-uninteresting'),
            selectAllRow: document.getElementById('select-all-row'),
            selectAllCheckbox: document.getElementById('select-all-checkbox'),
            selectionCount: document.getElementById('selection-count'),
            markDoneBtn: document.getElementById('mark-done-btn'),
            progressContainer: document.getElementById('progress-container'),
            progressBarFill: document.getElementById('progress-bar-fill'),
            progressText: document.getElementById('progress-text'),
        };

        function persistNotifications() {
            localStorage.setItem(
                'ghnotif_notifications',
                JSON.stringify(state.notifications)
            );
        }

        // loadCommentCache, saveCommentCache, isCommentCacheFresh are in notifications-comments.js

        // Initialize app
        function init() {
            // Load saved repo from localStorage
            const savedRepo = localStorage.getItem('ghnotif_repo');
            if (savedRepo) {
                elements.repoInput.value = savedRepo;
                state.repo = savedRepo;
            }

            // Load saved notifications from localStorage
            const savedNotifications = localStorage.getItem('ghnotif_notifications');
            if (savedNotifications) {
                try {
                    state.notifications = JSON.parse(savedNotifications);
                } catch (e) {
                    console.error('Failed to parse saved notifications:', e);
                }
            }
            state.lastSyncedRepo = localStorage.getItem(LAST_SYNCED_REPO_KEY);

            // Load saved filter from localStorage
            const savedFilter = localStorage.getItem('ghnotif_filter');
            if (
                savedFilter &&
                ['all', 'open', 'closed', 'needs-review', 'approved', 'uninteresting'].includes(
                    savedFilter
                )
            ) {
                state.filter = savedFilter;
            }

            const savedTypeFilter = localStorage.getItem(TYPE_FILTER_KEY);
            if (savedTypeFilter && ['all', 'issue', 'pull'].includes(savedTypeFilter)) {
                state.typeFilter = savedTypeFilter;
            }

            const savedCommentPrefetch = localStorage.getItem(COMMENT_PREFETCH_KEY);
            if (savedCommentPrefetch === 'true') {
                state.commentPrefetchEnabled = true;
            }
            elements.commentPrefetchToggle.checked = state.commentPrefetchEnabled;

            const savedCommentExpand = localStorage.getItem(COMMENT_EXPAND_KEY);
            if (savedCommentExpand === 'true') {
                state.commentExpandEnabled = true;
            }
            elements.commentExpandToggle.checked = state.commentExpandEnabled;

            const savedCommentHideUninteresting = localStorage.getItem(COMMENT_HIDE_UNINTERESTING_KEY);
            if (savedCommentHideUninteresting === 'true') {
                state.commentHideUninteresting = true;
            }
            elements.commentHideUninterestingToggle.checked = state.commentHideUninteresting;

            // Set up event listeners
            elements.syncBtn.addEventListener('click', () => handleSync({ mode: 'incremental' }));
            elements.fullSyncBtn.addEventListener('click', () => handleSync({ mode: 'full' }));
            elements.repoInput.addEventListener('input', handleRepoInput);
            elements.repoInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    handleSync({ mode: 'incremental' });
                }
            });

            // Filter tab click handlers
            elements.filterTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const filter = tab.dataset.filter;
                    setFilter(filter);
                });
            });

            elements.typeFilterButtons.forEach(button => {
                button.addEventListener('click', () => {
                    const filter = button.dataset.type;
                    setTypeFilter(filter);
                });
            });

            elements.commentPrefetchToggle.addEventListener('change', (event) => {
                setCommentPrefetchEnabled(event.target.checked);
            });
            elements.commentExpandToggle.addEventListener('change', (event) => {
                setCommentExpandEnabled(event.target.checked);
            });
            elements.commentHideUninterestingToggle.addEventListener('change', (event) => {
                setCommentHideUninteresting(event.target.checked);
            });
            elements.clearCommentCacheBtn.addEventListener('click', handleClearCommentCache);

            // Select all checkbox handler
            elements.selectAllCheckbox.addEventListener('change', handleSelectAll);

            // Mark Done button handler
            elements.markDoneBtn.addEventListener('click', handleMarkDone);

            // Keyboard shortcuts
            document.addEventListener('keydown', handleKeyDown);

            // Check auth status
            checkAuth();
            refreshRateLimit();

            // Initial render
            render();
        }

        // Handle repo input changes
        function handleRepoInput() {
            const value = elements.repoInput.value.trim();
            state.repo = value || null;
            localStorage.setItem('ghnotif_repo', value);
        }

        function setCommentPrefetchEnabled(enabled) {
            state.commentPrefetchEnabled = enabled;
            localStorage.setItem(COMMENT_PREFETCH_KEY, String(enabled));
            if (!enabled) {
                render();
                return;
            }
            showStatus('Fetching comments for triage filters...', 'info', { flash: true });
            ensureLastReadAtData(state.notifications)
                .then((notifications) => {
                    state.notifications = notifications;
                    persistNotifications();
                    state.commentQueue = [];
                    scheduleCommentPrefetch(notifications);
                    render();
                })
                .catch((e) => {
                    showStatus(`Comment prefetch setup failed: ${e.message}`, 'error');
                    render();
                });
        }

        function setCommentExpandEnabled(enabled) {
            state.commentExpandEnabled = enabled;
            localStorage.setItem(COMMENT_EXPAND_KEY, String(enabled));
            render();
        }

        function setCommentHideUninteresting(enabled) {
            state.commentHideUninteresting = enabled;
            localStorage.setItem(COMMENT_HIDE_UNINTERESTING_KEY, String(enabled));
            render();
        }

        // Set the current filter
        function setFilter(filter) {
            if (
                !['all', 'open', 'closed', 'needs-review', 'approved', 'uninteresting'].includes(
                    filter
                )
            ) {
                return;
            }
            state.filter = filter;
            localStorage.setItem('ghnotif_filter', filter);
            if (
                ['uninteresting', 'needs-review', 'approved'].includes(filter) &&
                !state.commentPrefetchEnabled
            ) {
                showStatus('Enable comment fetching to evaluate triage filters.', 'info');
            }
            render();
        }

        function setTypeFilter(filter) {
            if (!['all', 'issue', 'pull'].includes(filter)) return;
            state.typeFilter = filter;
            localStorage.setItem(TYPE_FILTER_KEY, filter);
            render();
        }

        function matchesTypeFilter(notification) {
            if (state.typeFilter === 'issue') {
                return notification.subject.type === 'Issue';
            }
            if (state.typeFilter === 'pull') {
                return notification.subject.type === 'PullRequest';
            }
            return true;
        }

        function safeIsNotificationNeedsReview(notification) {
            return typeof isNotificationNeedsReview === 'function'
                ? isNotificationNeedsReview(notification)
                : false;
        }

        function safeIsNotificationApproved(notification) {
            return typeof isNotificationApproved === 'function'
                ? isNotificationApproved(notification)
                : false;
        }

        // Get filtered notifications based on current filter
        function getFilteredNotifications() {
            let filtered = state.notifications;
            if (state.filter !== 'all') {
                filtered = filtered.filter(notif => {
                    const notifState = notif.subject.state;
                    if (state.filter === 'open') {
                        return notifState === 'open' || notifState === 'draft';
                    }
                    if (state.filter === 'closed') {
                        return notifState === 'closed' || notifState === 'merged';
                    }
                    if (state.filter === 'needs-review') {
                        return safeIsNotificationNeedsReview(notif);
                    }
                    if (state.filter === 'approved') {
                        return safeIsNotificationApproved(notif);
                    }
                    if (state.filter === 'uninteresting') {
                        return isNotificationUninteresting(notif);
                    }
                    return true;
                });
            }
            return filtered.filter(matchesTypeFilter);
        }

        // Count notifications by filter category
        function getFilterCounts() {
            let open = 0;
            let closed = 0;
            let needsReview = 0;
            let approved = 0;
            let uninteresting = 0;
            const typedNotifications = state.notifications.filter(matchesTypeFilter);
            typedNotifications.forEach(notif => {
                const notifState = notif.subject.state;
                if (notifState === 'open' || notifState === 'draft') {
                    open++;
                } else if (notifState === 'closed' || notifState === 'merged') {
                    closed++;
                }
                if (safeIsNotificationNeedsReview(notif)) {
                    needsReview++;
                }
                if (safeIsNotificationApproved(notif)) {
                    approved++;
                }
                if (isNotificationUninteresting(notif)) {
                    uninteresting++;
                }
            });
            return {
                all: typedNotifications.length,
                open,
                closed,
                needsReview,
                approved,
                uninteresting,
            };
        }

        function updateCommentCacheStatus() {
            const cachedCount = Object.keys(state.commentCache.threads || {}).length;
            elements.clearCommentCacheBtn.disabled = cachedCount === 0;
            if (!state.commentPrefetchEnabled) {
                elements.commentCacheStatus.textContent = 'Comments: off';
                return;
            }
            elements.commentCacheStatus.textContent = `Comments cached: ${cachedCount}`;
        }

        function handleClearCommentCache() {
            state.commentCache = { version: 1, threads: {} };
            state.commentQueue = [];
            localStorage.removeItem(COMMENT_CACHE_KEY);
            if (state.commentPrefetchEnabled && state.notifications.length > 0) {
                scheduleCommentPrefetch(state.notifications);
                showStatus('Comment cache cleared. Refetching comments...', 'info');
            } else {
                showStatus('Comment cache cleared.', 'success');
            }
            render();
        }

        function formatRateLimit(rateLimit, error) {
            if (error) {
                return `Rate limit error: ${error}`;
            }
            if (!rateLimit?.resources?.core) {
                return 'Rate limit: unknown';
            }
            const core = rateLimit.resources.core;
            const resetAt = core.reset
                ? new Date(core.reset * 1000).toLocaleTimeString()
                : 'unknown';
            return `Rate limit: ${core.remaining}/${core.limit} reset @ ${resetAt}`;
        }

        function updateRateLimitBox() {
            elements.rateLimitBox.textContent = formatRateLimit(
                state.rateLimit,
                state.rateLimitError
            );
        }

        async function refreshRateLimit() {
            try {
                const response = await fetch('/github/rest/rate_limit');
                if (!response.ok) {
                    throw new Error(`Request failed (${response.status})`);
                }
                const data = await response.json();
                state.rateLimit = data;
                state.rateLimitError = null;
            } catch (error) {
                state.rateLimitError = error.message || String(error);
            }
            updateRateLimitBox();
        }

        function getNotificationKey(notification) {
            return String(notification.id);
        }

        function getIssueNumber(notification) {
            const number = notification?.subject?.number;
            return typeof number === 'number' ? number : null;
        }

        function getNotificationMatchKey(notification) {
            const repo = parseRepoInput(state.repo || '');
            const number = notification?.subject?.number;
            const type = notification?.subject?.type || 'unknown';
            if (repo && typeof number === 'number') {
                return `${repo.owner}/${repo.repo}:${type}:${number}`;
            }
            return `id:${getNotificationKey(notification)}`;
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

        async function fetchJson(url) {
            const response = await fetch(url);
            if (!response.ok) {
                let detail = '';
                try {
                    detail = await response.text();
                } catch (error) {
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
                    payload = await fetchJson(url);
                } catch (error) {
                    showStatus(`Rate limit fetch failed: ${error.message || error}`, 'error');
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

        async function ensureLastReadAtData(notifications) {
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
                if (key) {
                    missingKeys.add(key);
                }
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

        // Comment prefetching, classification, and display functions are in notifications-comments.js:
        // scheduleCommentPrefetch, runCommentQueue, toIssueComment, fetchAllIssueComments,
        // fetchPullRequestReviews, prefetchNotificationComments, getCommentStatus, getCommentItems,
        // filterCommentsAfterOwnComment, isNotificationUninteresting, isNotificationNeedsReview,
        // isNotificationApproved, hasApprovedReview, isUninterestingComment, isRevertRelated,
        // isBotAuthor, isBotInteractionComment

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

            if (event.shiftKey && state.lastClickedId) {
                // Shift-click: select range
                selectRange(state.lastClickedId, notifId, filtered);
            } else {
                // Regular click: toggle single
                toggleSelection(notifId);
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

        // Select a range of notifications (for shift-click)
        function selectRange(fromId, toId, notifications) {
            const ids = notifications.map(n => n.id);
            const fromIndex = ids.indexOf(fromId);
            const toIndex = ids.indexOf(toId);

            if (fromIndex === -1 || toIndex === -1) return;

            const start = Math.min(fromIndex, toIndex);
            const end = Math.max(fromIndex, toIndex);

            for (let i = start; i <= end; i++) {
                state.selected.add(ids[i]);
            }
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
            const isClosedOrUninteresting =
                state.filter === 'closed' || state.filter === 'uninteresting';
            if (isClosedOrUninteresting && filteredNotifications.length > 0) {
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

        function getSelectableNotifications() {
            return getFilteredNotifications();
        }

        function captureScrollAnchor(removedIds, notifications) {
            if (!removedIds || removedIds.length === 0) {
                return null;
            }
            const removedSet = new Set(removedIds);
            const shouldSnapToTop = removedIds.some(id => {
                const removedElement = getNotificationElement(id);
                if (!removedElement) {
                    return false;
                }
                const rect = removedElement.getBoundingClientRect();
                return rect.top < 0 && rect.bottom > 0;
            });
            let lastRemovedIndex = -1;
            notifications.forEach((notif, index) => {
                if (removedSet.has(notif.id)) {
                    lastRemovedIndex = index;
                }
            });
            if (lastRemovedIndex === -1 || lastRemovedIndex + 1 >= notifications.length) {
                return null;
            }
            const anchorId = notifications[lastRemovedIndex + 1].id;
            const anchorElement = getNotificationElement(anchorId);
            if (!anchorElement) {
                return null;
            }
            return {
                id: anchorId,
                top: shouldSnapToTop ? 0 : anchorElement.getBoundingClientRect().top,
            };
        }

        function restoreScrollAnchor(anchor) {
            if (!anchor) {
                return;
            }
            const anchorElement = getNotificationElement(anchor.id);
            if (!anchorElement) {
                return;
            }
            const newTop = anchorElement.getBoundingClientRect().top;
            const delta = newTop - anchor.top;
            if (delta !== 0) {
                window.scrollBy(0, delta);
            }
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
            state.activeNotificationId = notifId;
            render();
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
            state.activeNotificationId = selectable[nextIndex].id;
            render();
            scrollActiveNotificationIntoView();
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
                    await handleInlineMarkDone(state.activeNotificationId, doneButton);
                }
                return;
            }
            if (action === 'unsubscribe') {
                const unsubscribeButton = item.querySelector('.notification-unsubscribe-btn');
                if (!unsubscribeButton) {
                    showStatus('Unsubscribe is not available for this notification.', 'info');
                    return;
                }
                await handleInlineUnsubscribe(state.activeNotificationId, unsubscribeButton);
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

            // Escape: Clear selection
            if (e.key === 'Escape' && state.selected.size > 0) {
                clearSelection();
                e.preventDefault();
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

        // Get appropriate empty state message
        function getEmptyStateMessage() {
            if (state.notifications.length === 0) {
                return {
                    title: 'No notifications',
                    message: 'Enter a repository and click Quick Sync to load notifications.',
                };
            }

            const typeLabel =
                state.typeFilter === 'issue'
                    ? 'issue'
                    : state.typeFilter === 'pull'
                        ? 'PR'
                        : null;

            // Have notifications but filter shows none
            if (state.filter === 'open') {
                return {
                    title: typeLabel
                        ? `No open ${typeLabel} notifications`
                        : 'No open notifications',
                    message: 'All notifications in this repository are closed or merged.',
                };
            }

            if (state.filter === 'closed') {
                return {
                    title: typeLabel
                        ? `No closed ${typeLabel} notifications`
                        : 'No closed notifications',
                    message: 'All notifications in this repository are still open.',
                };
            }

            if (state.filter === 'needs-review') {
                if (!state.commentPrefetchEnabled) {
                    return {
                        title: 'Comment fetching disabled',
                        message: 'Enable comment fetching to evaluate triage filters.',
                    };
                }
                return {
                    title: 'No PRs need review',
                    message: 'No PRs without comments need your review right now.',
                };
            }

            if (state.filter === 'approved') {
                if (!state.commentPrefetchEnabled) {
                    return {
                        title: 'Comment fetching disabled',
                        message: 'Enable comment fetching to evaluate triage filters.',
                    };
                }
                return {
                    title: 'No approved PRs',
                    message: 'No approved PR notifications are pending.',
                };
            }

            if (state.filter === 'uninteresting') {
                if (!state.commentPrefetchEnabled) {
                    return {
                        title: 'Comment fetching disabled',
                        message: 'Enable comment fetching to evaluate triage filters.',
                    };
                }
                return {
                    title: typeLabel
                        ? `No uninteresting ${typeLabel} notifications`
                        : 'No uninteresting notifications',
                    message: 'All recent comments include something worth a look.',
                };
            }

            if (typeLabel) {
                return {
                    title: `No ${typeLabel} notifications`,
                    message: `No ${typeLabel} notifications match the current filter.`,
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

                let notifications = sortedNotifications;
                if (state.commentPrefetchEnabled) {
                    const missingCount = countMissingLastReadAt(sortedNotifications);
                    if (missingCount > 0) {
                        showStatus(
                            `${syncLabel}: fetching last_read_at for ${missingCount} notifications`,
                            'info',
                            { flash: true }
                        );
                    } else {
                        showStatus(
                            `${syncLabel}: last_read_at already present`,
                            'info'
                        );
                    }
                    notifications = await ensureLastReadAtData(sortedNotifications);
                    const remainingMissing = countMissingLastReadAt(notifications);
                    const filledCount = Math.max(missingCount - remainingMissing, 0);
                    if (missingCount > 0) {
                        showStatus(
                            `${syncLabel}: filled last_read_at for ${filledCount}/${missingCount} notifications`,
                            'info'
                        );
                    }
                }

                state.notifications = notifications;
                state.loading = false;
                state.lastSyncedRepo = repo;
                localStorage.setItem(LAST_SYNCED_REPO_KEY, repo);

                // Save to localStorage
                persistNotifications();

                if (state.commentPrefetchEnabled) {
                    state.commentQueue = [];
                    scheduleCommentPrefetch(notifications);
                }

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
        function showStatus(message, type) {
            elements.statusBar.textContent = message;
            elements.statusBar.className = `status-bar visible ${type}`;
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
            bellOff: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.61 1.11a.75.75 0 0 1 1.06 0l10.22 10.22a.75.75 0 1 1-1.06 1.06l-2.02-2.02H2.5a.75.75 0 0 1 0-1.5h1.09L1.1 3.4a.75.75 0 0 1 0-1.06l2.5-2.5Zm3.64 3.64L5.98 3.48 3.4 6.06 4.67 7.33a2.75 2.75 0 0 0 2.58 1.54h1.58l-1.58-1.58Zm3.61 3.61 1.54 1.54a2.75 2.75 0 0 0 .89-2.04V6a3.5 3.5 0 0 0-3-3.46V2a1.5 1.5 0 0 0-3 0v.54a3.49 3.49 0 0 0-1.55.73l1.1 1.1a2 2 0 0 1 3.69 1.1v1.33l1.33 1.33Zm-1.68 4.16a2 2 0 0 1-3.36 0h3.36Z"></path></svg>`,
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

        // Render the UI
        function render() {
            // Show/hide loading state
            elements.loading.className = state.loading ? 'loading visible' : 'loading';

            // Get filtered notifications
            const filteredNotifications = getFilteredNotifications();
            const displayNotifications = filteredNotifications;
            ensureActiveNotification(filteredNotifications);

            // Show/hide empty state with dynamic message
            const showEmpty =
                !state.loading &&
                filteredNotifications.length === 0;
            elements.emptyState.style.display = showEmpty ? 'block' : 'none';
            if (showEmpty) {
                const emptyMsg = getEmptyStateMessage();
                elements.emptyState.innerHTML = `
                    <h3>${emptyMsg.title}</h3>
                    <p>${emptyMsg.message}</p>
                `;
            }

            // Update filter tab counts and active state
            const counts = getFilterCounts();
            elements.countAll.textContent = counts.all;
            elements.countOpen.textContent = counts.open;
            elements.countClosed.textContent = counts.closed;
            elements.countNeedsReview.textContent = counts.needsReview;
            elements.countApproved.textContent = counts.approved;
            elements.countUninteresting.textContent = counts.uninteresting;
            updateCommentCacheStatus();

            // Update filter tab active states
            elements.filterTabs.forEach(tab => {
                const isActive = tab.dataset.filter === state.filter;
                tab.classList.toggle('active', isActive);
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });

            elements.typeFilterButtons.forEach(button => {
                const isActive = button.dataset.type === state.typeFilter;
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-checked', isActive ? 'true' : 'false');
            });

            // Update notification count header
            if (filteredNotifications.length > 0) {
                elements.notificationCount.textContent = `${filteredNotifications.length} notifications`;
            } else {
                elements.notificationCount.textContent = '';
            }

            // Show/hide select all row
            const showSelectAll = filteredNotifications.length > 0;
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
                    const commentStatus =
                        state.commentPrefetchEnabled ||
                        ['uninteresting', 'needs-review', 'approved'].includes(state.filter)
                            ? getCommentStatus(notif)
                            : null;
                    const commentBadge = commentStatus
                        ? `<span class="comment-tag ${commentStatus.className}">${escapeHtml(commentStatus.label)}</span>`
                        : '';
                    const commentItems = getCommentItems(notif);
                    const commentList = commentItems
                        ? `<ul class="comment-list">${commentItems}</ul>`
                        : '';
                    const bottomUnsubscribeButton = `
                        <button
                            type="button"
                            class="notification-unsubscribe-btn notification-unsubscribe-btn-bottom"
                            aria-label="Unsubscribe from notification"
                            ${state.markingInProgress ? 'disabled' : ''}
                        >
                            ${icons.bellOff}
                            <span>Unsubscribe</span>
                        </button>
                    `;
                    const bottomActions = `
                        <div class="notification-actions-bottom">
                            ${bottomUnsubscribeButton}
                            ${commentItems
                                ? `
                                    <button
                                        type="button"
                                        class="notification-done-btn notification-done-btn-bottom"
                                        aria-label="Mark notification as done"
                                        ${state.markingInProgress ? 'disabled' : ''}
                                    >
                                        ${icons.check}
                                        <span>Done</span>
                                    </button>
                                `
                                : ''}
                        </div>
                    `;
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
                            ${icons.bellOff}
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
                            <a href="${notif.subject.url}" class="notification-title" target="_blank" rel="noopener">
                                ${escapeHtml(notif.subject.title)}
                            </a>
                            <div class="notification-meta">
                                ${notif.subject.number ? `<span class="notification-number">#${notif.subject.number}</span>` : ''}
                                ${stateBadge}
                                <span class="notification-reason">${reason}</span>
                                ${commentBadge}
                            </div>
                            ${commentList}
                            ${bottomActions}
                        </div>
                        ${actorsHtml}
                        <div class="notification-actions-inline">
                            <time class="notification-time" datetime="${notif.updated_at}" title="${new Date(notif.updated_at).toLocaleString()}">
                                ${relativeTime}
                            </time>
                            ${unsubscribeButton}
                            ${doneButton}
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
                            handleInlineMarkDone(notif.id, doneBtn);
                        });
                    });

                    const unsubscribeButtons = li.querySelectorAll('.notification-unsubscribe-btn');
                    unsubscribeButtons.forEach((unsubscribeBtn) => {
                        unsubscribeBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            handleInlineUnsubscribe(notif.id, unsubscribeBtn);
                        });
                    });

                    li.addEventListener('click', () => {
                        setActiveNotification(notif.id);
                    });

                    elements.notificationsList.appendChild(li);
                });
            }
        }

        let markdownConfigured = false;

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

        // Start the app
        init();
