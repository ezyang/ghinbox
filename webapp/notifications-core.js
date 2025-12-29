// Comment-related constants are in notifications-comments.js
        const LAST_SYNCED_REPO_KEY = 'ghnotif_last_synced_repo';
        const VIEW_KEY = 'ghnotif_view';
        const VIEW_FILTERS_KEY = 'ghnotif_view_filters';
        const AUTH_TOKEN_KEY = 'ghnotif_authenticity_token';
        const ORDER_KEY = 'ghnotif_order';

        // Default view filters for each view
        const DEFAULT_VIEW_FILTERS = {
            'issues': { state: 'all' }, // 'all' | 'open' | 'closed'
            'my-prs': { state: 'all' }, // 'all'
            'others-prs': {
                state: 'all', // 'all' | 'needs-review' | 'approved' | 'draft' | 'closed'
                author: 'all', // 'all' | 'committer' | 'external'
            },
        };

        // Application state
        const state = {
            repo: null,
            notifications: [],
            loading: false,
            error: null,
            view: 'issues', // 'issues', 'my-prs', 'others-prs'
            viewFilters: JSON.parse(JSON.stringify(DEFAULT_VIEW_FILTERS)),
            orderBy: 'recent',
            selected: new Set(), // Set of selected notification IDs
            activeNotificationId: null, // Keyboard selection cursor
            lastClickedId: null, // For shift-click range selection
            markingInProgress: false, // Whether Mark Done is in progress
            markProgress: { current: 0, total: 0 }, // Progress tracking
            doneSnapshot: { pending: 0, done: 0 }, // Current done snapshot counts
            commentPrefetchEnabled: false,
            commentExpandEnabled: false,
            commentHideUninteresting: false,
            commentQueue: [],
            commentQueueRunning: false,
            commentCache: { version: 1, threads: {} },
            rateLimit: null,
            rateLimitError: null,
            graphqlRateLimit: null,
            graphqlRateLimitError: null,
            currentUserLogin: null,
            commentBodyExpanded: new Set(),
            lastSyncedRepo: null,
            // Keyboard navigation
            lastGKeyTime: 0, // For vim-style 'gg' sequence
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
            orderSelect: document.getElementById('order-select'),
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
            viewTabs: document.querySelectorAll('.view-tab'),
            subfilterTabs: document.querySelectorAll('.subfilter-tab'),
            subfilterContainers: document.querySelectorAll('.subfilter-tabs'),
            selectAllRow: document.getElementById('select-all-row'),
            selectAllCheckbox: document.getElementById('select-all-checkbox'),
            selectionCount: document.getElementById('selection-count'),
            markDoneBtn: document.getElementById('mark-done-btn'),
            openUnreadBtn: document.getElementById('open-unread-btn'),
            unsubscribeAllBtn: document.getElementById('unsubscribe-all-btn'),
            progressContainer: document.getElementById('progress-container'),
            progressBarFill: document.getElementById('progress-bar-fill'),
            progressText: document.getElementById('progress-text'),
            keyboardShortcutsOverlay: document.getElementById('keyboard-shortcuts-overlay'),
            keyboardShortcutsClose: document.getElementById('keyboard-shortcuts-close'),
        };

        function normalizeViewFilters(raw) {
            const normalized = JSON.parse(JSON.stringify(DEFAULT_VIEW_FILTERS));
            if (!raw || typeof raw !== 'object') {
                return normalized;
            }
            ['issues', 'my-prs', 'others-prs'].forEach((view) => {
                const value = raw[view];
                if (typeof value === 'string') {
                    normalized[view].state = value;
                    return;
                }
                if (value && typeof value === 'object') {
                    normalized[view] = {
                        ...normalized[view],
                        ...value,
                    };
                }
            });
            return normalized;
        }

        function persistNotifications() {
            saveNotificationsCache(state.notifications).catch((error) => {
                console.error('Failed to persist notifications cache:', error);
            });
        }

        function persistAuthenticityToken(token) {
            if (token) {
                localStorage.setItem(AUTH_TOKEN_KEY, token);
                return;
            }
            localStorage.removeItem(AUTH_TOKEN_KEY);
        }

        // loadCommentCache, saveCommentCache, isCommentCacheFresh are in notifications-comments.js

        // Initialize app
        async function loadNotificationsFromCache() {
            try {
                const cached = await loadNotificationsCache();
                if (Array.isArray(cached)) {
                    return cached;
                }
            } catch (error) {
                console.error('Failed to load notifications cache from IndexedDB:', error);
            }
            const legacy = localStorage.getItem('ghnotif_notifications');
            if (!legacy) {
                return [];
            }
            try {
                const parsed = JSON.parse(legacy);
                if (Array.isArray(parsed)) {
                    await saveNotificationsCache(parsed);
                    localStorage.removeItem('ghnotif_notifications');
                    return parsed;
                }
            } catch (error) {
                console.error('Failed to parse saved notifications:', error);
            }
            return [];
        }

        // Initialize app
        async function init() {
            // Load saved repo from localStorage
            const savedRepo = localStorage.getItem('ghnotif_repo');
            if (savedRepo) {
                elements.repoInput.value = savedRepo;
                state.repo = savedRepo;
            }

            // Load cached notifications and comments from IndexedDB
            state.notifications = await loadNotificationsFromCache();
            try {
                state.commentCache = await loadCommentCache();
            } catch (error) {
                console.error('Failed to load comment cache:', error);
            }
            state.lastSyncedRepo = localStorage.getItem(LAST_SYNCED_REPO_KEY);
            const savedAuthToken = localStorage.getItem(AUTH_TOKEN_KEY);
            if (savedAuthToken) {
                state.authenticity_token = savedAuthToken;
            }

            // Load saved view from localStorage
            const savedView = localStorage.getItem(VIEW_KEY);
            if (savedView && ['issues', 'my-prs', 'others-prs'].includes(savedView)) {
                state.view = savedView;
            }

            const savedOrder = localStorage.getItem(ORDER_KEY);
            if (savedOrder && ['recent', 'size'].includes(savedOrder)) {
                state.orderBy = savedOrder;
            }
            if (elements.orderSelect) {
                elements.orderSelect.value = state.orderBy;
            }

            // Load saved view filters from localStorage
            const savedViewFilters = localStorage.getItem(VIEW_FILTERS_KEY);
            if (savedViewFilters) {
                try {
                    const parsed = JSON.parse(savedViewFilters);
                    state.viewFilters = normalizeViewFilters(parsed);
                } catch (e) {
                    console.error('Failed to parse saved view filters:', e);
                }
            }

            // Migration: clean up old filter state keys
            localStorage.removeItem('ghnotif_filter');
            localStorage.removeItem('ghnotif_type_filter');

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
            if (elements.orderSelect) {
                elements.orderSelect.addEventListener('change', (event) => {
                    const nextOrder = event.target.value;
                    if (!['recent', 'size'].includes(nextOrder)) {
                        return;
                    }
                    state.orderBy = nextOrder;
                    localStorage.setItem(ORDER_KEY, nextOrder);
                    render();
                });
            }

            // View tab click handlers
            elements.viewTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const view = tab.dataset.view;
                    setView(view);
                });
            });

            // Subfilter tab click handlers
            elements.subfilterTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const subfilter = tab.dataset.subfilter;
                    const group = tab
                        .closest('.subfilter-tabs')
                        ?.dataset.subfilterGroup || 'state';
                    setSubfilter(subfilter, group);
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

            // Open All button handler
            elements.openUnreadBtn.addEventListener('click', handleOpenAllFiltered);

            // Unsubscribe All button handler
            elements.unsubscribeAllBtn.addEventListener('click', handleUnsubscribeAll);

            // Keyboard shortcuts
            document.addEventListener('keydown', handleKeyDown);

            // Keyboard shortcuts overlay handlers
            elements.keyboardShortcutsClose.addEventListener('click', hideKeyboardShortcutsOverlay);
            elements.keyboardShortcutsOverlay.addEventListener('click', (e) => {
                // Close when clicking the backdrop (not the modal itself)
                if (e.target === elements.keyboardShortcutsOverlay) {
                    hideKeyboardShortcutsOverlay();
                }
            });

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

        // Set the current view
        function setView(view) {
            if (!['issues', 'my-prs', 'others-prs'].includes(view)) {
                return;
            }
            state.view = view;
            localStorage.setItem(VIEW_KEY, view);
            updateSubfilterVisibility();

            // Check if current subfilter requires comment prefetch
            const viewFilters = state.viewFilters[view] || DEFAULT_VIEW_FILTERS[view];
            const stateFilter = viewFilters.state || 'all';
            const authorFilter = viewFilters.author || 'all';
            if (stateFilter === 'approved' && !state.commentPrefetchEnabled) {
                showStatus('Enable comment fetching to evaluate triage filters.', 'info');
            }
            if (authorFilter === 'committer' || authorFilter === 'external') {
                maybePrefetchReviewMetadata();
            }
            render();
        }

        // Set the subfilter for the current view
        function setSubfilter(subfilter, group = 'state') {
            if (!state.viewFilters[state.view]) {
                state.viewFilters[state.view] = {
                    ...DEFAULT_VIEW_FILTERS[state.view],
                };
            }
            const current = state.viewFilters[state.view][group] || 'all';
            const next = subfilter === current ? 'all' : subfilter;
            state.viewFilters[state.view][group] = next;
            localStorage.setItem(VIEW_FILTERS_KEY, JSON.stringify(state.viewFilters));

            if (group === 'state' && next === 'approved' && !state.commentPrefetchEnabled) {
                showStatus('Enable comment fetching to evaluate triage filters.', 'info');
            }
            if (group === 'author' && (next === 'committer' || next === 'external')) {
                maybePrefetchReviewMetadata();
            }
            render();
        }

        // Show/hide appropriate subfilter tabs based on current view
        function updateSubfilterVisibility() {
            document.querySelectorAll('.subfilter-tabs').forEach(tabs => {
                const isVisible = tabs.dataset.forView === state.view;
                tabs.classList.toggle('hidden', !isVisible);
            });
        }

        function isMyPr(notification) {
            if (notification.subject.type !== 'PullRequest') {
                return false;
            }
            const reason = String(notification.reason || '').toLowerCase();
            if (reason === 'author') {
                return true;
            }
            const currentLogin = String(state.currentUserLogin || '').toLowerCase();
            if (!currentLogin) {
                return false;
            }
            const cached = state.commentCache?.threads?.[getNotificationKey(notification)];
            const cachedAuthor = String(cached?.authorLogin || '').toLowerCase();
            if (!cachedAuthor) {
                return false;
            }
            return cachedAuthor === currentLogin;
        }

        // Check if notification matches the current view
        function matchesView(notification) {
            if (state.view === 'issues') {
                return notification.subject.type === 'Issue';
            }
            if (state.view === 'my-prs') {
                return isMyPr(notification);
            }
            if (state.view === 'others-prs') {
                return notification.subject.type === 'PullRequest' &&
                    !isMyPr(notification);
            }
            return true;
        }

        // Apply the state filter for the current view
        function applyStateFilter(notifications, stateFilter) {
            if (stateFilter === 'all') {
                return notifications;
            }
            return notifications.filter(notif => {
                const notifState = notif.subject.state;
                if (stateFilter === 'open') {
                    return notifState === 'open' || notifState === 'draft';
                }
                if (stateFilter === 'closed') {
                    return notifState === 'closed' || notifState === 'merged';
                }
                if (stateFilter === 'draft') {
                    return notifState === 'draft';
                }
                if (stateFilter === 'needs-review') {
                    return safeIsNotificationNeedsReview(notif);
                }
                if (stateFilter === 'approved') {
                    return safeIsNotificationApproved(notif);
                }
                return true;
            });
        }

        function applyAuthorFilter(notifications, authorFilter) {
            if (authorFilter === 'all') {
                return notifications;
            }
            return notifications.filter(notif => {
                if (authorFilter === 'committer') {
                    return safeIsNotificationFromCommitter(notif);
                }
                if (authorFilter === 'external') {
                    return safeIsNotificationFromExternal(notif);
                }
                return true;
            });
        }

        function safeIsNotificationNeedsReview(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            const notifState = notification.subject?.state;
            if (notifState === 'draft' || notifState === 'closed' || notifState === 'merged') {
                return false;
            }
            if (safeIsNotificationApproved(notification)) {
                return false;
            }
            return true;
        }

        function safeIsNotificationApproved(notification) {
            return typeof isNotificationApproved === 'function'
                ? isNotificationApproved(notification)
                : false;
        }

        function safeIsNotificationFromCommitter(notification) {
            return typeof isNotificationFromCommitter === 'function'
                ? isNotificationFromCommitter(notification)
                : false;
        }

        function safeHasNotificationAuthorAssociation(notification) {
            return typeof hasNotificationAuthorAssociation === 'function'
                ? hasNotificationAuthorAssociation(notification)
                : false;
        }

        function safeIsNotificationFromExternal(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            if (!safeHasNotificationAuthorAssociation(notification)) {
                return false;
            }
            return !safeIsNotificationFromCommitter(notification);
        }

        function maybePrefetchReviewMetadata() {
            if (typeof scheduleReviewDecisionPrefetch === 'function') {
                scheduleReviewDecisionPrefetch(state.notifications);
            }
        }

        function getNotificationSize(notification) {
            if (typeof getDiffstatInfo !== 'function') {
                return null;
            }
            const info = getDiffstatInfo(notification);
            return info ? info.total : null;
        }

        // Get filtered notifications based on current view and subfilter
        function getFilteredNotifications() {
            // Step 1: Filter by view (primary category)
            let filtered = state.notifications.filter(matchesView);

            // Step 2: Apply view-specific state filter
            const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
            filtered = applyStateFilter(filtered, viewFilters.state || 'all');

            if (state.view === 'others-prs') {
                filtered = applyAuthorFilter(filtered, viewFilters.author || 'all');
            }

            if (state.orderBy === 'size' && state.view !== 'issues') {
                const withIndex = filtered.map((notif, index) => ({
                    notif,
                    index,
                    size: getNotificationSize(notif),
                }));
                withIndex.sort((a, b) => {
                    const aSize = a.size;
                    const bSize = b.size;
                    if (aSize === null && bSize === null) {
                        return a.index - b.index;
                    }
                    if (aSize === null) {
                        return 1;
                    }
                    if (bSize === null) {
                        return -1;
                    }
                    if (aSize === bSize) {
                        return a.index - b.index;
                    }
                    return aSize - bSize;
                });
                return withIndex.map(entry => entry.notif);
            }

            return filtered;
        }

        // Count notifications for each view
        function getViewCounts() {
            let issues = 0;
            let myPrs = 0;
            let othersPrs = 0;

            state.notifications.forEach(notif => {
                if (notif.subject.type === 'Issue') {
                    issues++;
                } else if (notif.subject.type === 'PullRequest') {
                    if (isMyPr(notif)) {
                        myPrs++;
                    } else {
                        othersPrs++;
                    }
                }
            });

            return { issues, myPrs, othersPrs };
        }

        // Count notifications by subfilter for the current view
        function getSubfilterCounts() {
            const viewNotifications = state.notifications.filter(matchesView);
            const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
            const stateFilter = viewFilters.state || 'all';
            const authorFilter = viewFilters.author || 'all';

            const stateCounts = {
                all: 0,
                open: 0,
                closed: 0,
                draft: 0,
                needsReview: 0,
                approved: 0,
            };
            const authorCounts = {
                all: 0,
                committer: 0,
                external: 0,
            };

            const baseForStateCounts =
                state.view === 'others-prs'
                    ? applyAuthorFilter(viewNotifications, authorFilter)
                    : viewNotifications;
            const baseForAuthorCounts =
                state.view === 'others-prs'
                    ? applyStateFilter(viewNotifications, stateFilter)
                    : [];

            stateCounts.all = baseForStateCounts.length;
            baseForStateCounts.forEach(notif => {
                const notifState = notif.subject.state;
                if (notifState === 'open' || notifState === 'draft') {
                    stateCounts.open++;
                } else if (notifState === 'closed' || notifState === 'merged') {
                    stateCounts.closed++;
                }
                if (notifState === 'draft') {
                    stateCounts.draft++;
                }
                if (safeIsNotificationNeedsReview(notif)) {
                    stateCounts.needsReview++;
                }
                if (safeIsNotificationApproved(notif)) {
                    stateCounts.approved++;
                }
            });

            if (state.view === 'others-prs') {
                authorCounts.all = baseForAuthorCounts.length;
                baseForAuthorCounts.forEach(notif => {
                    if (safeIsNotificationFromCommitter(notif)) {
                        authorCounts.committer++;
                    }
                    if (safeIsNotificationFromExternal(notif)) {
                        authorCounts.external++;
                    }
                });
            }

            return { state: stateCounts, author: authorCounts };
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
            clearCommentCacheStorage().catch((error) => {
                console.error('Failed to clear comment cache:', error);
            });
            localStorage.removeItem(COMMENT_CACHE_KEY);
            if (state.commentPrefetchEnabled && state.notifications.length > 0) {
                scheduleCommentPrefetch(state.notifications);
                showStatus('Comment cache cleared. Refetching comments...', 'info');
            } else {
                showStatus('Comment cache cleared.', 'success');
            }
            render();
        }

        // Comment prefetching, classification, and display functions are in notifications-comments.js:
        // scheduleCommentPrefetch, runCommentQueue, toIssueComment, fetchAllIssueComments,
        // fetchPullRequestReviews, prefetchNotificationComments, getCommentStatus, getCommentItems,
        // filterCommentsAfterOwnComment, isNotificationUninteresting, isNotificationNeedsReview,
        // isNotificationApproved, isUninterestingComment, isRevertRelated,
        // isBotAuthor, isBotInteractionComment
