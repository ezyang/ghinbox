// Presentation mapping decisions for notification rows: relative-time
// buckets, reason labels, state badge label/class, icon selection, and the
// diffstat hue scale. DOM-free; Node tests import this. HTML construction
// stays in notifications-ui.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function formatRelativeTime(dateString, nowMs = Date.now()) {
        const date = new Date(dateString);
        const diffMs = nowMs - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        const diffWeeks = Math.floor(diffDays / 7);
        const diffMonths = Math.floor(diffDays / 30);
        const diffYears = Math.floor(diffDays / 365);

        if (diffSecs < 60) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        if (diffWeeks < 4) return `${diffWeeks}w ago`;
        if (diffMonths < 12) return `${diffMonths}mo ago`;
        return `${diffYears}y ago`;
    }

    const REASON_LABELS = {
        'author': 'Author',
        'comment': 'Comment',
        'mention': 'Mentioned',
        'review_requested': 'Review requested',
        'subscribed': 'Subscribed',
        'team_mention': 'Team mentioned',
        'assign': 'Assigned',
        'state_change': 'State change',
        'ci_activity': 'CI activity',
    };

    function formatReason(reason) {
        return REASON_LABELS[reason] || reason;
    }

    // Badge label and CSS class for a notification subject, or null when the
    // subject has no state.
    function getStateBadgeInfo(subject) {
        const type = subject?.type;
        const state = subject?.state;
        const stateReason = subject?.state_reason;

        if (!state) return null;

        let label = state.charAt(0).toUpperCase() + state.slice(1);
        let cssClass = state;

        if (state === 'closed' && stateReason === 'completed') {
            cssClass = 'closed completed';
        }

        if (type === 'PullRequest' && state === 'merged') {
            label = 'Merged';
        }

        return { label, cssClass, state };
    }

    // Key into the SVG icon map for a notification subject.
    function getNotificationIconName(subject) {
        const type = subject?.type;
        const state = subject?.state;
        const stateReason = subject?.state_reason;

        if (type === 'Issue') {
            if (state === 'closed') {
                if (stateReason === 'not_planned') return 'issueNotPlanned';
                return 'issueClosed';
            }
            return 'issue';
        }
        if (type === 'PullRequest') {
            if (state === 'merged') return 'prMerged';
            if (state === 'closed') return 'prClosed';
            if (state === 'draft') return 'prDraft';
            return 'pr';
        }
        if (type === 'Discussion') return 'discussion';
        if (type === 'Commit') return 'commit';
        if (type === 'Release') return 'release';
        return 'issue'; // fallback
    }

    function getIconStateClass(subject) {
        const state = subject?.state;
        if (state === 'merged') return 'merged';
        if (state === 'closed') return 'closed';
        if (state === 'draft') return 'draft';
        return 'open';
    }

    // Hue from green (smallest diff in range) to red (largest); flat ranges
    // sit at yellow. Null when the range is empty.
    function getDiffstatHue(total, range) {
        if (!range || range.min === null || range.max === null) {
            return null;
        }
        if (range.min === range.max) {
            return 60;
        }
        const scale = (total - range.min) / (range.max - range.min);
        return Math.round(120 * (1 - scale));
    }

    return {
        formatReason,
        formatRelativeTime,
        getDiffstatHue,
        getIconStateClass,
        getNotificationIconName,
        getStateBadgeInfo,
    };
});
