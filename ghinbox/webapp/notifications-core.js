// Comment-related constants are in notifications-comments.js
        const LAST_SYNCED_REPO_KEY = 'ghnotif_last_synced_repo';
        const VIEW_KEY = 'ghnotif_view';
        const VIEW_FILTERS_KEY = 'ghnotif_view_filters';
        const AUTH_TOKEN_KEY = 'ghnotif_authenticity_token';
        const ORDER_KEY = 'ghnotif_order';
        const ORDER_BY_VIEW_KEY = 'ghnotif_order_by_view';
        const VALID_ORDERS = new Set(['recent', 'size']);
        const RATE_LIMIT_LOG_MAX = 300;

        // Default view filters for each view
        const DEFAULT_VIEW_FILTERS = {
            'issues': { state: 'all' }, // 'all' | 'open' | 'closed'
            'my-prs': { state: 'all' }, // 'all'
            'others-prs': {
                state: 'all', // 'all' | 'needs-review' | 'approved' | 'draft' | 'closed'
                author: 'all', // 'all' | 'committer' | 'external'
            },
        };
        const DEFAULT_VIEW_ORDERS = {
            'issues': 'recent',
            'my-prs': 'recent',
            'others-prs': 'recent',
        };

        // Application state
        const state = {
            repo: null,
            notifications: [],
            loading: false,
            error: null,
            statusState: null,
            statusTimer: null,
            statusFlashId: 0,
            statusAutoDismissTimer: null,
            statusAutoDismissId: 0,
            lastPersistentStatus: null,
            view: 'issues', // 'issues', 'my-prs', 'others-prs'
            viewFilters: JSON.parse(JSON.stringify(DEFAULT_VIEW_FILTERS)),
            viewOrders: { ...DEFAULT_VIEW_ORDERS },
            orderBy: 'recent',
            selected: new Set(), // Set of selected notification IDs
            activeNotificationId: null, // Keyboard selection cursor
            lastClickedId: null, // For shift-click range selection
            markingInProgress: false, // Whether Mark Done is in progress
            markProgress: { current: 0, total: 0 }, // Progress tracking
            doneSnapshot: { pending: 0, done: 0 }, // Current done snapshot counts
            commentExpandIssues: false,
            commentExpandPrs: false,
            commentHideUninteresting: false,
            commentQueue: [],
            commentQueueRunning: false,
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

        function normalizeViewOrders(raw) {
            const normalized = { ...DEFAULT_VIEW_ORDERS };
            if (!raw || typeof raw !== 'object') {
                return normalized;
            }
            ['issues', 'my-prs', 'others-prs'].forEach((view) => {
                const value = raw[view];
                if (typeof value === 'string' && VALID_ORDERS.has(value)) {
                    normalized[view] = value;
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

        // Initialize app
        async function init() {
            instrumentFetchForRateLimit();

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
                        'others-prs': savedOrder,
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
            if (savedCommentExpandIssues === 'true') {
                state.commentExpandIssues = true;
            }
            elements.commentExpandIssuesToggle.checked = state.commentExpandIssues;

            const savedCommentExpandPrs = localStorage.getItem(COMMENT_EXPAND_PRS_KEY);
            if (savedCommentExpandPrs === 'true') {
                state.commentExpandPrs = true;
            }
            elements.commentExpandPrsToggle.checked = state.commentExpandPrs;

            const savedCommentHideUninteresting = localStorage.getItem(COMMENT_HIDE_UNINTERESTING_KEY);
            if (savedCommentHideUninteresting === 'true') {
                state.commentHideUninteresting = true;
            }
            elements.commentHideUninterestingToggle.checked = state.commentHideUninteresting;

            // Set up event listeners
            elements.syncBtn.addEventListener('click', () => {
                withActionContext('Quick Sync', () => handleSync({ mode: 'incremental' }));
            });
            elements.fullSyncBtn.addEventListener('click', () => {
                withActionContext('Full Sync', () => handleSync({ mode: 'full' }));
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
            elements.clearCommentCacheBtn.addEventListener('click', () => {
                withActionContext('Clear comment cache', handleClearCommentCache);
            });

            // Select all checkbox handler
            elements.selectAllCheckbox.addEventListener('change', handleSelectAll);

            // Mark Done button handler
            elements.markDoneBtn.addEventListener('click', () => {
                withActionContext('Mark done (bulk)', handleMarkDone);
            });

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

            // Check auth status (uses cached value if available)
            checkAuth();
            // Only refresh REST rate limit on init (it's free); skip GraphQL to save rate limit
            refreshRateLimit({ skipGraphql: true });

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

        // Set the current view
        function setView(view) {
            if (!['issues', 'my-prs', 'others-prs'].includes(view)) {
                return;
            }
            state.view = view;
            localStorage.setItem(VIEW_KEY, view);
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
            elements.commentCacheStatus.textContent = `Comments cached: ${cachedCount}`;
        }

        function handleClearCommentCache() {
            state.commentCache = { version: 1, threads: {} };
            state.commentQueue = [];
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
