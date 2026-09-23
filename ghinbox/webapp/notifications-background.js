// Background freshness: periodic server-snapshot pulls and the Feed digest panel.
(function () {
    const panel = document.getElementById('digest-panel');
    let digest = null;
    let digestProfileId = null;
    let digestPollTimer = null;
    let backgroundTimer = null;

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
        } catch (error) {
            console.error('Failed to load feed digest:', error);
        }
        renderDigestPanel();
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

    function renderLookAt(list, lookAt) {
        list.replaceChildren(
            ...lookAt.map((item) => {
                const li = document.createElement('li');
                li.className = 'digest-item';
                li.dataset.id = item.id;
                const ref = document.createElement('span');
                ref.className = 'digest-item-ref';
                ref.textContent = [itemLabel(item), item.state].filter(Boolean).join(' · ');
                const why = document.createElement('div');
                why.className = 'digest-item-why';
                why.textContent = item.why || '';
                li.append(makeLink(item, item.title || item.url), ' ', ref, why);
                return li;
            })
        );
    }

    function renderVibe(container, vibe) {
        container.replaceChildren(
            ...vibe.map((theme) => {
                const p = document.createElement('p');
                p.className = 'digest-vibe-theme';
                if (theme.title) {
                    const title = document.createElement('strong');
                    title.textContent = `${theme.title}. `;
                    p.append(title);
                }
                p.append(theme.text);
                theme.examples.forEach((example) => {
                    p.append(' ', makeLink(example, `(${itemLabel(example)})`));
                });
                return p;
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
        renderLookAt(panel.querySelector('.digest-look-at'), visible.lookAt);
        panel.querySelector('.digest-look-at-empty').hidden = visible.lookAt.length > 0;
        const openAll = panel.querySelector('.digest-open-all');
        openAll.hidden = visible.lookAt.length === 0;
        openAll.dataset.count = String(visible.lookAt.length);
        renderVibe(panel.querySelector('.digest-vibe'), visible.vibe);
        panel.querySelector('.digest-vibe-details').hidden = visible.vibe.length === 0;
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
        panel.querySelector('.digest-open-all').addEventListener('click', () => {
            const urls = Array.from(panel.querySelectorAll('.digest-look-at a')).map(
                (link) => link.href
            );
            openUrlsInNewTabs(urls);
        });
        panel.querySelector('.digest-refresh').addEventListener('click', () => {
            withActionContext('Refresh digest', handleDigestRefresh);
        });
    }

    window.refreshDigest = refreshDigest;
    window.renderDigestPanel = renderDigestPanel;
    window.startBackgroundRefresh = startBackgroundRefresh;
    window.backgroundRefreshTick = backgroundTick;
})();
