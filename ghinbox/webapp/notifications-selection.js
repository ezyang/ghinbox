// Selection and keyboard-cursor decisions: shift-click ranges, active-item
// movement/repair, and which notifications the bulk actions target. DOM-free;
// Node tests import this. The DOM wiring stays in notifications-ui.js and
// notifications-actions.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    // Ids covered by a shift-click from fromId to toId (inclusive, either
    // direction), or null when either end is not in the list.
    function getRangeIds(fromId, toId, ids) {
        const fromIndex = ids.indexOf(fromId);
        const toIndex = ids.indexOf(toId);
        if (fromIndex === -1 || toIndex === -1) {
            return null;
        }
        const start = Math.min(fromIndex, toIndex);
        const end = Math.max(fromIndex, toIndex);
        return ids.slice(start, end + 1);
    }

    // Where the keyboard cursor lands after moving by delta. A cursor that is
    // not in the list enters from the top (moving down) or bottom (moving up).
    function getNextActiveId(ids, activeId, delta) {
        if (ids.length === 0) {
            return null;
        }
        let index = ids.indexOf(activeId);
        if (index === -1) {
            index = delta > 0 ? -1 : ids.length;
        }
        const nextIndex = Math.min(ids.length - 1, Math.max(0, index + delta));
        return ids[nextIndex];
    }

    // Repair the cursor after the visible list changed: clear it when the list
    // is empty, snap to the first item when the current target disappeared,
    // and leave an unset cursor unset.
    function ensureActiveId(ids, activeId) {
        if (ids.length === 0) {
            return null;
        }
        if (!activeId) {
            return activeId;
        }
        return ids.includes(activeId) ? activeId : ids[0];
    }

    // Move the cursor off an item that is about to be removed: prefer the next
    // item, then the previous, else clear. A cursor elsewhere is untouched.
    function getActiveIdAfterRemoval(ids, removedId, activeId) {
        if (activeId !== removedId) {
            return activeId;
        }
        const index = ids.indexOf(removedId);
        if (index === -1) {
            return activeId;
        }
        if (index + 1 < ids.length) {
            return ids[index + 1];
        }
        if (index > 0) {
            return ids[index - 1];
        }
        return null;
    }

    function getMarkDoneTargets({ view, selectedIds, notifications, canArchive }) {
        if (view === 'cleaned') {
            return {
                ids: [],
                label: 'Mark selected as done',
                show: false,
            };
        }
        const actionableNotifications = notifications.filter(canArchive);
        if (selectedIds.length > 0) {
            const actionableSelected = selectedIds.filter((id) => {
                const notif = notifications.find((item) => item.id === id);
                return Boolean(notif) && canArchive(notif);
            });
            return {
                ids: actionableSelected,
                label: 'Mark selected as done',
                show: actionableSelected.length > 0,
            };
        }
        if (actionableNotifications.length > 0) {
            return {
                ids: actionableNotifications.map((notif) => notif.id),
                label: 'Mark all as done',
                show: true,
            };
        }
        return {
            ids: [],
            label: 'Mark selected as done',
            show: false,
        };
    }

    // Only offered when nothing is selected and the approved filter is active.
    function getUnsubscribeAllTargets({ view, hasSelection, stateFilter, notifications }) {
        if (view === 'cleaned' || hasSelection) {
            return { ids: [], show: false };
        }
        if (stateFilter === 'approved' && notifications.length > 0) {
            return {
                ids: notifications.map((notif) => notif.id),
                show: true,
            };
        }
        return { ids: [], show: false };
    }

    function getOpenAllTargets(notifications) {
        const openableNotifications = notifications.filter(
            (notif) => notif.subject && notif.subject.url
        );
        return {
            notifications: openableNotifications,
            show: openableNotifications.length > 0,
        };
    }

    return {
        ensureActiveId,
        getActiveIdAfterRemoval,
        getMarkDoneTargets,
        getNextActiveId,
        getOpenAllTargets,
        getRangeIds,
        getUnsubscribeAllTargets,
    };
});
