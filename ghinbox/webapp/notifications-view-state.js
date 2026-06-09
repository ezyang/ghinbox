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

    return {
        DEFAULT_VIEW_FILTERS,
        DEFAULT_VIEW_ORDERS,
        STORAGE_KEYS,
        VALID_AUDIENCE,
        VALID_AUTHOR,
        VALID_BOOKMARK,
        VALID_FEED_TYPE,
        VALID_INTEREST,
        VALID_ORDERS,
        VALID_STATE_BY_VIEW,
        VALID_VIEWS,
        VIEW_NAMES,
        VIEW_QUERY_KEYS,
        cloneDefaultViewFilters,
        normalizeStateFilter,
        normalizeViewFilters,
        normalizeViewName,
        normalizeViewOrders,
    };
});
