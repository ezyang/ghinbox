// Shared helpers for synthetic review-request notifications.
(function (root) {
    function buildReviewRequestSearchUrlFromQuery(query) {
        const search = [query, 'is:pr', 'is:open', 'user-review-requested:@me'].join(' ');
        return `/github/rest/search/issues?q=${encodeURIComponent(search)}&per_page=100`;
    }

    function buildReviewRequestSearchUrl(repo) {
        return buildReviewRequestSearchUrlFromQuery(`repo:${repo.owner}/${repo.repo}`);
    }

    function buildReviewRequestSearchUrlForSource(source) {
        return buildReviewRequestSearchUrlFromQuery(source.query);
    }

    function searchItemToResponsibilityNotification(repo, item) {
        const user = item.user || {};
        const state = item.draft ? 'draft' : 'open';
        return {
            id: `review-request:${repo.owner}/${repo.repo}#${item.number}`,
            unread: false,
            reason: 'review_requested',
            responsibility_source: 'review-requested',
            updated_at: item.updated_at || item.created_at || new Date().toISOString(),
            last_read_at: null,
            repository: {
                owner: repo.owner,
                name: repo.repo,
                full_name: `${repo.owner}/${repo.repo}`,
            },
            subject: {
                title: item.title || `Pull request #${item.number}`,
                url: item.html_url || `https://github.com/${repo.owner}/${repo.repo}/pull/${item.number}`,
                type: 'PullRequest',
                number: item.number,
                state,
                state_reason: null,
            },
            actors: user.login
                ? [{
                    login: user.login,
                    avatar_url: user.avatar_url || '',
                }]
                : [],
            ui: {
                saved: false,
                done: false,
                action_tokens: {},
            },
        };
    }

    function isSyntheticReviewRequest(notification) {
        return notification?.responsibility_source === 'review-requested' &&
            String(notification?.id || '').startsWith('review-request:');
    }

    root.GhinboxReviewRequests = {
        buildReviewRequestSearchUrl,
        buildReviewRequestSearchUrlForSource,
        isSyntheticReviewRequest,
        searchItemToResponsibilityNotification,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
