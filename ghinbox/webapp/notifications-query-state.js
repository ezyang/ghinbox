// URL <-> localStorage synchronization for view, filter, order, repo, and profile state.
(function () {
    const viewState = globalThis.GhinboxViewState;
    const {
        DEFAULT_VIEW_FILTERS,
        DEFAULT_VIEW_ORDERS,
        STORAGE_KEYS,
        VALID_AUDIENCE,
        VALID_AUTHOR,
        VALID_BOOKMARK,
        VALID_FEED_TYPE,
        VALID_INTEREST,
        VALID_ORDERS,
        VALID_VIEWS,
        VIEW_NAMES,
        VIEW_QUERY_KEYS,
        cloneDefaultViewFilters,
        normalizeStateFilter,
        normalizeViewFilters,
        normalizeViewName,
        normalizeViewOrders,
    } = viewState;

    function cloneDefaultOrders() {
        return { ...DEFAULT_VIEW_ORDERS };
    }

    function readStoredFilters() {
        const raw = localStorage.getItem(STORAGE_KEYS.viewFilters);
        if (!raw) {
            return cloneDefaultViewFilters();
        }
        try {
            return normalizeViewFilters(JSON.parse(raw));
        } catch (error) {
            return cloneDefaultViewFilters();
        }
    }

    function readStoredOrders() {
        const raw = localStorage.getItem(STORAGE_KEYS.orderByView);
        if (raw) {
            try {
                return normalizeViewOrders(JSON.parse(raw));
            } catch (error) {
                return cloneDefaultOrders();
            }
        }
        const legacy = localStorage.getItem(STORAGE_KEYS.order);
        if (legacy && VALID_ORDERS.has(legacy)) {
            return Object.fromEntries(VIEW_NAMES.map((view) => [view, legacy]));
        }
        return cloneDefaultOrders();
    }

    function getStoredView() {
        return normalizeViewName(localStorage.getItem(STORAGE_KEYS.view));
    }

    function updateQueryFromStorage() {
        const params = new URLSearchParams(window.location.search);
        const view = getStoredView();
        const repo = (localStorage.getItem(STORAGE_KEYS.repo) || '').trim();
        const profile = (localStorage.getItem(STORAGE_KEYS.profile) || '').trim();
        const filters = readStoredFilters();
        const orders = readStoredOrders();

        params.set('view', view);
        if (profile) {
            params.set('profile', profile);
        } else {
            params.delete('profile');
        }
        if (repo) {
            params.set('repo', repo);
        } else {
            params.delete('repo');
        }

        params.delete('state');
        params.delete('author');

        VIEW_NAMES.forEach((viewName) => {
            const config = VIEW_QUERY_KEYS[viewName];
            const filtersForView = filters[viewName] || DEFAULT_VIEW_FILTERS[viewName] || {};
            Object.entries(config).forEach(([filterName, queryKey]) => {
                if (filterName === 'order') {
                    params.set(queryKey, orders[viewName] || DEFAULT_VIEW_ORDERS[viewName]);
                    return;
                }
                params.set(queryKey, filtersForView[filterName] || 'all');
            });
        });

        const next = params.toString();
        const url = next ? `${window.location.pathname}?${next}` : window.location.pathname;
        window.history.replaceState(null, '', url);
    }

    function applyQueryToStorage() {
        const params = new URLSearchParams(window.location.search);
        const view = params.get('view');
        const repo = params.get('repo');
        const profile = params.get('profile');
        let applied = false;

        if (profile !== null) {
            localStorage.setItem(STORAGE_KEYS.profile, profile);
            applied = true;
        }

        if (repo !== null) {
            localStorage.setItem(STORAGE_KEYS.repo, repo);
            applied = true;
        }

        const normalizedView = view === 'trash' ? 'cleaned' : view;
        if (normalizedView && VALID_VIEWS.has(normalizedView)) {
            localStorage.setItem(STORAGE_KEYS.view, normalizedView);
            applied = true;
        }

        const filters = cloneDefaultViewFilters();
        const orders = cloneDefaultOrders();
        let hasFilterParams = false;
        let hasOrderParams = false;
        const legacyState = params.get('state');
        const legacyAuthor = params.get('author');

        VIEW_NAMES.forEach((viewName) => {
            const config = VIEW_QUERY_KEYS[viewName];
            const stateParam = params.get(config.state) ||
                (viewName === normalizedView ? legacyState : null);
            if (stateParam) {
                filters[viewName].state = normalizeStateFilter(viewName, stateParam);
                hasFilterParams = true;
            }

            if (config.author) {
                const authorParam = params.get(config.author) ||
                    (viewName === normalizedView ? legacyAuthor : null);
                if (authorParam && VALID_AUTHOR.has(authorParam)) {
                    filters[viewName].author = authorParam;
                    hasFilterParams = true;
                }
            }
            if (config.audience) {
                const audienceParam = params.get(config.audience);
                if (audienceParam && VALID_AUDIENCE.has(audienceParam)) {
                    filters[viewName].audience = audienceParam;
                    hasFilterParams = true;
                }
            }
            if (config.interest) {
                const interestParam = params.get(config.interest);
                if (interestParam && VALID_INTEREST.has(interestParam)) {
                    filters[viewName].interest = interestParam;
                    hasFilterParams = true;
                }
            }
            if (config.bookmark) {
                const bookmarkParam = params.get(config.bookmark);
                if (bookmarkParam && VALID_BOOKMARK.has(bookmarkParam)) {
                    filters[viewName].bookmark = bookmarkParam;
                    hasFilterParams = true;
                }
            }
            if (config.type) {
                const typeParam = params.get(config.type);
                if (typeParam && VALID_FEED_TYPE.has(typeParam)) {
                    filters[viewName].type = typeParam;
                    hasFilterParams = true;
                }
            }

            const orderParam = params.get(config.order);
            if (orderParam && VALID_ORDERS.has(orderParam)) {
                orders[viewName] = orderParam;
                hasOrderParams = true;
            }
        });

        if (hasFilterParams) {
            localStorage.setItem(STORAGE_KEYS.viewFilters, JSON.stringify(filters));
            applied = true;
        }
        if (hasOrderParams) {
            localStorage.setItem(STORAGE_KEYS.orderByView, JSON.stringify(orders));
            applied = true;
        }

        return applied;
    }

    function scheduleQueryUpdate() {
        window.setTimeout(updateQueryFromStorage, 0);
    }

    applyQueryToStorage();

    document.addEventListener('click', (event) => {
        if (event.target.closest('.view-tab') || event.target.closest('.subfilter-tab')) {
            scheduleQueryUpdate();
        }
    });

    const repoInput = document.getElementById('repo-input');
    if (repoInput) {
        repoInput.addEventListener('input', scheduleQueryUpdate);
    }
    const profileSelect = document.getElementById('profile-select');
    if (profileSelect) {
        profileSelect.addEventListener('change', scheduleQueryUpdate);
    }
    const orderSelect = document.getElementById('order-select');
    if (orderSelect) {
        orderSelect.addEventListener('change', scheduleQueryUpdate);
    }
})();
