// Background freshness: periodic server-snapshot pulls and the Feed digest panel.
(function () {
    const panel = document.getElementById('digest-panel');
    let digest = null;
    let digestProfileId = null;
    let digestWhy = new Map();
    let replyDemotions = new Map();
    let reviewVerdicts = new Map();
    let digestPollTimer = null;
    let backgroundTimer = null;
    let openAllItems = [];

    function digestUrl(profileId, suffix = '') {
        return `/api/digest/${encodeURIComponent(profileId)}${suffix}`;
    }

    function scheduleDigestPoll() {
        clearTimeout(digestPollTimer);
        digestPollTimer = null;
        if (digest?.status === 'running') {
            digestPollTimer = setTimeout(
                refreshDigest,
                GhinboxDigest.DIGEST_POLL_WHILE_RUNNING_MS
            );
        }
    }

    async function refreshDigest() {
        if (!panel) {
            return;
        }
        const profileId = state.profileId;
        try {
            const response = await fetch(digestUrl(profileId));
            const data = response.ok ? await response.json() : null;
            if (profileId !== state.profileId) {
                return;
            }
            digest = data;
            digestProfileId = profileId;
            digestWhy = GhinboxDigest.digestWhyById(data);
            replyDemotions = GhinboxDigest.replyDemotionsById(data);
            reviewVerdicts = GhinboxDigest.reviewVerdictsByPr(data);
        } catch (error) {
            console.error('Failed to load feed digest:', error);
        }
        // Full render: list rows carry the "worth a look" annotations.
        render();
        scheduleDigestPoll();
    }

    async function handleDigestRefresh() {
        try {
            await fetchJson(digestUrl(state.profileId, '/run'), { method: 'POST' });
        } catch (error) {
            showStatus(`Digest refresh failed: ${error.message || error}`, 'error');
            return;
        }
        await refreshDigest();
    }

    function makeLink(item, text) {
        const link = document.createElement('a');
        link.href = item.url || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = text;
        return link;
    }

    function itemLabel(item) {
        const repo = item.repo ? item.repo.replace(/^pytorch\//, '') : '';
        return item.number ? `${repo}#${item.number}` : repo;
    }

    function getDigestWhy(notificationId) {
        return digestProfileId === state.profileId
            ? digestWhy.get(String(notificationId)) || ''
            : '';
    }

    function getDigestReplyDemotions() {
        return digestProfileId === state.profileId ? replyDemotions : new Map();
    }

    // Muse's verdicts on External review requests, keyed by PR key.
    function getDigestReviewVerdicts() {
        return digestProfileId === state.profileId ? reviewVerdicts : new Map();
    }

    function getDigestReviewVerdict(notification) {
        const key = GhinboxFiltering.getPullRequestKey(notification);
        return (key && getDigestReviewVerdicts().get(key)) || null;
    }

    function renderUnusual(container, unusual) {
        container.replaceChildren(
            ...unusual.map((entry) => {
                const li = document.createElement('li');
                li.className = 'digest-unusual-entry';
                li.append(entry.text);
                entry.examples.forEach((example) => {
                    li.append(' ', makeLink(example, `(${itemLabel(example)})`));
                });
                return li;
            })
        );
    }

    function renderDigestPanel() {
        if (!panel) {
            return;
        }
        const current = digestProfileId === state.profileId ? digest : null;
        const liveIds = new Set(state.notifications.map((n) => String(n.id)));
        const visible = GhinboxDigest.selectVisibleDigest(current, liveIds);
        const show = GhinboxDigest.shouldShowDigestPanel({
            view: state.view,
            digest: current,
            visible,
        });
        panel.hidden = !show;
        if (!show) {
            return;
        }
        panel.querySelector('.digest-status').textContent =
            GhinboxDigest.formatDigestStatus(current, visible);
        const usage = GhinboxDigest.formatLlmUsage(current.llm_usage);
        const usageLine = panel.querySelector('.digest-usage');
        usageLine.textContent = usage;
        usageLine.hidden = !usage;
        panel.querySelector('.digest-look-at-empty').hidden = visible.lookAt.length > 0;
        openAllItems = visible.lookAt.filter((item) => item.url);
        const openAll = panel.querySelector('.digest-open-all');
        openAll.hidden = openAllItems.length === 0;
        openAll.textContent = `Open ${openAllItems.length} worth a look`;
        renderUnusual(panel.querySelector('.digest-unusual'), visible.unusual);
        const nothingUnusual = visible.unusual.length
            ? ''
            : GhinboxDigest.formatNothingUnusual(current);
        const emptyLine = panel.querySelector('.digest-unusual-empty');
        emptyLine.textContent = nothingUnusual;
        emptyLine.hidden = !nothingUnusual;
        panel.querySelector('.digest-unusual-section').hidden =
            !visible.unusual.length && !nothingUnusual;
    }

    async function backgroundTick() {
        if (document.visibilityState === 'hidden') {
            return;
        }
        try {
            await refreshServerSnapshotInBackground();
        } catch (error) {
            console.error('Background snapshot refresh failed:', error);
        }
        refreshDigest();
    }

    function startBackgroundRefresh() {
        refreshDigest();
        if (backgroundTimer) {
            return;
        }
        backgroundTimer = setInterval(
            backgroundTick,
            GhinboxDigest.BACKGROUND_REFRESH_INTERVAL_MS
        );
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                backgroundTick();
            }
        });
    }

    if (panel) {
        // Opening them is handling them: mark them done (undoable) so the
        // panel clears; new activity brings an item back through triage.
        panel.querySelector('.digest-open-all').addEventListener('click', () => {
            const items = openAllItems;
            if (!openUrlsInNewTabs(items.map((item) => item.url))) {
                return;
            }
            withActionContext('Mark worth a look done', () =>
                markIdsDoneWithUndo(items.map((item) => String(item.id)))
            );
        });
        panel.querySelector('.digest-refresh').addEventListener('click', () => {
            withActionContext('Refresh digest', handleDigestRefresh);
        });
    }

    window.refreshDigest = refreshDigest;
    window.getDigestWhy = getDigestWhy;
    window.getDigestReplyDemotions = getDigestReplyDemotions;
    window.getDigestReviewVerdicts = getDigestReviewVerdicts;
    window.getDigestReviewVerdict = getDigestReviewVerdict;
    window.renderDigestPanel = renderDigestPanel;
    window.startBackgroundRefresh = startBackgroundRefresh;
    window.backgroundRefreshTick = backgroundTick;
})();
