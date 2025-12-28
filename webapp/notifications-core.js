// Comment-related constants are in notifications-comments.js
        const LAST_SYNCED_REPO_KEY = 'ghnotif_last_synced_repo';
        const VIEW_KEY = 'ghnotif_view';
        const VIEW_FILTERS_KEY = 'ghnotif_view_filters';

        // Default view filters for each view
        const DEFAULT_VIEW_FILTERS = {
            'issues': 'all',           // 'all' | 'open' | 'closed'
            'my-prs': 'all',           // 'all' (minimal for now)
            'others-prs': 'all'        // 'all' | 'needs-review' | 'approved' | 'closed'
        };

        // Application state
        const state = {
            repo: null,
            notifications: [],
            loading: false,
            error: null,
            view: 'issues', // 'issues', 'my-prs', 'others-prs'
            viewFilters: { ...DEFAULT_VIEW_FILTERS },
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
            unsubscribeAllBtn: document.getElementById('unsubscribe-all-btn'),
            progressContainer: document.getElementById('progress-container'),
            progressBarFill: document.getElementById('progress-bar-fill'),
            progressText: document.getElementById('progress-text'),
            keyboardShortcutsOverlay: document.getElementById('keyboard-shortcuts-overlay'),
            keyboardShortcutsClose: document.getElementById('keyboard-shortcuts-close'),
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

            // Load saved view from localStorage
            const savedView = localStorage.getItem(VIEW_KEY);
            if (savedView && ['issues', 'my-prs', 'others-prs'].includes(savedView)) {
                state.view = savedView;
            }

            // Load saved view filters from localStorage
            const savedViewFilters = localStorage.getItem(VIEW_FILTERS_KEY);
            if (savedViewFilters) {
                try {
                    const parsed = JSON.parse(savedViewFilters);
                    // Merge with defaults to handle any missing keys
                    state.viewFilters = { ...DEFAULT_VIEW_FILTERS, ...parsed };
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
                    setSubfilter(subfilter);
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
            const subfilter = state.viewFilters[view];
            if (['needs-review', 'approved'].includes(subfilter) && !state.commentPrefetchEnabled) {
                showStatus('Enable comment fetching to evaluate triage filters.', 'info');
            }
            render();
        }

        // Set the subfilter for the current view
        function setSubfilter(subfilter) {
            state.viewFilters[state.view] = subfilter;
            localStorage.setItem(VIEW_FILTERS_KEY, JSON.stringify(state.viewFilters));

            if (['needs-review', 'approved'].includes(subfilter) && !state.commentPrefetchEnabled) {
                showStatus('Enable comment fetching to evaluate triage filters.', 'info');
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

        // Check if notification matches the current view
        function matchesView(notification) {
            if (state.view === 'issues') {
                return notification.subject.type === 'Issue';
            }
            if (state.view === 'my-prs') {
                return notification.subject.type === 'PullRequest' &&
                    notification.actors?.[0]?.login === state.currentUserLogin;
            }
            if (state.view === 'others-prs') {
                return notification.subject.type === 'PullRequest' &&
                    notification.actors?.[0]?.login !== state.currentUserLogin;
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
                if (stateFilter === 'needs-review') {
                    return safeIsNotificationNeedsReview(notif);
                }
                if (stateFilter === 'approved') {
                    return safeIsNotificationApproved(notif);
                }
                return true;
            });
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

        // Get filtered notifications based on current view and subfilter
        function getFilteredNotifications() {
            // Step 1: Filter by view (primary category)
            let filtered = state.notifications.filter(matchesView);

            // Step 2: Apply view-specific state filter
            const stateFilter = state.viewFilters[state.view];
            filtered = applyStateFilter(filtered, stateFilter);

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
                    if (notif.actors?.[0]?.login === state.currentUserLogin) {
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
            let all = viewNotifications.length;
            let open = 0;
            let closed = 0;
            let needsReview = 0;
            let approved = 0;

            viewNotifications.forEach(notif => {
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
            });

            return { all, open, closed, needsReview, approved };
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

        // Comment prefetching, classification, and display functions are in notifications-comments.js:
        // scheduleCommentPrefetch, runCommentQueue, toIssueComment, fetchAllIssueComments,
        // fetchPullRequestReviews, prefetchNotificationComments, getCommentStatus, getCommentItems,
        // filterCommentsAfterOwnComment, isNotificationUninteresting, isNotificationNeedsReview,
        // isNotificationApproved, hasApprovedReview, isUninterestingComment, isRevertRelated,
        // isBotAuthor, isBotInteractionComment
