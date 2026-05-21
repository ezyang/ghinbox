// Pure notification classification, filtering, sorting, and count helpers.
// Browser code injects comment-derived predicates; Node tests import this file.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxFiltering = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const VALID_ORDERS = new Set(['recent', 'size']);

    const DEFAULT_VIEW_FILTERS = {
        'issues': { state: 'all', interest: 'all' },
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

    const VIEW_NAMES = ['issues', 'my-prs', 'pr-notifications', 'others-prs', 'cleaned'];
    const VALID_STATE_BY_VIEW = {
        'issues': new Set(['all', 'open', 'closed']),
        'my-prs': new Set(['all']),
        'pr-notifications': new Set(['all', 'open', 'closed']),
        'others-prs': new Set(['all', 'needs-review', 'approved', 'done']),
        'cleaned': new Set(['all']),
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

    function getNotificationKey(notification) {
        if (notification?.repository?.full_name && notification?.subject?.url) {
            return `${notification.repository.full_name}#${notification.subject.url}`;
        }
        return notification?.id || notification?.subject?.url || '';
    }

    function makeClassifier(options = {}) {
        const deps = options.deps || {};
        const commentCache = options.commentCache || { threads: {} };
        const currentUserLogin = String(options.currentUserLogin || '').toLowerCase();
        const notificationKey = deps.notificationKey || getNotificationKey;

        function cachedFor(notification) {
            return commentCache?.threads?.[notificationKey(notification)];
        }

        function isMyPr(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            const reason = String(notification.reason || '').toLowerCase();
            if (reason === 'author') {
                return true;
            }
            if (!currentUserLogin) {
                return false;
            }
            const cachedAuthor = String(cachedFor(notification)?.authorLogin || '').toLowerCase();
            return Boolean(cachedAuthor) && cachedAuthor === currentUserLogin;
        }

        function isSyntheticResponsibilityNotification(notification) {
            return notification?.responsibility_source === 'review-requested' &&
                String(notification?.id || '').startsWith('review-request:');
        }

        function isNotificationOriginPullRequest(notification) {
            return notification?.subject?.type === 'PullRequest' &&
                !isSyntheticResponsibilityNotification(notification);
        }

        function isCommitNotification(notification) {
            const type = String(notification.subject?.type || '').toLowerCase();
            if (type === 'commit') {
                return true;
            }
            const url = String(notification.subject?.url || '');
            return /github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}(?:[?#/]|$)/i.test(url);
        }

        function isNotificationApproved(notification) {
            return deps.isNotificationApproved
                ? deps.isNotificationApproved(notification)
                : false;
        }

        function isNotificationChangesRequested(notification) {
            return deps.isNotificationChangesRequested
                ? deps.isNotificationChangesRequested(notification)
                : false;
        }

        function getLabelNames(notification) {
            const cached = cachedFor(notification);
            const labels = Array.isArray(cached?.labelNames)
                ? cached.labelNames
                : Array.isArray(notification?.labels)
                    ? notification.labels.map((label) =>
                        typeof label === 'string' ? label : label?.name
                    )
                    : [];
            return labels
                .map((label) => String(label || '').trim().toLowerCase())
                .filter(Boolean);
        }

        function hasMergedogLabel(notification) {
            return getLabelNames(notification).includes('mergedog');
        }

        function isNotificationDone(notification) {
            const notifState = notification.subject?.state;
            return (
                notifState === 'draft' ||
                notifState === 'closed' ||
                notifState === 'merged' ||
                hasMergedogLabel(notification)
            );
        }

        function isNotificationReviewResponsibility(notification) {
            if (deps.isNotificationReviewResponsibility) {
                return deps.isNotificationReviewResponsibility(notification);
            }
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            const reason = String(notification.reason || '').toLowerCase();
            return reason === 'review_requested' || reason === 'approved';
        }

        function isNotificationNeedsReview(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            const notifState = notification.subject?.state;
            if (notifState === 'draft' || notifState === 'closed' || notifState === 'merged') {
                return false;
            }
            if (isNotificationDone(notification)) {
                return false;
            }
            if (!isNotificationReviewResponsibility(notification)) {
                return false;
            }
            return !isNotificationApproved(notification);
        }

        function isNotificationForCurrentUser(notification) {
            return deps.isNotificationForCurrentUser
                ? deps.isNotificationForCurrentUser(notification)
                : isMyPr(notification) ||
                    String(notification.reason || '').toLowerCase() === 'mention';
        }

        function isNotificationDirectedAtCurrentUser(notification) {
            return deps.isNotificationDirectedAtCurrentUser
                ? deps.isNotificationDirectedAtCurrentUser(notification)
                : false;
        }

        function isNotificationReviewQueue(notification) {
            return notification.subject?.type === 'PullRequest' &&
                (
                    isSyntheticResponsibilityNotification(notification) ||
                    isNotificationReviewResponsibility(notification)
                );
        }

        function isNotificationFromCommitter(notification) {
            return deps.isNotificationFromCommitter
                ? deps.isNotificationFromCommitter(notification)
                : false;
        }

        function hasNotificationAuthorPermission(notification) {
            return deps.hasNotificationAuthorPermission
                ? deps.hasNotificationAuthorPermission(notification)
                : false;
        }

        function isNotificationFromExternal(notification) {
            if (notification.subject?.type !== 'PullRequest') {
                return false;
            }
            if (!hasNotificationAuthorPermission(notification)) {
                return false;
            }
            return !isNotificationFromCommitter(notification);
        }

        function getUninterestingReason(notification) {
            return deps.getUninterestingReason
                ? deps.getUninterestingReason(notification)
                : null;
        }

        function getNotificationSize(notification) {
            return deps.getNotificationSize
                ? deps.getNotificationSize(notification)
                : null;
        }

        function matchesView(notification, view) {
            if (view === 'issues') {
                return !isSyntheticResponsibilityNotification(notification) &&
                    !isNotificationReviewQueue(notification) &&
                    !isNotificationDirectedAtCurrentUser(notification);
            }
            if (view === 'my-prs') {
                return isMyPr(notification);
            }
            if (view === 'pr-notifications') {
                return !isSyntheticResponsibilityNotification(notification) &&
                    isNotificationDirectedAtCurrentUser(notification);
            }
            if (view === 'others-prs') {
                return isNotificationReviewQueue(notification);
            }
            if (view === 'cleaned') {
                return false;
            }
            return true;
        }

        function isTrashNotification(notification) {
            const type = notification.subject?.type;
            const notifState = notification.subject?.state;
            const uninteresting = getUninterestingReason(notification) !== null;

            if (isCommitNotification(notification)) {
                return true;
            }

            if (
                type === 'Issue' &&
                (notifState === 'closed' || notifState === 'merged') &&
                String(notification.reason || '').toLowerCase() !== 'author' &&
                !isNotificationDirectedAtCurrentUser(notification)
            ) {
                return true;
            }

            if (type === 'PullRequest' && isMyPr(notification) && uninteresting) {
                return true;
            }

            if (
                isNotificationOriginPullRequest(notification) &&
                !isMyPr(notification) &&
                !isNotificationForCurrentUser(notification)
            ) {
                return true;
            }

            if (type !== 'PullRequest' || isMyPr(notification)) {
                return false;
            }

            return (
                isNotificationApproved(notification) ||
                isNotificationDone(notification)
            );
        }

        return {
            cachedFor,
            getNotificationSize,
            getUninterestingReason,
            hasNotificationAuthorPermission,
            isCommitNotification,
            isMyPr,
            isNotificationApproved,
            isNotificationChangesRequested,
            isNotificationDirectedAtCurrentUser,
            isNotificationDone,
            isNotificationForCurrentUser,
            isNotificationFromCommitter,
            isNotificationFromExternal,
            isNotificationNeedsReview,
            isNotificationOriginPullRequest,
            isNotificationReviewQueue,
            isNotificationReviewResponsibility,
            isSyntheticResponsibilityNotification,
            isTrashNotification,
            matchesView,
        };
    }

    function applyStateFilter(notifications, stateFilter, classifier) {
        if (stateFilter === 'all') {
            return notifications;
        }
        return notifications.filter((notif) => {
            const notifState = notif.subject?.state;
            if (stateFilter === 'open') {
                return notifState === 'open' || notifState === 'draft';
            }
            if (stateFilter === 'closed') {
                return notifState === 'closed' || notifState === 'merged';
            }
            if (stateFilter === 'draft') {
                return notifState === 'draft';
            }
            if (stateFilter === 'done') {
                return classifier.isNotificationDone(notif);
            }
            if (stateFilter === 'needs-review') {
                return classifier.isNotificationNeedsReview(notif);
            }
            if (stateFilter === 'approved') {
                return !classifier.isNotificationDone(notif) &&
                    classifier.isNotificationApproved(notif);
            }
            return true;
        });
    }

    function applyAuthorFilter(notifications, authorFilter, classifier) {
        if (authorFilter === 'all') {
            return notifications;
        }
        return notifications.filter((notif) => {
            if (authorFilter === 'committer') {
                return classifier.isNotificationFromCommitter(notif);
            }
            if (authorFilter === 'external') {
                return classifier.isNotificationFromExternal(notif);
            }
            return true;
        });
    }

    function applyAudienceFilter(notifications, audienceFilter, classifier) {
        if (audienceFilter === 'all') {
            return notifications;
        }
        return notifications.filter((notif) => {
            const forCurrentUser = classifier.isNotificationForCurrentUser(notif);
            if (audienceFilter === 'for-you') {
                return forCurrentUser;
            }
            if (audienceFilter === 'for-others') {
                return !forCurrentUser;
            }
            return true;
        });
    }

    function applyInterestFilter(notifications, interestFilter, classifier) {
        if (interestFilter === 'all') {
            return notifications;
        }
        return notifications.filter((notif) => {
            const reason = classifier.getUninterestingReason(notif);
            const isUninteresting = reason !== null;
            if (interestFilter === 'has-new') {
                return !isUninteresting;
            }
            if (interestFilter === 'no-new') {
                return isUninteresting;
            }
            return true;
        });
    }

    function getFilteredNotifications(input) {
        const classifier = input.classifier || makeClassifier(input);
        const view = input.view || 'issues';
        let filtered = view === 'cleaned'
            ? (input.trashNotifications || []).slice()
            : (input.notifications || []).filter((notification) =>
                classifier.matchesView(notification, view)
            );

        if (view === 'cleaned') {
            return filtered;
        }

        const filters = input.viewFilters?.[view] || DEFAULT_VIEW_FILTERS[view] || {};
        filtered = applyStateFilter(filtered, filters.state || 'all', classifier);

        if (view === 'others-prs') {
            filtered = applyAuthorFilter(filtered, filters.author || 'all', classifier);
        }

        if (view === 'pr-notifications') {
            filtered = applyAudienceFilter(filtered, filters.audience || 'all', classifier);
        }

        filtered = applyInterestFilter(filtered, filters.interest || 'all', classifier);

        if (input.orderBy === 'size' && view !== 'issues') {
            return sortNotificationsBySize(filtered, classifier);
        }

        return filtered;
    }

    function sortNotificationsBySize(notifications, classifier) {
        return notifications
            .map((notif, index) => ({
                notif,
                index,
                size: classifier.getNotificationSize(notif),
            }))
            .sort((a, b) => {
                if (a.size === null && b.size === null) {
                    return a.index - b.index;
                }
                if (a.size === null) {
                    return 1;
                }
                if (b.size === null) {
                    return -1;
                }
                if (a.size === b.size) {
                    return a.index - b.index;
                }
                return a.size - b.size;
            })
            .map((entry) => entry.notif);
    }

    function getViewCounts(input) {
        const classifier = input.classifier || makeClassifier(input);
        const counts = {
            issues: 0,
            myPrs: 0,
            prNotifications: 0,
            othersPrs: 0,
            trash: (input.trashNotifications || []).length,
        };

        (input.notifications || []).forEach((notif) => {
            if (classifier.matchesView(notif, 'issues')) {
                counts.issues++;
            }
            if (notif.subject?.type === 'PullRequest' && classifier.isMyPr(notif)) {
                counts.myPrs++;
            }
            if (classifier.matchesView(notif, 'pr-notifications')) {
                counts.prNotifications++;
            }
            if (classifier.isNotificationReviewQueue(notif)) {
                counts.othersPrs++;
            }
        });

        return counts;
    }

    function getSubfilterCounts(input) {
        const classifier = input.classifier || makeClassifier(input);
        const view = input.view || 'issues';
        const trashNotifications = input.trashNotifications || [];
        if (view === 'cleaned') {
            return {
                state: {
                    all: trashNotifications.length,
                    open: 0,
                    closed: 0,
                    draft: 0,
                    done: 0,
                    needsReview: 0,
                    approved: 0,
                },
                author: { all: 0, committer: 0, external: 0 },
                audience: { all: 0, 'for-you': 0, 'for-others': 0 },
                interest: {
                    all: trashNotifications.length,
                    hasNew: 0,
                    noNew: 0,
                },
            };
        }

        const notifications = input.notifications || [];
        const viewNotifications = notifications.filter((notification) =>
            classifier.matchesView(notification, view)
        );
        const filters = input.viewFilters?.[view] || DEFAULT_VIEW_FILTERS[view] || {};
        const stateFilter = filters.state || 'all';
        const authorFilter = filters.author || 'all';
        const audienceFilter = filters.audience || 'all';

        const stateCounts = {
            all: 0,
            open: 0,
            closed: 0,
            draft: 0,
            done: 0,
            needsReview: 0,
            approved: 0,
        };
        const authorCounts = {
            all: 0,
            committer: 0,
            external: 0,
        };
        const audienceCounts = {
            all: 0,
            'for-you': 0,
            'for-others': 0,
        };

        const baseForStateCounts = view === 'others-prs'
            ? applyAuthorFilter(viewNotifications, authorFilter, classifier)
            : viewNotifications;
        const baseForAuthorCounts = view === 'others-prs'
            ? applyStateFilter(viewNotifications, stateFilter, classifier)
            : [];
        const baseForAudienceCounts = view === 'pr-notifications'
            ? applyStateFilter(viewNotifications, stateFilter, classifier)
            : [];

        stateCounts.all = baseForStateCounts.length;
        baseForStateCounts.forEach((notif) => {
            const notifState = notif.subject?.state;
            if (notifState === 'open' || notifState === 'draft') {
                stateCounts.open++;
            } else if (notifState === 'closed' || notifState === 'merged') {
                stateCounts.closed++;
            }
            if (notifState === 'draft') {
                stateCounts.draft++;
            }
            if (
                classifier.isNotificationDone(notif)
            ) {
                stateCounts.done++;
            }
            if (classifier.isNotificationNeedsReview(notif)) {
                stateCounts.needsReview++;
            }
            if (
                !classifier.isNotificationDone(notif) &&
                classifier.isNotificationApproved(notif)
            ) {
                stateCounts.approved++;
            }
        });

        if (view === 'others-prs') {
            authorCounts.all = baseForAuthorCounts.length;
            baseForAuthorCounts.forEach((notif) => {
                if (classifier.isNotificationFromCommitter(notif)) {
                    authorCounts.committer++;
                }
                if (classifier.isNotificationFromExternal(notif)) {
                    authorCounts.external++;
                }
            });
        }

        if (view === 'pr-notifications') {
            audienceCounts.all = viewNotifications.length;
            baseForAudienceCounts.forEach((notif) => {
                if (classifier.isNotificationDirectedAtCurrentUser(notif)) {
                    audienceCounts['for-you']++;
                } else {
                    audienceCounts['for-others']++;
                }
            });
        }

        let baseForInterestCounts = applyStateFilter(viewNotifications, stateFilter, classifier);
        if (view === 'others-prs') {
            baseForInterestCounts = applyAuthorFilter(baseForInterestCounts, authorFilter, classifier);
        }
        if (view === 'pr-notifications') {
            baseForInterestCounts = applyAudienceFilter(baseForInterestCounts, audienceFilter, classifier);
        }

        const interestCounts = { all: baseForInterestCounts.length, hasNew: 0, noNew: 0 };
        baseForInterestCounts.forEach((notif) => {
            if (classifier.getUninterestingReason(notif) !== null) {
                interestCounts.noNew++;
            } else {
                interestCounts.hasNew++;
            }
        });

        return {
            state: stateCounts,
            author: authorCounts,
            audience: audienceCounts,
            interest: interestCounts,
        };
    }

    function getMobileFilterOptions(view) {
        const options = [{ value: 'all', label: 'All' }];
        if (view === 'issues' || view === 'pr-notifications') {
            options.push({ value: 'open', label: 'Open' });
            options.push({ value: 'closed', label: 'Closed' });
        } else if (view === 'others-prs') {
            options.push({ value: 'needs-review', label: 'Needs review' });
            options.push({ value: 'approved', label: 'Approved' });
            options.push({ value: 'done', label: 'Done' });
        }
        return options;
    }

    return {
        DEFAULT_VIEW_FILTERS,
        DEFAULT_VIEW_ORDERS,
        VALID_ORDERS,
        applyAudienceFilter,
        applyAuthorFilter,
        applyInterestFilter,
        applyStateFilter,
        cloneDefaultViewFilters,
        getFilteredNotifications,
        getMobileFilterOptions,
        getSubfilterCounts,
        getViewCounts,
        makeClassifier,
        normalizeViewFilters,
        normalizeViewOrders,
        sortNotificationsBySize,
    };
});
