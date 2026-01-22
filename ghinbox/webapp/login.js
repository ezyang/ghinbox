/**
 * Login page JavaScript for headless GitHub authentication.
 *
 * Handles the login flow with the server's /auth/login/* endpoints.
 */

(function() {
    'use strict';

    // State
    let sessionId = null;
    let currentAccount = 'default';

    // DOM Elements
    const elements = {
        credentialsForm: document.getElementById('credentials-form'),
        twofaForm: document.getElementById('twofa-form'),
        mobileWaitForm: document.getElementById('mobile-wait-form'),
        usernameInput: document.getElementById('username'),
        passwordInput: document.getElementById('password'),
        twofaCodeInput: document.getElementById('twofa-code'),
        twofaHint: document.getElementById('twofa-hint'),
        backToLoginBtn: document.getElementById('back-to-login'),
        backToLoginMobileBtn: document.getElementById('back-to-login-mobile'),
        statusMessage: document.getElementById('status-message'),
        loading: document.getElementById('loading'),
        loadingText: document.getElementById('loading-text'),
        successState: document.getElementById('success-state'),
        successUsername: document.getElementById('success-username'),
        verificationCodeDisplay: document.getElementById('verification-code-display'),
        verificationCodeNumber: document.getElementById('verification-code-number'),
    };

    // Helper functions

    function showError(message) {
        elements.statusMessage.textContent = message;
        elements.statusMessage.className = 'status-message error';
        elements.statusMessage.hidden = false;
    }

    function showWarning(message) {
        elements.statusMessage.textContent = message;
        elements.statusMessage.className = 'status-message warning';
        elements.statusMessage.hidden = false;
    }

    function hideStatus() {
        elements.statusMessage.hidden = true;
    }

    function showLoading(text) {
        elements.loadingText.textContent = text || 'Loading...';
        elements.loading.hidden = false;
    }

    function hideLoading() {
        elements.loading.hidden = true;
    }

    function showCredentialsForm() {
        elements.credentialsForm.hidden = false;
        elements.twofaForm.hidden = true;
        if (elements.mobileWaitForm) elements.mobileWaitForm.hidden = true;
        elements.successState.hidden = true;
        hideLoading();
    }

    function showTwofaForm(method) {
        elements.credentialsForm.hidden = true;
        elements.twofaForm.hidden = false;
        if (elements.mobileWaitForm) elements.mobileWaitForm.hidden = true;
        elements.successState.hidden = true;
        hideLoading();

        // Update hint based on method
        if (method === 'sms') {
            elements.twofaHint.textContent = 'Enter the code sent to your phone';
        } else {
            elements.twofaHint.textContent = 'Open your authenticator app to view your code';
        }

        // Focus the 2FA input
        elements.twofaCodeInput.value = '';
        elements.twofaCodeInput.focus();
    }

    function showMobileWaitForm(verificationCode) {
        elements.credentialsForm.hidden = true;
        elements.twofaForm.hidden = true;
        if (elements.mobileWaitForm) elements.mobileWaitForm.hidden = false;
        elements.successState.hidden = true;
        hideLoading();

        // Display verification code if provided
        if (verificationCode && elements.verificationCodeDisplay && elements.verificationCodeNumber) {
            elements.verificationCodeNumber.textContent = verificationCode;
            elements.verificationCodeDisplay.hidden = false;
        } else if (elements.verificationCodeDisplay) {
            elements.verificationCodeDisplay.hidden = true;
        }
    }

    async function showSuccess(username) {
        elements.credentialsForm.hidden = true;
        elements.twofaForm.hidden = true;
        if (elements.mobileWaitForm) elements.mobileWaitForm.hidden = true;
        elements.successState.hidden = false;
        hideLoading();
        hideStatus();

        elements.successUsername.textContent = username ? `Signed in as ${username}` : '';

        // Reload auth to initialize the fetcher
        try {
            await fetchJson('/auth/reload', { method: 'POST' });
        } catch (e) {
            console.warn('Failed to reload auth:', e);
            // Continue with redirect anyway
        }

        // Redirect after a short delay
        setTimeout(() => {
            window.location.href = '/app/';
        }, 1500);
    }

    function setFormDisabled(form, disabled) {
        const inputs = form.querySelectorAll('input, button');
        inputs.forEach(el => {
            el.disabled = disabled;
        });
    }

    async function fetchJson(url, options = {}) {
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            ...options,
        });

        const data = await response.json();

        if (!response.ok && !data.status) {
            throw new Error(data.detail || `Request failed: ${response.status}`);
        }

        return data;
    }

    // API calls

    async function startLoginSession() {
        return await fetchJson('/auth/login/start', {
            method: 'POST',
            body: JSON.stringify({ account: currentAccount }),
        });
    }

    async function submitCredentials(username, password) {
        return await fetchJson('/auth/login/credentials', {
            method: 'POST',
            body: JSON.stringify({
                session_id: sessionId,
                username,
                password,
            }),
        });
    }

    async function submit2fa(code) {
        return await fetchJson('/auth/login/2fa', {
            method: 'POST',
            body: JSON.stringify({
                session_id: sessionId,
                code,
            }),
        });
    }

    async function waitForMobileApproval(timeoutSeconds = 120) {
        return await fetchJson('/auth/login/mobile-wait', {
            method: 'POST',
            body: JSON.stringify({
                session_id: sessionId,
                timeout_seconds: timeoutSeconds,
            }),
        });
    }

    async function cancelLogin() {
        if (sessionId) {
            try {
                await fetchJson('/auth/login/cancel', {
                    method: 'POST',
                    body: JSON.stringify({ session_id: sessionId }),
                });
            } catch (e) {
                // Ignore errors on cancel
            }
            sessionId = null;
        }
    }

    async function checkNeedsLogin() {
        try {
            const response = await fetchJson('/auth/needs-login');
            return response;
        } catch (e) {
            return { needs_login: true, account: 'default' };
        }
    }

    // Event handlers

    async function handleCredentialsSubmit(event) {
        event.preventDefault();
        hideStatus();

        const username = elements.usernameInput.value.trim();
        const password = elements.passwordInput.value;

        if (!username || !password) {
            showError('Please enter both username and password');
            return;
        }

        setFormDisabled(elements.credentialsForm, true);
        showLoading('Starting login session...');

        try {
            // Start a new session if we don't have one
            if (!sessionId) {
                const startResponse = await startLoginSession();
                if (startResponse.status === 'error') {
                    throw new Error(startResponse.error || 'Failed to start login session');
                }
                sessionId = startResponse.session_id;
            }

            showLoading('Submitting credentials...');

            // Submit credentials
            const response = await submitCredentials(username, password);

            // Handle response
            if (response.status === 'success') {
                await showSuccess(response.username);
            } else if (response.status === 'waiting_2fa') {
                showTwofaForm(response.twofa_method);
            } else if (response.status === 'waiting_mobile') {
                // Start mobile 2FA wait flow
                handleMobileWait(response.verification_code);
            } else if (response.status === 'captcha') {
                showError(response.error || 'CAPTCHA required. Please use --headed-login flag on server.');
                sessionId = null;
                setFormDisabled(elements.credentialsForm, false);
                hideLoading();
            } else if (response.status === 'error') {
                showError(response.error || 'Login failed');
                sessionId = null;
                setFormDisabled(elements.credentialsForm, false);
                hideLoading();
            } else {
                showError('Unexpected response from server');
                sessionId = null;
                setFormDisabled(elements.credentialsForm, false);
                hideLoading();
            }
        } catch (error) {
            showError(error.message || 'An error occurred');
            sessionId = null;
            setFormDisabled(elements.credentialsForm, false);
            hideLoading();
        }
    }

    async function handleTwofaSubmit(event) {
        event.preventDefault();
        hideStatus();

        const code = elements.twofaCodeInput.value.trim();

        if (!code) {
            showError('Please enter your 2FA code');
            return;
        }

        if (!sessionId) {
            showError('Session expired. Please start over.');
            showCredentialsForm();
            return;
        }

        setFormDisabled(elements.twofaForm, true);
        showLoading('Verifying code...');

        try {
            const response = await submit2fa(code);

            if (response.status === 'success') {
                await showSuccess(response.username);
            } else if (response.status === 'waiting_2fa') {
                // Wrong code, let them try again
                showError(response.error || 'Invalid code, please try again');
                elements.twofaCodeInput.value = '';
                elements.twofaCodeInput.focus();
                setFormDisabled(elements.twofaForm, false);
                hideLoading();
            } else if (response.status === 'error') {
                showError(response.error || '2FA verification failed');
                setFormDisabled(elements.twofaForm, false);
                hideLoading();
            }
        } catch (error) {
            showError(error.message || 'An error occurred');
            setFormDisabled(elements.twofaForm, false);
            hideLoading();
        }
    }

    async function handleBackToLogin() {
        await cancelLogin();
        hideStatus();
        showCredentialsForm();
        elements.passwordInput.value = '';
        setFormDisabled(elements.credentialsForm, false);
    }

    async function handleMobileWait(verificationCode) {
        showMobileWaitForm(verificationCode);
        hideStatus();

        try {
            const response = await waitForMobileApproval(120);

            if (response.status === 'success') {
                await showSuccess(response.username);
            } else if (response.status === 'error') {
                showError(response.error || 'Mobile approval failed or timed out');
                showCredentialsForm();
                elements.passwordInput.value = '';
                setFormDisabled(elements.credentialsForm, false);
                sessionId = null;
            } else if (response.status === 'waiting_mobile') {
                // Still waiting (timed out on server side)
                showError(response.error || 'Mobile approval timed out. Please try again.');
                showCredentialsForm();
                elements.passwordInput.value = '';
                setFormDisabled(elements.credentialsForm, false);
                sessionId = null;
            }
        } catch (error) {
            showError(error.message || 'An error occurred while waiting for approval');
            showCredentialsForm();
            elements.passwordInput.value = '';
            setFormDisabled(elements.credentialsForm, false);
            sessionId = null;
        }
    }

    // Initialize

    async function init() {
        // Check for session_refresh param - if present, we need to refresh the browser
        // session even if the auth file exists (token valid but cookies expired)
        const urlParams = new URLSearchParams(window.location.search);
        const sessionRefresh = urlParams.get('session_refresh') === '1';

        // Check if we actually need to login (skip if session_refresh requested)
        if (!sessionRefresh) {
            try {
                const authStatus = await checkNeedsLogin();
                if (!authStatus.needs_login) {
                    // Already logged in, redirect
                    window.location.href = '/app/';
                    return;
                }
                currentAccount = authStatus.account || 'default';
            } catch (e) {
                // Proceed with login anyway
            }
        }

        // Set up event listeners
        elements.credentialsForm.addEventListener('submit', handleCredentialsSubmit);
        elements.twofaForm.addEventListener('submit', handleTwofaSubmit);
        elements.backToLoginBtn.addEventListener('click', handleBackToLogin);
        if (elements.backToLoginMobileBtn) {
            elements.backToLoginMobileBtn.addEventListener('click', handleBackToLogin);
        }

        // Focus username input
        elements.usernameInput.focus();
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
