// Shared HTTP helpers for the notifications app.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxHttp = api;
    root.fetchGraphql = api.fetchGraphql;
    root.fetchJson = api.fetchJson;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    const SESSION_REFRESH_URL = 'login.html?session_refresh=1';
    const SESSION_EXPIRED_REDIRECT_DELAY_MS = 1500;
    const EXPIRED_BROWSER_SESSION_MESSAGE_PARTS = [
        'github redirected notifications request to login',
        'stored browser session is expired',
        'browser session is expired',
    ];

    function isExpiredBrowserSessionMessage(message) {
        const normalized = String(message || '').toLowerCase();
        return EXPIRED_BROWSER_SESSION_MESSAGE_PARTS.some(part => normalized.includes(part));
    }

    function isSessionExpiredResponse(response, parsed, message) {
        if (response.status !== 401) {
            return false;
        }
        const detail = parsed?.detail;
        if (detail?.error === 'session_expired' || parsed?.error === 'session_expired') {
            return true;
        }
        return isExpiredBrowserSessionMessage(message);
    }

    function appendResetAt(message, detail) {
        if (!detail || typeof detail !== 'object' || !detail.reset_at) {
            return message;
        }
        const resetAt = String(detail.reset_at);
        if (message.includes(resetAt)) {
            return message;
        }
        return `${message} Resets at ${resetAt}.`;
    }

    async function readErrorDetail(response) {
        const text = await response.text();
        const fallbackMessage = `HTTP ${response.status} ${response.statusText}`;
        if (!text) {
            return {
                detail: '',
                message: fallbackMessage,
                responseText: '',
                sessionExpired: false,
            };
        }
        try {
            const parsed = JSON.parse(text);
            const detail = parsed?.detail;
            let message = fallbackMessage;
            if (typeof detail === 'string') {
                message = detail;
            } else if (detail && typeof detail === 'object') {
                if (detail.message) {
                    message = String(detail.message);
                }
                message = appendResetAt(message, detail);
            } else if (parsed?.message) {
                message = String(parsed.message);
            } else {
                message = JSON.stringify(parsed);
            }
            const detailText = typeof detail === 'string' ? detail : JSON.stringify(parsed);
            return {
                detail: detailText,
                message,
                responseText: text,
                sessionExpired: isSessionExpiredResponse(response, parsed, message),
            };
        } catch (error) {
            return {
                detail: text,
                message: text,
                responseText: text,
                sessionExpired:
                    response.status === 401 && isExpiredBrowserSessionMessage(text),
            };
        }
    }

    function redirectToSessionRefresh() {
        if (root.location) {
            root.location.href = SESSION_REFRESH_URL;
        }
    }

    async function handleSessionExpired(options = {}) {
        const config = typeof options === 'string' ? { message: options } : options;
        const {
            delayMs = SESSION_EXPIRED_REDIRECT_DELAY_MS,
            message = 'Session expired.',
            scheduleOnly = false,
            state = null,
            throwError = true,
        } = config || {};
        const showStatus = config?.showStatus || root.showStatus;
        if (typeof showStatus === 'function') {
            showStatus(`${message} Redirecting to login...`, 'error');
        }
        if (state?.loginRedirectScheduled) {
            if (!throwError) {
                return;
            }
        } else {
            if (state) {
                state.loginRedirectScheduled = true;
            }
            if (scheduleOnly) {
                root.setTimeout(redirectToSessionRefresh, delayMs);
            } else {
                await new Promise((resolve) => root.setTimeout(resolve, delayMs));
                redirectToSessionRefresh();
            }
        }
        if (!throwError) {
            return;
        }
        const error = new Error('Session expired');
        error.sessionExpired = true;
        throw error;
    }

    async function fetchJson(url, options = {}) {
        const response = await root.fetch(url, options);
        if (!response.ok) {
            const { detail, message, sessionExpired } = await readErrorDetail(response);
            if (sessionExpired) {
                await handleSessionExpired();
            }
            const error = new Error(`Request failed: ${url} (${response.status}) ${message || detail}`);
            error.status = response.status;
            error.detail = detail;
            error.responseMessage = message;
            throw error;
        }
        return response.json();
    }

    async function fetchGraphql(query, variables) {
        const payload = await fetchJson('/github/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
        });
        if (payload?.data?.rateLimit && typeof root.updateGraphqlRateLimit === 'function') {
            root.updateGraphqlRateLimit(payload.data.rateLimit);
        } else if (
            payload?.extensions?.rateLimit &&
            typeof root.updateGraphqlRateLimit === 'function'
        ) {
            root.updateGraphqlRateLimit(payload.extensions.rateLimit);
        }
        if (Array.isArray(payload?.errors) && payload.errors.length) {
            const messages = payload.errors
                .map((error) => error?.message)
                .filter(Boolean)
                .join('; ');
            throw new Error(messages || 'GraphQL request failed');
        }
        return payload.data;
    }

    const api = {
        SESSION_EXPIRED_REDIRECT_DELAY_MS,
        SESSION_REFRESH_URL,
        fetchGraphql,
        fetchJson,
        handleSessionExpired,
        isExpiredBrowserSessionMessage,
        readErrorDetail,
    };
    return api;
});
