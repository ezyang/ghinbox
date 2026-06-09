// Notification identity, repo, cache-key, and dedup-key helpers.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxNotificationIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function parseRepoInput(value) {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
            return null;
        }
        const parts = trimmed.split('/');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            return null;
        }
        return {
            owner: parts[0],
            repo: parts[1],
            fullName: `${parts[0]}/${parts[1]}`,
        };
    }

    function getRepoInfo(notification, fallback = null) {
        const fullName = notification?.repository?.full_name;
        const parsedFullName = fullName ? parseRepoInput(fullName) : null;
        if (parsedFullName) {
            return parsedFullName;
        }

        const url = String(notification?.subject?.url || notification?.url || '');
        const match = url.match(/github\.com\/([^/]+)\/([^/]+)\//);
        if (match) {
            return {
                owner: match[1],
                repo: match[2],
                fullName: `${match[1]}/${match[2]}`,
            };
        }

        const parsedFallback = fallback
            ? parseRepoInput(fallback.fullName || `${fallback.owner}/${fallback.repo}`)
            : null;
        return parsedFallback || null;
    }

    function getNotificationKey(notification) {
        return String(notification?.id || '');
    }

    function getIssueNumber(notification) {
        const number = notification?.subject?.number;
        return typeof number === 'number' ? number : null;
    }

    function getNotificationMatchKeyForRepo(notification, repo) {
        const number = getIssueNumber(notification);
        const type = notification?.subject?.type || 'unknown';
        const resolvedRepo = repo || getRepoInfo(notification);
        if (resolvedRepo && typeof number === 'number') {
            return `${resolvedRepo.owner}/${resolvedRepo.repo}:${type}:${number}`;
        }
        return `id:${getNotificationKey(notification)}`;
    }

    function getNotificationMatchKey(notification) {
        return getNotificationMatchKeyForRepo(notification, null);
    }

    function getNotificationDedupKey(notification) {
        return getNotificationMatchKey(notification) || getNotificationKey(notification);
    }

    function getRestNotificationMatchKey(notification) {
        const repo = notification?.repository?.full_name;
        const type = notification?.subject?.type || 'unknown';
        const url = notification?.subject?.url || '';
        const match = url.match(/\/(issues|pulls?)\/(\d+)/);
        if (!repo || !match) {
            return null;
        }
        return `${repo}:${type}:${match[2]}`;
    }

    return {
        getIssueNumber,
        getNotificationDedupKey,
        getNotificationKey,
        getNotificationMatchKey,
        getNotificationMatchKeyForRepo,
        getRepoInfo,
        getRestNotificationMatchKey,
        parseRepoInput,
    };
});
