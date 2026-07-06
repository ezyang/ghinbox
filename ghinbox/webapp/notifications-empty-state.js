// Pure empty-state message decision table.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxEmptyState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const viewState = (typeof globalThis !== 'undefined' && globalThis.GhinboxViewState)
        ? globalThis.GhinboxViewState
        : (typeof require === 'function' ? require('./notifications-view-state.js') : null);

    const DEFAULT_VIEW_FILTERS = viewState.DEFAULT_VIEW_FILTERS;

    const VIEW_LABELS = {
        'issues': 'feed',
        'my-prs': 'PR',
        'pr-notifications': 'reply',
        'others-prs': 'review',
        'cleaned': 'cleaned',
    };

    function getEmptyStateMessage(input) {
        const view = input.view;
        const notificationCount = input.notificationCount || 0;
        const trashNotificationCount = input.trashNotificationCount || 0;

        if (view === 'cleaned' && trashNotificationCount === 0) {
            return {
                title: 'No cleaned notifications',
                message: 'Cleaned low-priority notifications will appear here until the next sync.',
            };
        }

        if (notificationCount === 0 && trashNotificationCount === 0) {
            return {
                title: 'No notifications',
                message: 'Enter a repository and click Quick Sync to load notifications.',
            };
        }

        const viewLabel = VIEW_LABELS[view];
        const filters = input.viewFilters?.[view] || DEFAULT_VIEW_FILTERS[view] || {};
        const stateFilter = filters.state || 'all';
        const authorFilter = filters.author || 'all';
        const audienceFilter = filters.audience || 'all';
        const viewCounts = input.viewCounts || {};
        const viewCountKey = viewState.getViewCountKey(view);
        const viewCount = viewCounts[viewCountKey] || 0;

        if (viewCount === 0) {
            if (view === 'issues') {
                return {
                    title: 'No feed notifications',
                    message: 'No awareness notifications in this repository.',
                };
            }
            if (view === 'my-prs') {
                return {
                    title: 'No notifications for your PRs',
                    message: 'No notifications for pull requests you authored.',
                };
            }
            if (view === 'others-prs') {
                return {
                    title: 'No reviews',
                    message: 'No pull requests need your review right now.',
                };
            }
            if (view === 'pr-notifications') {
                return {
                    title: 'No replies',
                    message: 'No notifications look like someone is talking to you.',
                };
            }
            if (view === 'cleaned') {
                return {
                    title: 'No cleaned notifications',
                    message: 'Cleaned low-priority notifications will appear here until the next sync.',
                };
            }
        }

        if (stateFilter === 'open') {
            return {
                title: `No open ${viewLabel} notifications`,
                message: `All ${viewLabel} notifications in this view are closed or merged.`,
            };
        }

        if (stateFilter === 'closed') {
            return {
                title: `No closed ${viewLabel} notifications`,
                message: `All ${viewLabel} notifications in this view are still open.`,
            };
        }

        if (stateFilter === 'draft') {
            return {
                title: `No draft ${viewLabel} notifications`,
                message: `All ${viewLabel} notifications in this view are ready for review.`,
            };
        }

        if (stateFilter === 'needs-review') {
            return {
                title: 'No PRs need review',
                message: 'No PRs need your review right now.',
            };
        }

        if (stateFilter === 'approved') {
            return {
                title: 'No approved PRs',
                message: 'No approved PR notifications are pending.',
            };
        }

        if (authorFilter === 'committer') {
            return {
                title: 'No committer PRs',
                message: 'No pull requests from repository committers match this view.',
            };
        }

        if (authorFilter === 'ai') {
            return {
                title: 'No AI PRs',
                message: 'No pull requests from AI authors match this view.',
            };
        }

        if (authorFilter === 'external') {
            return {
                title: 'No external PRs',
                message: 'No pull requests from external contributors match this view.',
            };
        }

        if (audienceFilter === 'for-you') {
            return {
                title: 'No replies',
                message: 'No notifications look like someone is talking to you.',
            };
        }

        if (audienceFilter === 'for-others') {
            return {
                title: 'No PR notifications for others',
                message: 'All matching pull request notifications are for you.',
            };
        }

        return {
            title: 'No notifications',
            message: 'No notifications match the current filter.',
        };
    }

    return {
        getEmptyStateMessage,
    };
});
