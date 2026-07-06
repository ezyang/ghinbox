// Pure status-bar precedence and dismiss-policy state machine.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxStatusBar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DEFAULT_FLASH_DURATION_MS = 500;
    const DEFAULT_AUTO_DISMISS_MS = 1500;

    function cloneStatus(status) {
        return status ? { ...status } : null;
    }

    function normalizeCounter(value) {
        return Number.isFinite(value) ? value : 0;
    }

    function normalizeState(current) {
        const state = current || {};
        return {
            statusState: cloneStatus(state.statusState),
            lastPersistentStatus: cloneStatus(state.lastPersistentStatus),
            statusFlashId: normalizeCounter(state.statusFlashId),
            statusAutoDismissId: normalizeCounter(state.statusAutoDismissId),
        };
    }

    function result(state, effects) {
        return { state, effects };
    }

    function statusState(message, type, isFlash, flashId) {
        return {
            message,
            type,
            isFlash,
            flashId,
            autoDismiss: false,
        };
    }

    function getShowSettings(options) {
        const settings = options || {};
        const flash = Boolean(settings.flash);
        const autoDismiss = Boolean(settings.autoDismiss) && !flash;
        const flashDurationMs = Number.isFinite(settings.durationMs)
            ? settings.durationMs
            : DEFAULT_FLASH_DURATION_MS;
        const autoDismissDurationMs = Number.isFinite(settings.autoDismissMs)
            ? settings.autoDismissMs
            : (Number.isFinite(settings.durationMs)
                ? settings.durationMs
                : DEFAULT_AUTO_DISMISS_MS);
        return {
            autoDismiss,
            autoDismissDurationMs,
            flash,
            flashDurationMs,
        };
    }

    function showStatus(current, request) {
        const state = normalizeState(current);
        const message = request.message;
        const type = request.type;
        const settings = getShowSettings(request.options);

        if (
            settings.flash &&
            state.statusState &&
            !state.statusState.isFlash &&
            state.statusState.type !== 'info'
        ) {
            return result(state, []);
        }

        const effects = [
            { type: 'cancelAutoDismissTimer' },
            { type: 'clearAutoDismissVisual' },
            { type: 'cancelFlashTimer' },
        ];
        const flashId = settings.flash ? state.statusFlashId + 1 : null;
        const next = {
            ...state,
            statusFlashId: settings.flash ? flashId : state.statusFlashId,
            statusState: statusState(message, type, settings.flash, flashId),
        };
        effects.push({ type: 'setStatus', status: cloneStatus(next.statusState) });

        if (!settings.flash && !settings.autoDismiss) {
            next.lastPersistentStatus = { message, type };
            return result(next, effects);
        }

        if (settings.autoDismiss) {
            const autoDismissId = state.statusAutoDismissId + 1;
            next.lastPersistentStatus = null;
            next.statusAutoDismissId = autoDismissId;
            next.statusState.autoDismiss = true;
            effects.push({
                type: 'setAutoDismissVisual',
                durationMs: settings.autoDismissDurationMs,
            });
            effects.push({
                type: 'scheduleAutoDismiss',
                autoDismissId,
                durationMs: settings.autoDismissDurationMs,
            });
            return result(next, effects);
        }

        effects.push({
            type: 'scheduleFlashClear',
            flashId,
            durationMs: settings.flashDurationMs,
        });
        return result(next, effects);
    }

    function clearAutoDismiss(current) {
        const state = normalizeState(current);
        return result(state, [
            { type: 'cancelAutoDismissTimer' },
            { type: 'clearAutoDismissVisual' },
        ]);
    }

    function freezeAutoDismiss(current) {
        const state = normalizeState(current);
        if (state.statusState) {
            state.statusState.autoDismiss = false;
        }
        return result(state, [
            { type: 'cancelAutoDismissTimer' },
            { type: 'clearAutoDismissVisual' },
            { type: 'setPinnedVisual' },
        ]);
    }

    function clearStatus(current) {
        const state = normalizeState(current);
        return result({
            ...state,
            statusState: null,
            lastPersistentStatus: null,
        }, [
            { type: 'cancelFlashTimer' },
            { type: 'cancelAutoDismissTimer' },
            { type: 'clearAutoDismissVisual' },
            { type: 'clearPinnedVisual' },
            { type: 'clearStatus' },
        ]);
    }

    function flashTimerFired(current, flashId) {
        const state = normalizeState(current);
        if (!state.statusState || state.statusState.flashId !== flashId) {
            return result(state, []);
        }

        const last = state.lastPersistentStatus;
        if (last) {
            const effects = [{ type: 'cancelFlashTimer' }];
            const next = {
                ...state,
                statusState: statusState(last.message, last.type, false, null),
            };
            effects.push({ type: 'setStatus', status: cloneStatus(next.statusState) });
            return result(next, effects);
        }

        return clearStatus(state);
    }

    function autoDismissTimerFired(current, autoDismissId) {
        const state = normalizeState(current);
        if (!state.statusState || state.statusAutoDismissId !== autoDismissId) {
            return result(state, []);
        }
        return clearStatus(state);
    }

    return {
        DEFAULT_AUTO_DISMISS_MS,
        DEFAULT_FLASH_DURATION_MS,
        autoDismissTimerFired,
        clearAutoDismiss,
        clearStatus,
        flashTimerFired,
        freezeAutoDismiss,
        showStatus,
    };
});
