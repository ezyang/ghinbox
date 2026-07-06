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

    function parseRepoUrl(value) {
        const url = String(value || '');
        const apiMatch = url.match(/api\.github\.com\/repos\/([^/]+)\/([^/?#]+)/);
        if (apiMatch) {
            return {
                owner: apiMatch[1],
                repo: apiMatch[2],
                fullName: `${apiMatch[1]}/${apiMatch[2]}`,
            };
        }
        const webMatch = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
        if (webMatch) {
            return {
                owner: webMatch[1],
                repo: webMatch[2],
                fullName: `${webMatch[1]}/${webMatch[2]}`,
            };
        }
        return null;
    }

    function getRepoInfo(notification, fallback = null) {
        const fullName = notification?.repository?.full_name;
        const parsedFullName = fullName ? parseRepoInput(fullName) : null;
        if (parsedFullName) {
            return parsedFullName;
        }

        const parsedUrl = parseRepoUrl(notification?.subject?.url || notification?.url || '');
        if (parsedUrl) {
            return parsedUrl;
        }

        const parsedFallback = fallback
            ? parseRepoInput(fallback.fullName || `${fallback.owner}/${fallback.repo}`)
            : null;
        return parsedFallback || null;
    }

    function groupNotificationsByRepo(notifications) {
        const groups = new Map();
        (Array.isArray(notifications) ? notifications : []).forEach((notification) => {
            const repoInfo = getRepoInfo(notification);
            if (!repoInfo) {
                return;
            }
            if (!groups.has(repoInfo.fullName)) {
                groups.set(repoInfo.fullName, { repoInfo, notifications: [] });
            }
            groups.get(repoInfo.fullName).notifications.push(notification);
        });
        return Array.from(groups.values());
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
        groupNotificationsByRepo,
        parseRepoInput,
    };
});
