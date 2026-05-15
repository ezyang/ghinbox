// Comment-related constants are in notifications-comments.js
        const LAST_SYNCED_REPO_KEY = 'ghnotif_last_synced_repo';
        const VIEW_KEY = 'ghnotif_view';
        const VIEW_FILTERS_KEY = 'ghnotif_view_filters';
        const AUTH_TOKEN_KEY = 'ghnotif_authenticity_token';
        const ORDER_KEY = 'ghnotif_order';
        const ORDER_BY_VIEW_KEY = 'ghnotif_order_by_view';
        const AUTO_MARK_TRASH_KEY = 'ghnotif_auto_mark_trash_done';
        const {
            DEFAULT_VIEW_FILTERS,
            DEFAULT_VIEW_ORDERS,
            VALID_ORDERS,
            cloneDefaultViewFilters,
            normalizeViewFilters,
            normalizeViewOrders,
        } = GhinboxFiltering;
        const RATE_LIMIT_LOG_MAX = 300;

        // Application state
        const state = {
            repo: null,
            notifications: [],
            trashNotifications: [],
            loading: false,
            error: null,
            statusState: null,
            statusTimer: null,
            statusFlashId: 0,
            statusAutoDismissTimer: null,
            statusAutoDismissId: 0,
            lastPersistentStatus: null,
            view: 'issues', // issues=Feed, pr-notifications=Replies, others-prs=Reviews
            viewFilters: cloneDefaultViewFilters(),
            viewOrders: { ...DEFAULT_VIEW_ORDERS },
            orderBy: 'recent',
            selected: new Set(), // Set of selected notification IDs
            activeNotificationId: null, // Keyboard selection cursor
            lastClickedId: null, // For shift-click range selection
            unsubscribeInProgress: false, // Whether Unsubscribe All is in progress
            commentExpandIssues: true,
            commentExpandPrs: true,
            commentHideUninteresting: true,
            autoMarkTrashDone: false,
            commentAgeFilter: 'all', // 'all' | '1day' | '3days' | '1week' | '1month'
            commentQueue: [],
            commentQueueKeys: new Set(),
            commentQueueRunning: false,
            commentPrefetchProgress: {
                active: false,
                total: 0,
                completed: 0,
                failed: 0,
                inFlight: 0,
                concurrency: 0,
            },
            commentPrefetchStatusMessage: null,
            commentPrefetchStatusTimer: null,
            commentPrefetchStatusLastUpdate: 0,
            commentPrefetchIdleTimer: null,
            commentPrefetchStatusActive: false,
            commentCache: { version: 1, threads: {} },
            rateLimit: null,
            rateLimitError: null,
            graphqlRateLimit: null,
            graphqlRateLimitError: null,
            rateLimitLog: [],
            rateLimitLogResetAt: null,
            rateLimitLogNextId: 1,
            rateLimitLogRefreshStart: null,
            actionContext: null,
            actionCounter: 0,
            currentUserLogin: null,
            commentBodyExpanded: new Set(),
            lastSyncedRepo: null,
            // Keyboard navigation
            lastGKeyTime: 0, // For vim-style 'gg' sequence
            scrollLock: null,
            // Undo support
            authenticity_token: null, // CSRF token for HTML form actions
            undoStack: [], // Stack of {action, notifications, timestamp}
            undoInProgress: false,
            // Mobile UI state
            mobileSelectMode: false,
        };

        // DOM elements
        const elements = {
            repoInput: document.getElementById('repo-input'),
            syncBtn: document.getElementById('sync-btn'),
            fullSyncBtn: document.getElementById('full-sync-btn'),
            authStatus: document.getElementById('auth-status'),
            orderSelect: document.getElementById('order-select'),
            statusBar: document.getElementById('status-bar'),
            commentExpandIssuesToggle: document.getElementById('comment-expand-issues-toggle'),
            commentExpandPrsToggle: document.getElementById('comment-expand-prs-toggle'),
            commentHideUninterestingToggle: document.getElementById('comment-hide-uninteresting-toggle'),
            autoMarkTrashToggle: document.getElementById('auto-clean-low-priority-toggle'),
            manualTrashBtn: document.getElementById('clean-now-btn'),
            commentAgeFilterSelect: document.getElementById('comment-age-filter-select'),
            commentCacheStatus: document.getElementById('comment-cache-status'),
            clearCommentCacheBtn: document.getElementById('clear-comment-cache-btn'),
            rateLimitBox: document.getElementById('rate-limit-box'),
            rateLimitSummary: document.getElementById('rate-limit-summary'),
            rateLimitExplainBtn: document.getElementById('rate-limit-explain-btn'),
            rateLimitDetails: document.getElementById('rate-limit-details'),
            rateLimitLogStatus: document.getElementById('rate-limit-log-status'),
            rateLimitLog: document.getElementById('rate-limit-log'),
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
            markDoneBtnBottom: document.getElementById('mark-done-btn-bottom'),
            bottomActionsRow: document.getElementById('bottom-actions-row'),
            openUnreadBtn: document.getElementById('open-unread-btn'),
            unsubscribeAllBtn: document.getElementById('unsubscribe-all-btn'),
            progressContainer: document.getElementById('progress-container'),
            progressBarFill: document.getElementById('progress-bar-fill'),
            progressText: document.getElementById('progress-text'),
            keyboardShortcutsOverlay: document.getElementById('keyboard-shortcuts-overlay'),
            keyboardShortcutsClose: document.getElementById('keyboard-shortcuts-close'),
            // Mobile elements
            mobileFilterSelect: document.getElementById('mobile-filter-select'),
            mobileAuthorSelect: document.getElementById('mobile-author-select'),
            mobileOrderSelect: document.getElementById('mobile-order-select'),
            mobileSelectBtn: document.getElementById('mobile-select-btn'),
            notificationsContainer: document.querySelector('.notifications-container'),
        };

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

        function getActionLabel() {
            return state.actionContext?.label || 'Background';
        }

        function withActionContext(label, fn) {
            const previous = state.actionContext;
            const nextId = state.actionCounter + 1;
            state.actionCounter = nextId;
            state.actionContext = {
                id: nextId,
                label,
                startedAt: new Date().toISOString(),
            };
            let result;
            try {
                result = fn();
            } catch (error) {
                state.actionContext = previous;
                throw error;
            }
            if (result && typeof result.then === 'function') {
                return result.finally(() => {
                    state.actionContext = previous;
                });
            }
            state.actionContext = previous;
            return result;
        }

        function shouldLogRateLimitRequest(url) {
            if (!url) {
                return false;
            }
            return (
                url.startsWith('/github/') ||
                url.startsWith('/notifications/html')
            );
        }

        function extractGraphqlSummary(body) {
            if (typeof body !== 'string') {
                return null;
            }
            let payload;
            try {
                payload = JSON.parse(body);
            } catch (error) {
                return null;
            }
            const query = typeof payload?.query === 'string' ? payload.query : '';
            const variables = payload?.variables && typeof payload.variables === 'object'
                ? Object.keys(payload.variables)
                : [];
            const compact = query.replace(/\s+/g, ' ').trim();
            if (!compact) {
                return null;
            }
            const opMatch = compact.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
            const operation = opMatch
                ? `${opMatch[1]} ${opMatch[2]}`
                : compact.startsWith('query')
                    ? 'query'
                    : compact.startsWith('mutation')
                        ? 'mutation'
                        : null;
            const rootMatch = compact.match(/\{\s*([A-Za-z0-9_]+)/);
            const rootField = rootMatch ? rootMatch[1] : null;
            const parts = [];
            if (operation) {
                parts.push(operation);
            }
            if (rootField) {
                parts.push(`root=${rootField}`);
            }
            if (variables.length) {
                parts.push(`vars=${variables.join(',')}`);
            }
            if (!parts.length) {
                parts.push(compact.slice(0, 80));
            }
            return parts.join(' ');
        }

        function updateRateLimitLogStatus() {
            if (!elements.rateLimitLogStatus) {
                return;
            }
            const count = state.rateLimitLog.length;
            if (count === 0) {
                elements.rateLimitLogStatus.textContent =
                    'No rate limit requests logged yet.';
                return;
            }
            const resetAt = state.rateLimitLogResetAt
                ? new Date(state.rateLimitLogResetAt * 1000).toLocaleTimeString()
                : 'unknown';
            elements.rateLimitLogStatus.textContent =
                `Logged ${count} request${count === 1 ? '' : 's'} until core resets @ ${resetAt}.`;
        }

        function renderRateLimitLogs() {
            if (!elements.rateLimitLog) {
                return;
            }
            elements.rateLimitLog.textContent = '';
            updateRateLimitLogStatus();
            const entries = state.rateLimitLog.slice().reverse();
            entries.forEach((entry) => {
                const item = document.createElement('li');
                item.className = 'rate-limit-log-item';

                const title = document.createElement('strong');
                title.textContent = `${entry.timeLabel} | ${entry.action}`;
                item.appendChild(title);

                const requestLine = document.createElement('div');
                requestLine.textContent = `${entry.method} ${entry.url} (${entry.kind})`;
                item.appendChild(requestLine);

                const metaLine = document.createElement('div');
                const metaParts = [];
                if (entry.status) {
                    metaParts.push(`status ${entry.status}`);
                }
                if (Number.isFinite(entry.durationMs)) {
                    metaParts.push(`${entry.durationMs}ms`);
                }
                if (entry.detail) {
                    metaParts.push(entry.detail);
                }
                metaLine.textContent = metaParts.join(' | ');
                item.appendChild(metaLine);

                elements.rateLimitLog.appendChild(item);
            });
        }

        function clearRateLimitLogs({ preserveLatest = false, preserveSince = null } = {}) {
            let preserved = [];
            if (Number.isFinite(preserveSince)) {
                preserved = state.rateLimitLog.filter(
                    (entry) => entry.timestamp >= preserveSince
                );
            } else if (preserveLatest) {
                const latest = state.rateLimitLog[state.rateLimitLog.length - 1];
                preserved = latest ? [latest] : [];
            }
            state.rateLimitLog = preserved;
            updateRateLimitLogStatus();
            if (elements.rateLimitDetails && !elements.rateLimitDetails.hidden) {
                renderRateLimitLogs();
            }
        }

        function recordRateLimitLog(entry) {
            state.rateLimitLog.push(entry);
            if (state.rateLimitLog.length > RATE_LIMIT_LOG_MAX) {
                state.rateLimitLog.splice(0, state.rateLimitLog.length - RATE_LIMIT_LOG_MAX);
            }
            updateRateLimitLogStatus();
            if (elements.rateLimitDetails && !elements.rateLimitDetails.hidden) {
                renderRateLimitLogs();
            }
        }

        function instrumentFetchForRateLimit() {
            if (!window.fetch || window.fetch.__ghinboxRateLimitWrapped) {
                return;
            }
            const originalFetch = window.fetch.bind(window);
            const wrappedFetch = async (input, init = {}) => {
                const url = typeof input === 'string' ? input : input?.url || '';
                const method =
                    init.method ||
                    (typeof input === 'object' && input?.method) ||
                    'GET';
                if (!shouldLogRateLimitRequest(url)) {
                    return originalFetch(input, init);
                }
                const startedAt = Date.now();
                let response;
                try {
                    response = await originalFetch(input, init);
                } catch (error) {
                    const detail = error?.message ? String(error.message) : 'fetch failed';
                    recordRateLimitLog({
                        id: state.rateLimitLogNextId++,
                        timeLabel: new Date(startedAt).toLocaleTimeString(),
                        timestamp: startedAt,
                        action: getActionLabel(),
                        method: String(method || 'GET').toUpperCase(),
                        url,
                        kind: url.includes('/github/graphql')
                            ? 'GraphQL'
                            : url.startsWith('/notifications/html')
                                ? 'App'
                                : 'REST',
                        status: 'error',
                        durationMs: Date.now() - startedAt,
                        detail,
                    });
                    throw error;
                }
                const durationMs = Date.now() - startedAt;
                const isGraphql = url.includes('/github/graphql');
                const kind = isGraphql
                    ? 'GraphQL'
                    : url.startsWith('/notifications/html')
                        ? 'App'
                        : 'REST';
                const body = init?.body;
                const graphqlSummary = isGraphql ? extractGraphqlSummary(body) : null;
                recordRateLimitLog({
                    id: state.rateLimitLogNextId++,
                    timeLabel: new Date(startedAt).toLocaleTimeString(),
                    timestamp: startedAt,
                    action: getActionLabel(),
                    method: String(method || 'GET').toUpperCase(),
                    url,
                    kind,
                    status: response.status,
                    durationMs,
                    detail: graphqlSummary,
                });
                return response;
            };
            wrappedFetch.__ghinboxRateLimitWrapped = true;
            window.fetch = wrappedFetch;
        }

        function toggleRateLimitDetails() {
            if (!elements.rateLimitDetails || !elements.rateLimitExplainBtn) {
                return;
            }
            const nextHidden = !elements.rateLimitDetails.hidden;
            elements.rateLimitDetails.hidden = nextHidden;
            elements.rateLimitExplainBtn.setAttribute(
                'aria-expanded',
                String(!nextHidden)
            );
            if (!nextHidden) {
                renderRateLimitLogs();
            }
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

        async function loadInitialNotifications() {
            if (typeof loadServerSnapshotOnInit === 'function') {
                try {
                    const loadedFromServer = await loadServerSnapshotOnInit({
                        forceApply: true,
                    });
                    if (loadedFromServer) {
                        return;
                    }
                } catch (error) {
                    console.error('Failed to load server snapshot:', error);
                }
            }
            state.notifications = await loadNotificationsFromCache();
        }

        // Initialize app
        async function init() {
            instrumentFetchForRateLimit();

            // Load saved repo from localStorage, defaulting to pytorch/pytorch
            const savedRepo = localStorage.getItem('ghnotif_repo');
            const repoValue = savedRepo || 'pytorch/pytorch';
            elements.repoInput.value = repoValue;
            state.repo = repoValue;

            try {
                state.commentCache = await loadCommentCache();
            } catch (error) {
                console.error('Failed to load comment cache:', error);
            }
            // Prefer the current server-owned snapshot; fall back to the local cache offline.
            // Comment cache must be available first so startup snapshot hydration can skip
            // fresh threads instead of immediately refetching them.
            await loadInitialNotifications();
            state.lastSyncedRepo = localStorage.getItem(LAST_SYNCED_REPO_KEY);
            const savedAuthToken = localStorage.getItem(AUTH_TOKEN_KEY);
            if (savedAuthToken) {
                state.authenticity_token = savedAuthToken;
            }

            // Load saved view from localStorage
            const savedView = localStorage.getItem(VIEW_KEY);
            if (
                savedView &&
                ['issues', 'my-prs', 'pr-notifications', 'others-prs', 'trash', 'cleaned'].includes(savedView)
            ) {
                state.view = savedView === 'trash' ? 'cleaned' : savedView;
            }

            const savedViewOrders = localStorage.getItem(ORDER_BY_VIEW_KEY);
            if (savedViewOrders) {
                try {
                    const parsed = JSON.parse(savedViewOrders);
                    state.viewOrders = normalizeViewOrders(parsed);
                } catch (e) {
                    console.error('Failed to parse saved view orders:', e);
                }
            } else {
                const savedOrder = localStorage.getItem(ORDER_KEY);
                if (savedOrder && VALID_ORDERS.has(savedOrder)) {
                    state.viewOrders = {
                        'issues': savedOrder,
                        'my-prs': savedOrder,
                        'pr-notifications': savedOrder,
                        'others-prs': savedOrder,
                        'cleaned': savedOrder,
                    };
                }
            }
            state.orderBy = state.viewOrders[state.view] || DEFAULT_VIEW_ORDERS[state.view];
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

            const savedCommentExpandIssues = localStorage.getItem(COMMENT_EXPAND_ISSUES_KEY);
            if (savedCommentExpandIssues === 'false') {
                state.commentExpandIssues = false;
            }
            elements.commentExpandIssuesToggle.checked = state.commentExpandIssues;

            const savedCommentExpandPrs = localStorage.getItem(COMMENT_EXPAND_PRS_KEY);
            if (savedCommentExpandPrs === 'false') {
                state.commentExpandPrs = false;
            }
            elements.commentExpandPrsToggle.checked = state.commentExpandPrs;

            const savedCommentHideUninteresting = localStorage.getItem(COMMENT_HIDE_UNINTERESTING_KEY);
            if (savedCommentHideUninteresting === 'false') {
                state.commentHideUninteresting = false;
            }
            elements.commentHideUninterestingToggle.checked = state.commentHideUninteresting;

            const savedAutoMarkTrash = localStorage.getItem(AUTO_MARK_TRASH_KEY);
            state.autoMarkTrashDone = savedAutoMarkTrash === 'true';
            elements.autoMarkTrashToggle.checked = state.autoMarkTrashDone;

            const savedCommentAgeFilter = localStorage.getItem(COMMENT_AGE_FILTER_KEY);
            if (savedCommentAgeFilter && ['all', '1day', '3days', '1week', '1month'].includes(savedCommentAgeFilter)) {
                state.commentAgeFilter = savedCommentAgeFilter;
            }
            elements.commentAgeFilterSelect.value = state.commentAgeFilter;

            // Set up event listeners
            elements.syncBtn.addEventListener('click', () => {
                withActionContext('Quick Sync', () => handleSync({ mode: 'incremental' }));
            });
            elements.fullSyncBtn.addEventListener('click', () => {
                withActionContext('Full Sync', handleServerFullSync);
            });
            elements.repoInput.addEventListener('input', handleRepoInput);
            elements.repoInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    withActionContext('Quick Sync', () => handleSync({ mode: 'incremental' }));
                }
            });
            if (elements.orderSelect) {
                elements.orderSelect.addEventListener('change', (event) => {
                    const nextOrder = event.target.value;
                    if (!VALID_ORDERS.has(nextOrder)) {
                        return;
                    }
                    state.orderBy = nextOrder;
                    state.viewOrders[state.view] = nextOrder;
                    localStorage.setItem(ORDER_BY_VIEW_KEY, JSON.stringify(state.viewOrders));
                    if (nextOrder === 'size' && state.view !== 'issues') {
                        maybePrefetchReviewMetadata();
                    }
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

            elements.commentExpandIssuesToggle.addEventListener('change', (event) => {
                setCommentExpandIssues(event.target.checked);
            });
            elements.commentExpandPrsToggle.addEventListener('change', (event) => {
                setCommentExpandPrs(event.target.checked);
            });
            elements.commentHideUninterestingToggle.addEventListener('change', (event) => {
                setCommentHideUninteresting(event.target.checked);
            });
            elements.autoMarkTrashToggle.addEventListener('change', (event) => {
                setAutoMarkTrashDone(event.target.checked);
            });
            elements.manualTrashBtn.addEventListener('click', () => {
                withActionContext('Clean now', handleManualTrash);
            });
            elements.commentAgeFilterSelect.addEventListener('change', (event) => {
                setCommentAgeFilter(event.target.value);
            });
            elements.clearCommentCacheBtn.addEventListener('click', () => {
                withActionContext('Clear comment cache', handleClearCommentCache);
            });

            // Select all checkbox handler
            elements.selectAllCheckbox.addEventListener('change', handleSelectAll);

            // Mark Done button handler
            elements.markDoneBtn.addEventListener('click', () => {
                withActionContext('Mark done (bulk)', handleMarkDone);
            });

            // Mark Done (bottom) button handler
            if (elements.markDoneBtnBottom) {
                elements.markDoneBtnBottom.addEventListener('click', () => {
                    withActionContext('Mark done (bulk)', handleMarkDone);
                });
            }

            // Open All button handler
            elements.openUnreadBtn.addEventListener('click', () => {
                withActionContext('Open unread', handleOpenAllFiltered);
            });

            // Unsubscribe All button handler
            elements.unsubscribeAllBtn.addEventListener('click', () => {
                withActionContext('Unsubscribe all', handleUnsubscribeAll);
            });

            if (elements.rateLimitExplainBtn) {
                elements.rateLimitExplainBtn.addEventListener('click', toggleRateLimitDetails);
            }

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

            // Mobile controls
            if (elements.mobileSelectBtn) {
                elements.mobileSelectBtn.addEventListener('click', toggleMobileSelectMode);
            }
            if (elements.mobileFilterSelect) {
                elements.mobileFilterSelect.addEventListener('change', handleMobileFilterChange);
            }
            if (elements.mobileOrderSelect) {
                elements.mobileOrderSelect.addEventListener('change', handleMobileOrderChange);
            }
            if (elements.mobileAuthorSelect) {
                elements.mobileAuthorSelect.addEventListener('change', handleMobileAuthorChange);
            }

            // Check auth status (uses cached value if available)
            checkAuth();
            // Only refresh REST rate limit on init (it's free); skip GraphQL to save rate limit
            refreshRateLimit({ skipGraphql: true });

            // Set initial data-view attribute on container for CSS targeting
            if (elements.notificationsContainer) {
                elements.notificationsContainer.dataset.view = state.view;
            }

            // Initial render
            render();
        }

        // Handle repo input changes
        function handleRepoInput() {
            const value = elements.repoInput.value.trim();
            state.repo = value || null;
            localStorage.setItem('ghnotif_repo', value);
        }

        function setCommentExpandIssues(enabled) {
            state.commentExpandIssues = enabled;
            localStorage.setItem(COMMENT_EXPAND_ISSUES_KEY, String(enabled));
            render();
        }

        function setCommentExpandPrs(enabled) {
            state.commentExpandPrs = enabled;
            localStorage.setItem(COMMENT_EXPAND_PRS_KEY, String(enabled));
            render();
        }

        function setCommentHideUninteresting(enabled) {
            state.commentHideUninteresting = enabled;
            localStorage.setItem(COMMENT_HIDE_UNINTERESTING_KEY, String(enabled));
            render();
        }

        function setAutoMarkTrashDone(enabled) {
            state.autoMarkTrashDone = enabled;
            localStorage.setItem(AUTO_MARK_TRASH_KEY, String(enabled));
        }

        function setCommentAgeFilter(ageFilter) {
            state.commentAgeFilter = ageFilter;
            localStorage.setItem(COMMENT_AGE_FILTER_KEY, ageFilter);
            render();
        }

        // Set the current view
        function setView(view) {
            if (!['issues', 'my-prs', 'pr-notifications', 'others-prs', 'cleaned'].includes(view)) {
                return;
            }
            state.view = view;
            localStorage.setItem(VIEW_KEY, view);
            // Set data-view attribute on container for CSS targeting
            if (elements.notificationsContainer) {
                elements.notificationsContainer.dataset.view = view;
            }
            updateSubfilterVisibility();
            state.orderBy = state.viewOrders[view] || DEFAULT_VIEW_ORDERS[view];
            if (elements.orderSelect) {
                elements.orderSelect.value = state.orderBy;
            }

            const viewFilters = state.viewFilters[view] || DEFAULT_VIEW_FILTERS[view];
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

            render();
        }

        // Show/hide appropriate subfilter tabs based on current view
        function updateSubfilterVisibility() {
            document.querySelectorAll('.subfilter-tabs').forEach(tabs => {
                const isVisible = tabs.dataset.forView === state.view;
                tabs.classList.toggle('hidden', !isVisible);
            });
            updateMobileFilterOptions();
        }

        // Mobile control handlers
        function toggleMobileSelectMode() {
            state.mobileSelectMode = !state.mobileSelectMode;
            if (elements.notificationsContainer) {
                elements.notificationsContainer.classList.toggle('select-mode', state.mobileSelectMode);
            }
            if (elements.mobileSelectBtn) {
                elements.mobileSelectBtn.textContent = state.mobileSelectMode ? 'Done' : 'Select';
            }
            if (!state.mobileSelectMode) {
                // Clear selection when exiting select mode
                state.selected.clear();
                render();
            }
        }

        function getMobileFilterOptions() {
            return GhinboxFiltering.getMobileFilterOptions(state.view);
        }

        function updateMobileFilterOptions() {
            if (!elements.mobileFilterSelect) {
                return;
            }
            const options = getMobileFilterOptions();
            elements.mobileFilterSelect.innerHTML = '';
            options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.label;
                elements.mobileFilterSelect.appendChild(option);
            });
            // Set current value
            const viewFilters = state.viewFilters[state.view] || DEFAULT_VIEW_FILTERS[state.view];
            const currentFilter = viewFilters.state || 'all';
            elements.mobileFilterSelect.value = currentFilter;

            // Sync order select
            if (elements.mobileOrderSelect) {
                elements.mobileOrderSelect.value = state.orderBy;
            }

            // Sync secondary select (author for Reviews; hidden/default elsewhere)
            if (elements.mobileAuthorSelect) {
                elements.mobileAuthorSelect.innerHTML = '';
                const secondaryOptions = state.view === 'others-prs'
                    ? [
                        { value: 'all', label: 'All authors' },
                        { value: 'committer', label: 'Committers' },
                        { value: 'external', label: 'External' },
                    ]
                    : [
                        { value: 'all', label: 'All' },
                    ];
                secondaryOptions.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.label;
                    elements.mobileAuthorSelect.appendChild(option);
                });
                const currentSecondary = state.view === 'others-prs'
                    ? (viewFilters.author || 'all')
                    : 'all';
                elements.mobileAuthorSelect.value = currentSecondary;
            }
        }

        function handleMobileFilterChange(event) {
            const value = event.target.value;
            if (!state.viewFilters[state.view]) {
                state.viewFilters[state.view] = {
                    ...DEFAULT_VIEW_FILTERS[state.view],
                };
            }
            state.viewFilters[state.view].state = value;
            localStorage.setItem(VIEW_FILTERS_KEY, JSON.stringify(state.viewFilters));
            render();
        }

        function handleMobileOrderChange(event) {
            const nextOrder = event.target.value;
            if (!VALID_ORDERS.has(nextOrder)) {
                return;
            }
            state.orderBy = nextOrder;
            state.viewOrders[state.view] = nextOrder;
            localStorage.setItem(ORDER_BY_VIEW_KEY, JSON.stringify(state.viewOrders));
            if (elements.orderSelect) {
                elements.orderSelect.value = nextOrder;
            }
            if (nextOrder === 'size' && state.view !== 'issues') {
                maybePrefetchReviewMetadata();
            }
            render();
        }

        function handleMobileAuthorChange(event) {
            const value = event.target.value;
            if (!state.viewFilters[state.view]) {
                state.viewFilters[state.view] = {
                    ...DEFAULT_VIEW_FILTERS[state.view],
                };
            }
            const group = state.view === 'others-prs' ? 'author' : 'audience';
            state.viewFilters[state.view][group] = value;
            localStorage.setItem(VIEW_FILTERS_KEY, JSON.stringify(state.viewFilters));
            render();
        }

        function makeNotificationClassifier() {
            return GhinboxFiltering.makeClassifier({
                currentUserLogin: state.currentUserLogin,
                commentCache: state.commentCache,
                deps: {
                    notificationKey: getNotificationKey,
                    isNotificationForCurrentUser: typeof isNotificationForCurrentUser === 'function'
                        ? isNotificationForCurrentUser
                        : undefined,
                    isNotificationDirectedAtCurrentUser: typeof isNotificationDirectedAtCurrentUser === 'function'
                        ? isNotificationDirectedAtCurrentUser
                        : undefined,
                    isNotificationReviewResponsibility: typeof isNotificationReviewResponsibility === 'function'
                        ? isNotificationReviewResponsibility
                        : undefined,
                    isNotificationApproved: typeof isNotificationApproved === 'function'
                        ? isNotificationApproved
                        : undefined,
                    isNotificationChangesRequested: typeof isNotificationChangesRequested === 'function'
                        ? isNotificationChangesRequested
                        : undefined,
                    isNotificationFromCommitter: typeof isNotificationFromCommitter === 'function'
                        ? isNotificationFromCommitter
                        : undefined,
                    hasNotificationAuthorPermission: typeof hasNotificationAuthorPermission === 'function'
                        ? hasNotificationAuthorPermission
                        : undefined,
                    getUninterestingReason: typeof getUninterestingReason === 'function'
                        ? getUninterestingReason
                        : undefined,
                    getNotificationSize: getNotificationSize,
                },
            });
        }

        function getFilteringInput() {
            return {
                notifications: state.notifications,
                trashNotifications: state.trashNotifications,
                view: state.view,
                viewFilters: state.viewFilters,
                orderBy: state.orderBy,
                classifier: makeNotificationClassifier(),
            };
        }

        function isMyPr(notification) {
            return makeNotificationClassifier().isMyPr(notification);
        }

        // Check if notification matches the current view
        function matchesView(notification) {
            return makeNotificationClassifier().matchesView(notification, state.view);
        }

        // Apply the state filter for the current view
        function applyStateFilter(notifications, stateFilter) {
            return GhinboxFiltering.applyStateFilter(
                notifications,
                stateFilter,
                makeNotificationClassifier()
            );
        }

        function applyAuthorFilter(notifications, authorFilter) {
            return GhinboxFiltering.applyAuthorFilter(
                notifications,
                authorFilter,
                makeNotificationClassifier()
            );
        }

        function safeIsNotificationForCurrentUser(notification) {
            return typeof isNotificationForCurrentUser === 'function'
                ? isNotificationForCurrentUser(notification)
                : isMyPr(notification) ||
                    String(notification.reason || '').toLowerCase() === 'mention';
        }

        function safeIsNotificationDirectedAtCurrentUser(notification) {
            return typeof isNotificationDirectedAtCurrentUser === 'function'
                ? isNotificationDirectedAtCurrentUser(notification)
                : false;
        }

        function isNotificationReviewQueue(notification) {
            return makeNotificationClassifier().isNotificationReviewQueue(notification);
        }

        function isCommitNotification(notification) {
            return makeNotificationClassifier().isCommitNotification(notification);
        }

        function applyAudienceFilter(notifications, audienceFilter) {
            return GhinboxFiltering.applyAudienceFilter(
                notifications,
                audienceFilter,
                makeNotificationClassifier()
            );
        }

        function applyInterestFilter(notifications, interestFilter) {
            return GhinboxFiltering.applyInterestFilter(
                notifications,
                interestFilter,
                makeNotificationClassifier()
            );
        }

        function isTrashNotification(notification) {
            return makeNotificationClassifier().isTrashNotification(notification);
        }

        function addTrashNotifications(notifications) {
            const existingIds = new Set(
                state.trashNotifications.map(notification => notification.id)
            );
            const additions = notifications.filter(notification => !existingIds.has(notification.id));
            state.trashNotifications = state.trashNotifications.concat(additions);
        }

        async function autoMarkTrashNotificationsDone(
            notifications,
            syncLabel,
            { force = false } = {}
        ) {
            if (!state.autoMarkTrashDone && !force) {
                return notifications;
            }
            if (typeof processDoneBatch !== 'function') {
                showStatus(`${syncLabel}: low-priority cleanup unavailable`, 'error');
                return notifications;
            }

            const trashNotifications = notifications.filter(isTrashNotification);
            if (trashNotifications.length === 0) {
                if (force) {
                    showStatus(`${syncLabel}: no low-priority notifications found`, 'info', {
                        autoDismiss: true,
                    });
                }
                return notifications;
            }

            showStatus(
                `${syncLabel}: marking ${trashNotifications.length} low-priority notification${trashNotifications.length === 1 ? '' : 's'} done`,
                'info',
                { flash: true }
            );

            const trashIds = trashNotifications.map(notification => notification.id);
            const notificationLookup = new Map(
                notifications.map(notification => [notification.id, notification])
            );
            await processDoneBatch(trashIds, notificationLookup);

            const successfulIds = new Set(doneQueue.successfulIds || []);
            if (successfulIds.size === 0) {
                showStatus(
                    `${syncLabel}: failed to clean low-priority notifications`,
                    'error',
                    { flash: true }
                );
                return notifications;
            }

            const archivedNotifications = trashNotifications.filter(notification =>
                successfulIds.has(notification.id)
            );
            addTrashNotifications(archivedNotifications);
            pushToUndoStack('done', archivedNotifications);
            showStatus(
                `${syncLabel}: marked ${successfulIds.size} low-priority notification${successfulIds.size === 1 ? '' : 's'} done`,
                'success',
                { flash: true }
            );
            return notifications.filter(notification => !successfulIds.has(notification.id));
        }

        async function handleManualTrash() {
            if (state.loading) {
                return;
            }
            if (state.notifications.length === 0) {
                showStatus('Clean now: no notifications loaded', 'info', { autoDismiss: true });
                return;
            }

            state.loading = true;
            render();
            try {
                const notifications = await autoMarkTrashNotificationsDone(
                    state.notifications,
                    'Clean now',
                    { force: true }
                );
                state.notifications = notifications;
                persistNotifications();
            } finally {
                state.loading = false;
                render();
            }
        }

        function safeIsNotificationNeedsReview(notification) {
            return makeNotificationClassifier().isNotificationNeedsReview(notification);
        }

        function safeIsNotificationApproved(notification) {
            return typeof isNotificationApproved === 'function'
                ? isNotificationApproved(notification)
                : false;
        }

        function safeIsNotificationChangesRequested(notification) {
            return typeof isNotificationChangesRequested === 'function'
                ? isNotificationChangesRequested(notification)
                : false;
        }

        function safeIsNotificationReviewResponsibility(notification) {
            return typeof isNotificationReviewResponsibility === 'function'
                ? isNotificationReviewResponsibility(notification)
                : String(notification.reason || '').toLowerCase() === 'review_requested';
        }

        function isSyntheticResponsibilityNotification(notification) {
            return makeNotificationClassifier().isSyntheticResponsibilityNotification(notification);
        }

        function isNotificationOriginPullRequest(notification) {
            return makeNotificationClassifier().isNotificationOriginPullRequest(notification);
        }

        function hasNotificationHtmlAction(notification, action) {
            if (isSyntheticResponsibilityNotification(notification)) {
                return false;
            }
            return Boolean(notification?.ui?.action_tokens?.[action] || state.authenticity_token);
        }

        function safeIsNotificationFromCommitter(notification) {
            return typeof isNotificationFromCommitter === 'function'
                ? isNotificationFromCommitter(notification)
                : false;
        }

        function safeHasNotificationAuthorPermission(notification) {
            return typeof hasNotificationAuthorPermission === 'function'
                ? hasNotificationAuthorPermission(notification)
                : false;
        }

        function safeIsNotificationFromExternal(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            if (!safeHasNotificationAuthorPermission(notification)) {
                return false;
            }
            return !safeIsNotificationFromCommitter(notification);
        }

        function maybePrefetchReviewMetadata(options = {}) {
            if (typeof scheduleReviewDecisionPrefetch === 'function') {
                scheduleReviewDecisionPrefetch(state.notifications, options);
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
            return GhinboxFiltering.getFilteredNotifications(getFilteringInput());
        }

        // Count notifications for each view
        function getViewCounts() {
            return GhinboxFiltering.getViewCounts(getFilteringInput());
        }

        // Count notifications by subfilter for the current view
        function getSubfilterCounts() {
            return GhinboxFiltering.getSubfilterCounts(getFilteringInput());
        }

        function updateCommentCacheStatus() {
            const cachedCount = Object.keys(state.commentCache.threads || {}).length;
            elements.clearCommentCacheBtn.disabled = cachedCount === 0;
            elements.commentCacheStatus.textContent = `Comments cached: ${cachedCount}`;
        }

        function handleClearCommentCache() {
            state.commentCache = { version: 1, threads: {} };
            state.commentQueue = [];
            state.commentQueueKeys.clear();
            state.commentPrefetchProgress.active = false;
            clearCommentCacheStorage().catch((error) => {
                console.error('Failed to clear comment cache:', error);
            });
            localStorage.removeItem(COMMENT_CACHE_KEY);
            if (state.notifications.length > 0) {
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
