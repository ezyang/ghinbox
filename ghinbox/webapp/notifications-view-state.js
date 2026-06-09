// Shared view, filter, order, storage, and query-state helpers.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxViewState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const STORAGE_KEYS = {
        repo: 'ghnotif_repo',
        profile: 'ghnotif_profile',
        profiles: 'ghnotif_profiles',
        lastSyncedRepo: 'ghnotif_last_synced_repo',
        view: 'ghnotif_view',
        viewFilters: 'ghnotif_view_filters',
        authenticityToken: 'ghnotif_authenticity_token',
        order: 'ghnotif_order',
        orderByView: 'ghnotif_order_by_view',
        autoMarkTrash: 'ghnotif_auto_mark_trash_done',
        authCache: 'ghnotif_auth_cache',
        cacheBust: 'ghnotif_cache_bust',
    };

    const VIEW_NAMES = ['issues', 'my-prs', 'pr-notifications', 'others-prs', 'cleaned'];
    const VALID_VIEWS = new Set(VIEW_NAMES);
    const VALID_ORDERS = new Set(['recent', 'size']);
    const ORDER_OPTIONS = [
        { value: 'recent', label: 'Newest first' },
        { value: 'size', label: 'PR size (small to big)' },
    ];
    const VALID_STATE_BY_VIEW = {
        'issues': new Set(['all', 'open', 'closed']),
        'my-prs': new Set(['all']),
        'pr-notifications': new Set(['all', 'open', 'closed']),
        'others-prs': new Set(['all', 'needs-review', 'approved', 'done']),
        'cleaned': new Set(['all']),
    };
    const VALID_AUTHOR = new Set(['all', 'committer', 'ai', 'external']);
    const VALID_AUDIENCE = new Set(['all', 'for-you', 'for-others']);
    const VALID_INTEREST = new Set(['all', 'has-new', 'no-new']);
    const VALID_BOOKMARK = new Set(['all', 'new', 'bookmarked']);
    const VALID_FEED_TYPE = new Set(['all', 'prs', 'issues']);

    const DEFAULT_VIEW_FILTERS = {
        'issues': {
            state: 'all',
            bookmark: 'new',
            type: 'all',
            interest: 'all',
        },
        'my-prs': { state: 'all', interest: 'all' },
        'pr-notifications': { state: 'all', audience: 'all', interest: 'all' },
        'others-prs': {
            state: 'all',
            author: 'all',
            interest: 'all',
        },
        'cleaned': { state: 'all' },
    };

    const DEFAULT_VIEW_ORDERS = {
        'issues': 'recent',
        'my-prs': 'recent',
        'pr-notifications': 'recent',
        'others-prs': 'recent',
        'cleaned': 'recent',
    };

    const VIEW_QUERY_KEYS = {
        'issues': {
            state: 'issues_state',
            bookmark: 'issues_bookmark',
            type: 'issues_type',
            interest: 'issues_interest',
            order: 'issues_order',
        },
        'my-prs': {
            state: 'my_prs_state',
            interest: 'my_prs_interest',
            order: 'my_prs_order',
        },
        'pr-notifications': {
            state: 'pr_notifications_state',
            audience: 'pr_notifications_audience',
            interest: 'pr_notifications_interest',
            order: 'pr_notifications_order',
        },
        'others-prs': {
            state: 'others_prs_state',
            author: 'others_prs_author',
            interest: 'others_prs_interest',
            order: 'others_prs_order',
        },
        'cleaned': { state: 'cleaned_state', order: 'cleaned_order' },
    };

    const VIEW_CONFIG = {
        'issues': {
            label: 'Feed',
            showTab: true,
            countKey: 'issues',
            mobilePrimaryGroup: 'state',
            filterGroups: [
                {
                    group: 'bookmark',
                    ariaLabel: 'Filter feed by bookmark',
                    options: [
                        { value: 'new', label: 'New' },
                        { value: 'bookmarked', label: 'Bookmarked' },
                    ],
                },
                {
                    group: 'state',
                    ariaLabel: 'Filter feed',
                    options: [
                        { value: 'open', label: 'Open' },
                        { value: 'closed', label: 'Closed' },
                    ],
                },
                {
                    group: 'type',
                    ariaLabel: 'Filter feed by type',
                    options: [
                        { value: 'prs', label: 'PRs' },
                        { value: 'issues', label: 'Issues' },
                    ],
                },
                {
                    group: 'interest',
                    ariaLabel: 'Filter feed by interest',
                    options: [
                        { value: 'has-new', label: 'Has new', countKey: 'hasNew' },
                        { value: 'no-new', label: 'No new', countKey: 'noNew' },
                    ],
                },
            ],
        },
        'my-prs': {
            label: 'My PRs',
            showTab: false,
            countKey: 'myPrs',
            mobilePrimaryGroup: 'state',
            filterGroups: [],
        },
        'pr-notifications': {
            label: 'Replies',
            showTab: true,
            countKey: 'prNotifications',
            mobilePrimaryGroup: 'state',
            filterGroups: [
                {
                    group: 'state',
                    ariaLabel: 'Filter replies by status',
                    options: [
                        { value: 'open', label: 'Open' },
                        { value: 'closed', label: 'Closed' },
                    ],
                },
                {
                    group: 'interest',
                    ariaLabel: 'Filter replies by interest',
                    options: [
                        { value: 'has-new', label: 'Has new', countKey: 'hasNew' },
                        { value: 'no-new', label: 'No new', countKey: 'noNew' },
                    ],
                },
            ],
        },
        'others-prs': {
            label: 'Reviews',
            showTab: true,
            countKey: 'othersPrs',
            mobilePrimaryGroup: 'state',
            mobileSecondaryGroup: 'author',
            filterGroups: [
                {
                    group: 'state',
                    ariaLabel: 'Filter reviews by status',
                    options: [
                        { value: 'needs-review', label: 'Needs review', countKey: 'needsReview' },
                        { value: 'approved', label: 'Approved' },
                        { value: 'done', label: 'Done' },
                    ],
                },
                {
                    group: 'author',
                    ariaLabel: 'Filter reviews by author',
                    allLabel: 'All authors',
                    options: [
                        { value: 'committer', label: 'Committers' },
                        { value: 'ai', label: 'AI' },
                        { value: 'external', label: 'External' },
                    ],
                },
            ],
        },
        'cleaned': {
            label: 'Cleaned',
            showTab: true,
            countKey: 'trash',
            mobilePrimaryGroup: 'state',
            filterGroups: [],
        },
    };

    function normalizeStateFilter(view, stateFilter) {
        if (view === 'others-prs' && (stateFilter === 'draft' || stateFilter === 'closed')) {
            return 'done';
        }
        if (VALID_STATE_BY_VIEW[view]?.has(stateFilter)) {
            return stateFilter;
        }
        return DEFAULT_VIEW_FILTERS[view]?.state || 'all';
    }

    function normalizeSetValue(value, validValues, fallback = 'all') {
        return validValues.has(value) ? value : fallback;
    }

    function cloneDefaultViewFilters() {
        return JSON.parse(JSON.stringify(DEFAULT_VIEW_FILTERS));
    }

    function normalizeViewFilters(raw) {
        const normalized = cloneDefaultViewFilters();
        if (!raw || typeof raw !== 'object') {
            return normalized;
        }
        VIEW_NAMES.forEach((view) => {
            const value = raw[view];
            if (typeof value === 'string') {
                normalized[view].state = normalizeStateFilter(view, value);
                return;
            }
            if (value && typeof value === 'object') {
                normalized[view] = {
                    ...normalized[view],
                    ...value,
                };
                normalized[view].state = normalizeStateFilter(view, normalized[view].state);
                if ('author' in normalized[view]) {
                    normalized[view].author = normalizeSetValue(
                        normalized[view].author,
                        VALID_AUTHOR
                    );
                }
                if ('audience' in normalized[view]) {
                    normalized[view].audience = normalizeSetValue(
                        normalized[view].audience,
                        VALID_AUDIENCE
                    );
                }
                if ('interest' in normalized[view]) {
                    normalized[view].interest = normalizeSetValue(
                        normalized[view].interest,
                        VALID_INTEREST
                    );
                }
                if ('bookmark' in normalized[view]) {
                    normalized[view].bookmark = normalizeSetValue(
                        normalized[view].bookmark,
                        VALID_BOOKMARK,
                        DEFAULT_VIEW_FILTERS[view]?.bookmark || 'all'
                    );
                }
                if ('type' in normalized[view]) {
                    normalized[view].type = normalizeSetValue(
                        normalized[view].type,
                        VALID_FEED_TYPE,
                        'all'
                    );
                }
            }
        });
        return normalized;
    }

    function normalizeViewOrders(raw) {
        const normalized = { ...DEFAULT_VIEW_ORDERS };
        if (!raw || typeof raw !== 'object') {
            return normalized;
        }
        VIEW_NAMES.forEach((view) => {
            const value = raw[view];
            if (typeof value === 'string' && VALID_ORDERS.has(value)) {
                normalized[view] = value;
            }
        });
        return normalized;
    }

    function normalizeViewName(view) {
        if (view === 'trash') {
            return 'cleaned';
        }
        return VALID_VIEWS.has(view) ? view : 'issues';
    }

    function getViewConfig(view) {
        return VIEW_CONFIG[normalizeViewName(view)] || VIEW_CONFIG.issues;
    }

    function getVisibleViewConfigs() {
        return VIEW_NAMES
            .map((view) => ({ view, ...VIEW_CONFIG[view] }))
            .filter((config) => config.showTab);
    }

    function getFilterGroupsForView(view) {
        return getViewConfig(view).filterGroups || [];
    }

    function getFilterGroupConfig(view, group) {
        return getFilterGroupsForView(view).find((config) => config.group === group) || null;
    }

    function getViewCountKey(view) {
        return getViewConfig(view).countKey;
    }

    function getFilterCountKey(view, group, value) {
        const option = getFilterGroupConfig(view, group)?.options.find(
            (item) => item.value === value
        );
        if (option?.countKey) {
            return option.countKey;
        }
        return value;
    }

    function getMobileFilterOptions(view) {
        const config = getViewConfig(view);
        const primaryGroup = config.mobilePrimaryGroup || 'state';
        const group = getFilterGroupConfig(view, primaryGroup);
        return [
            { value: 'all', label: 'All' },
            ...(group?.options || []).map((option) => ({
                value: option.value,
                label: option.label,
            })),
        ];
    }

    function getMobileSecondaryGroup(view) {
        return getViewConfig(view).mobileSecondaryGroup || null;
    }

    function getMobileSecondaryOptions(view) {
        const groupName = getMobileSecondaryGroup(view);
        if (!groupName) {
            return [{ value: 'all', label: 'All' }];
        }
        const group = getFilterGroupConfig(view, groupName);
        return [
            { value: 'all', label: group?.allLabel || 'All' },
            ...(group?.options || []).map((option) => ({
                value: option.value,
                label: option.label,
            })),
        ];
    }

    return {
        DEFAULT_VIEW_FILTERS,
        DEFAULT_VIEW_ORDERS,
        ORDER_OPTIONS,
        STORAGE_KEYS,
        VALID_AUDIENCE,
        VALID_AUTHOR,
        VALID_BOOKMARK,
        VALID_FEED_TYPE,
        VALID_INTEREST,
        VALID_ORDERS,
        VALID_STATE_BY_VIEW,
        VALID_VIEWS,
        VIEW_CONFIG,
        VIEW_NAMES,
        VIEW_QUERY_KEYS,
        cloneDefaultViewFilters,
        getFilterCountKey,
        getFilterGroupConfig,
        getFilterGroupsForView,
        getMobileFilterOptions,
        getMobileSecondaryGroup,
        getMobileSecondaryOptions,
        getViewConfig,
        getViewCountKey,
        getVisibleViewConfigs,
        normalizeStateFilter,
        normalizeViewFilters,
        normalizeViewName,
        normalizeViewOrders,
    };
});
