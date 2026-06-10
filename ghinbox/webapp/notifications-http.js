// Shared HTTP helpers for the notifications app.
(function (root) {
    const SESSION_REFRESH_URL = '/app/login.html?session_refresh=1';

    async function readErrorDetail(response) {
        const text = await response.text();
        if (!text) {
            return { detail: '' };
        }
        try {
            const parsed = JSON.parse(text);
            return {
                detail:
                    typeof parsed?.detail === 'string'
                        ? parsed.detail
                        : JSON.stringify(parsed),
                sessionExpired:
                    response.status === 401 &&
                    parsed?.detail?.error === 'session_expired',
            };
        } catch (error) {
            return { detail: text };
        }
    }

    async function handleSessionExpired() {
        if (typeof root.showStatus === 'function') {
            root.showStatus('Session expired. Redirecting to login...', 'error');
        }
        await new Promise((resolve) => root.setTimeout(resolve, 1500));
        if (root.location) {
            root.location.href = SESSION_REFRESH_URL;
        }
        const error = new Error('Session expired');
        error.sessionExpired = true;
        throw error;
    }

    async function fetchJson(url, options = {}) {
        const response = await root.fetch(url, options);
        if (!response.ok) {
            const { detail, sessionExpired } = await readErrorDetail(response);
            if (sessionExpired) {
                await handleSessionExpired();
            }
            const error = new Error(`Request failed: ${url} (${response.status}) ${detail}`);
            error.status = response.status;
            error.detail = detail;
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
        fetchGraphql,
        fetchJson,
        handleSessionExpired,
        readErrorDetail,
    };

    root.GhinboxHttp = api;
    root.fetchGraphql = fetchGraphql;
    root.fetchJson = fetchJson;
})(typeof globalThis !== 'undefined' ? globalThis : this);
