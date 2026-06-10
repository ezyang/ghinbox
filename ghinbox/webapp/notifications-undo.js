// Pure undo-stack logic: single-entry stack ops, expiry, undo-action mapping,
// token grouping, ordered re-insertion, and undo status message selection.
// Browser code passes state arrays/timestamps in; Node tests import this file.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxUndo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const UNDO_EXPIRY_MS = 30000;

    function pushEntry(stack, action, notifications, timestamp) {
        const normalizedNotifications = Array.isArray(notifications)
            ? notifications
            : [notifications];
        if (normalizedNotifications.length === 0) {
            return null;
        }
        const entry = {
            action,
            notifications: normalizedNotifications,
            timestamp,
        };
        // Keep only the most recent undo (single action undo)
        stack.length = 0;
        stack.push(entry);
        return entry;
    }

    function removeEntry(stack, entry) {
        if (!entry) {
            return;
        }
        const index = stack.indexOf(entry);
        if (index !== -1) {
            stack.splice(index, 1);
        }
    }

    function updateEntry(stack, entry, notifications) {
        if (!entry) {
            return;
        }
        const normalizedNotifications = Array.isArray(notifications)
            ? notifications
            : [notifications];
        if (normalizedNotifications.length === 0) {
            removeEntry(stack, entry);
            return;
        }
        entry.notifications = normalizedNotifications;
    }

    function isExpired(entry, nowMs) {
        return nowMs - entry.timestamp > UNDO_EXPIRY_MS;
    }

    function getUndoAction(action) {
        return action === 'done' ? 'unarchive' : 'subscribe';
    }

    // Group notifications by the authenticity token needed to undo them.
    // Returns { groups: Map<token, notifications[]>, missingToken: boolean }.
    function groupByToken(notifications, action, fallbackToken) {
        const groups = new Map();
        let missingToken = false;
        notifications.forEach((notification) => {
            const token =
                (notification &&
                    notification.ui &&
                    notification.ui.action_tokens &&
                    notification.ui.action_tokens[action]) ||
                fallbackToken;
            if (!token) {
                missingToken = true;
                return;
            }
            const group = groups.get(token) || [];
            group.push(notification);
            groups.set(token, group);
        });
        return { groups, missingToken };
    }

    function getCompletionStatus({ restoredCount, failedCount, errorDetail }) {
        if (failedCount === 0) {
            return {
                message: `Undo successful: restored ${restoredCount} notification${
                    restoredCount !== 1 ? 's' : ''
                }`,
                type: 'success',
                autoDismiss: true,
            };
        }
        const detailSuffix = errorDetail ? ` (${errorDetail})` : '';
        return {
            message: `Undo failed: restored ${restoredCount}, failed ${failedCount}${detailSuffix}`,
            type: 'error',
            autoDismiss: false,
        };
    }

    // Insert notifications back into a list kept sorted by updated_at descending.
    // Mutates and returns the list.
    function insertByUpdatedAt(list, notifications) {
        const notificationsToRestore = notifications
            .slice()
            .sort(
                (a, b) =>
                    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
            );
        notificationsToRestore.forEach((notification) => {
            const insertIndex = list.findIndex(
                (existing) => new Date(existing.updated_at) < new Date(notification.updated_at)
            );
            if (insertIndex === -1) {
                list.push(notification);
            } else {
                list.splice(insertIndex, 0, notification);
            }
        });
        return list;
    }

    return {
        UNDO_EXPIRY_MS,
        getCompletionStatus,
        getUndoAction,
        groupByToken,
        insertByUpdatedAt,
        isExpired,
        pushEntry,
        removeEntry,
        updateEntry,
    };
});
