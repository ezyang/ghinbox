// Shared helpers for synthetic review-request notifications.
(function (root) {
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

    root.GhinboxReviewRequests = {
        buildReviewRequestSearchUrl,
        buildReviewRequestSearchUrlForSource,
        isSyntheticReviewRequest,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
