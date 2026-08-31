// Rate-limit box and request-log decisions: which requests get logged, how a
// log entry is summarized and classified, the log's trim/preserve policy, and
// the rate-limit summary text. DOM-free; Node tests import this. The fetch
// instrumentation and DOM rendering stay in notifications-core.js /
// notifications-sync.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxRateLimit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const LOG_MAX = 300;

    function shouldLogRequest(url) {
        if (!url) {
            return false;
        }
        return (
            url.startsWith('/github/') ||
            url.startsWith('/notifications/html')
        );
    }

    function getRequestKind(url) {
        const value = String(url || '');
        if (value.includes('/github/graphql')) {
            return 'GraphQL';
        }
        if (value.startsWith('/notifications/html')) {
            return 'App';
        }
        return 'REST';
    }

    function extractGraphqlSummary(body) {
        if (typeof body !== 'string') {
            return null;
        }
        let payload;
        try {
            payload = JSON.parse(body);
        } catch (error) {
            return null;
        }
        const query = typeof payload?.query === 'string' ? payload.query : '';
        const variables = payload?.variables && typeof payload.variables === 'object'
            ? Object.keys(payload.variables)
            : [];
        const compact = query.replace(/\s+/g, ' ').trim();
        if (!compact) {
            return null;
        }
        const opMatch = compact.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
        const operation = opMatch
            ? `${opMatch[1]} ${opMatch[2]}`
            : compact.startsWith('query')
                ? 'query'
                : compact.startsWith('mutation')
                    ? 'mutation'
                    : null;
        const rootMatch = compact.match(/\{\s*([A-Za-z0-9_]+)/);
        const rootField = rootMatch ? rootMatch[1] : null;
        const parts = [];
        if (operation) {
            parts.push(operation);
        }
        if (rootField) {
            parts.push(`root=${rootField}`);
        }
        if (variables.length) {
            parts.push(`vars=${variables.join(',')}`);
        }
        if (!parts.length) {
            parts.push(compact.slice(0, 80));
        }
        return parts.join(' ');
    }

    function buildLogEntry({
        id,
        startedAt,
        action,
        method,
        url,
        status,
        durationMs,
        requestBody = null,
        errorMessage = null,
    }) {
        const kind = getRequestKind(url);
        return {
            id,
            timeLabel: new Date(startedAt).toLocaleTimeString(),
            timestamp: startedAt,
            action,
            method: String(method || 'GET').toUpperCase(),
            url,
            kind,
            status,
            durationMs,
            detail: errorMessage !== null
                ? errorMessage
                : kind === 'GraphQL'
                    ? extractGraphqlSummary(requestBody)
                    : null,
        };
    }

    function appendLogEntry(log, entry, max = LOG_MAX) {
        log.push(entry);
        if (log.length > max) {
            log.splice(0, log.length - max);
        }
    }

    function getPreservedLogEntries(log, { preserveLatest = false, preserveSince = null } = {}) {
        if (Number.isFinite(preserveSince)) {
            return log.filter((entry) => entry.timestamp >= preserveSince);
        }
        if (preserveLatest) {
            const latest = log[log.length - 1];
            return latest ? [latest] : [];
        }
        return [];
    }

    function getLogStatusMessage(count, resetAtEpochSeconds) {
        if (count === 0) {
            return 'No rate limit requests logged yet.';
        }
        const resetAt = resetAtEpochSeconds
            ? new Date(resetAtEpochSeconds * 1000).toLocaleTimeString()
            : 'unknown';
        return `Logged ${count} request${count === 1 ? '' : 's'} until core resets @ ${resetAt}.`;
    }

    function formatRateLimit(rateLimit, error, graphqlRateLimit, graphqlError) {
        const parts = [];
        if (error) {
            parts.push(`core error: ${error}`);
        } else if (rateLimit?.resources?.core) {
            const core = rateLimit.resources.core;
            const resetAt = core.reset
                ? new Date(core.reset * 1000).toLocaleTimeString()
                : 'unknown';
            parts.push(`core ${core.remaining}/${core.limit} reset @ ${resetAt}`);
        } else {
            parts.push('core unknown');
        }

        if (graphqlError) {
            parts.push(`graphql error: ${graphqlError}`);
        } else if (graphqlRateLimit) {
            const resetAt = graphqlRateLimit.resetAt
                ? new Date(graphqlRateLimit.resetAt).toLocaleTimeString()
                : 'unknown';
            parts.push(
                `graphql ${graphqlRateLimit.remaining}/${graphqlRateLimit.limit} reset @ ${resetAt}`
            );
        } else {
            parts.push('graphql unknown');
        }

        return `Rate limit: ${parts.join(' | ')}`;
    }

    return {
        LOG_MAX,
        appendLogEntry,
        buildLogEntry,
        extractGraphqlSummary,
        formatRateLimit,
        getLogStatusMessage,
        getPreservedLogEntries,
        getRequestKind,
        shouldLogRequest,
    };
});
