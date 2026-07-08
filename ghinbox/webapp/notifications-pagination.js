// Pure pagination guard logic for notification cursor walks.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxPagination = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const MAX_NOTIFICATION_FETCH_PAGES = 50;

    function normalizePositiveInteger(value, fallback) {
        if (!Number.isFinite(value)) {
            return fallback;
        }
        return Math.max(1, Math.floor(value));
    }

    function normalizePageCount(value) {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.floor(value));
    }

    function normalizeCursor(value) {
        if (value === null || value === undefined) {
            return null;
        }
        const cursor = String(value);
        return cursor ? cursor : null;
    }

    function stop(error = null) {
        return {
            shouldFetchNext: false,
            nextCursor: null,
            error,
        };
    }

    function getNextNotificationPage({
        pagination = null,
        currentCursor = null,
        pagesFetched = 0,
        maxPages = MAX_NOTIFICATION_FETCH_PAGES,
    } = {}) {
        if (!pagination?.has_next) {
            return stop();
        }

        const limit = normalizePositiveInteger(maxPages, MAX_NOTIFICATION_FETCH_PAGES);
        const fetched = normalizePageCount(pagesFetched);
        if (fetched >= limit) {
            return stop(`Notification sync exceeded ${limit} notification pages for one source.`);
        }

        const nextCursor = normalizeCursor(pagination.after_cursor);
        if (!nextCursor) {
            return stop('Notification pagination reported another page but provided no after cursor.');
        }

        const previousCursor = normalizeCursor(currentCursor);
        if (previousCursor && nextCursor === previousCursor) {
            return stop(
                `Notification pagination cursor did not advance after ${fetched} pages.`
            );
        }

        return {
            shouldFetchNext: true,
            nextCursor,
            error: null,
        };
    }

    return {
        MAX_NOTIFICATION_FETCH_PAGES,
        getNextNotificationPage,
    };
});
