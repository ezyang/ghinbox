// Shared auth cache helpers for notification UI scripts.
(function () {
    const AUTH_CACHE_KEY =
        globalThis.GhinboxViewState?.STORAGE_KEYS?.authCache || 'ghnotif_auth_cache';
    const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;

    function readCachedAuth({ enforceTtl = true } = {}) {
        try {
            const raw = localStorage.getItem(AUTH_CACHE_KEY);
            if (!raw) {
                return null;
            }
            const cached = JSON.parse(raw);
            if (!cached || typeof cached !== 'object') {
                return null;
            }
            if (enforceTtl && !Number.isFinite(cached.timestamp)) {
                return null;
            }
            if (enforceTtl && Date.now() - cached.timestamp > AUTH_CACHE_TTL_MS) {
                return null;
            }
            return cached;
        } catch (error) {
            return null;
        }
    }

    function getCachedAuth() {
        return readCachedAuth({ enforceTtl: true });
    }

    function setCachedAuth(login) {
        try {
            localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
                login,
                timestamp: Date.now(),
            }));
        } catch (error) {
            // Ignore storage errors.
        }
    }

    function applyCachedAuth(cached) {
        if (!elements?.authStatus) {
            return;
        }
        if (cached && cached.login) {
            elements.authStatus.textContent = `Signed in as ${cached.login}`;
            elements.authStatus.className = 'auth-status authenticated';
            state.currentUserLogin = cached.login;
            return;
        }
        if (cached) {
            elements.authStatus.textContent = 'Not authenticated';
            elements.authStatus.className = 'auth-status error';
            state.currentUserLogin = null;
            return;
        }
        elements.authStatus.textContent = '';
        elements.authStatus.className = 'auth-status';
        state.currentUserLogin = null;
    }

    applyCachedAuth(readCachedAuth({ enforceTtl: false }));

    globalThis.getCachedAuth = getCachedAuth;
    globalThis.setCachedAuth = setCachedAuth;
    globalThis.applyCachedAuth = applyCachedAuth;
})();
