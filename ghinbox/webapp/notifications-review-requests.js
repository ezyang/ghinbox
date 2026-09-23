// Shared helpers for synthetic review-request notifications.
(function (root) {
    // Review requests are cheap to query, so the Reviews queue is refetched
    // on entry; this interval only damps rapid tab flipping.
    const REVIEW_AUTO_RELOAD_MIN_INTERVAL_MS = 2 * 60 * 1000;

    function buildReviewRequestSearchUrlFromQuery(query) {
        return `/github/rest/review-requests?query=${encodeURIComponent(query)}`;
    }

    function buildReviewRequestSearchUrl(repo) {
        const params = new URLSearchParams({
            owner: repo.owner,
            repo: repo.repo,
        });
        return `/github/rest/review-requests?${params}`;
    }

    function buildReviewRequestSearchUrlForSource(source) {
        return buildReviewRequestSearchUrlFromQuery(source.query);
    }

    function isSyntheticReviewRequest(notification) {
        return notification?.responsibility_source === 'review-requested' &&
            String(notification?.id || '').startsWith('review-request:');
    }

    function shouldAutoReloadReviews({
        view,
        hasProfileEntries,
        reloading = false,
        loading = false,
        lastReloadedAt = null,
        nowMs,
        minIntervalMs = REVIEW_AUTO_RELOAD_MIN_INTERVAL_MS,
    }) {
        if (view !== 'others-prs' || !hasProfileEntries || reloading || loading) {
            return false;
        }
        if (typeof lastReloadedAt !== 'number' || !Number.isFinite(lastReloadedAt)) {
            return true;
        }
        const elapsed = nowMs - lastReloadedAt;
        // A negative elapsed time means the clock moved backwards; reload.
        return elapsed < 0 || elapsed >= minIntervalMs;
    }

    const api = {
        REVIEW_AUTO_RELOAD_MIN_INTERVAL_MS,
        buildReviewRequestSearchUrl,
        buildReviewRequestSearchUrlForSource,
        isSyntheticReviewRequest,
        shouldAutoReloadReviews,
    };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxReviewRequests = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
