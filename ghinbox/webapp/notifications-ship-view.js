// Ship pane: the viewer's open PRs, live from GitHub, split into "Action
// needed", "Landing" and "Review requested", grouped by ghstack stack. Ship It
// posts the mergebot command as a PR comment (GitHub is the database);
// blocking Dr. CI failures must each be acknowledged before a `merge -i` goes
// out. The per-row "…" menu holds destructive actions (Abandon closes the PR);
// being tucked away, they run without a confirm and offer Undo instead.
(function () {
    const panel = document.getElementById('ship-panel');
    const dialog = document.getElementById('ship-ack-dialog');
    if (!panel) {
        return;
    }

    const AUTO_RELOAD_AFTER_MS = 2 * 60 * 1000;
    // The last load, so a page reload renders at once while GitHub (several
    // seconds of GraphQL) revalidates in the background.
    const CACHE_KEY = 'ghnotif_ship_cache_v1';
    const sectionsContainer = panel.querySelector('.ship-sections');
    const statusLine = panel.querySelector('.ship-status');
    const errorLine = panel.querySelector('.ship-error');
    const refreshButton = panel.querySelector('.ship-refresh');
    let cachedSections = null;
    let cachedVersion = -1;
    let ackRowKey = null;
    let openMenuKey = null;
    // The last abandoned PR, offered for Undo (reopen) until the next one.
    let abandoned = null;

    function bumpVersion() {
        state.ship.version += 1;
    }

    function readShipCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (cached && Array.isArray(cached.prs) && cached.fetchedAt) {
                state.ship.prs = cached.prs;
                state.ship.fetchedAt = cached.fetchedAt;
                state.ship.fromCache = true;
                bumpVersion();
            }
        } catch (error) {
            console.warn('Ignoring unreadable ship cache:', error);
        }
    }

    function writeShipCache() {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                prs: state.ship.prs,
                fetchedAt: state.ship.fetchedAt,
            }));
        } catch (error) {
            console.warn('Could not cache ship PRs:', error);
        }
    }

    function getShipSections() {
        if (!state.ship.prs) {
            return null;
        }
        if (cachedVersion !== state.ship.version) {
            cachedSections = GhinboxShip.buildShipSections(
                GhinboxShip.applyPendingMerges(state.ship.prs, state.ship.pendingMerges)
            );
            cachedVersion = state.ship.version;
        }
        return cachedSections;
    }

    function getShipActionCount() {
        const sections = getShipSections();
        return sections ? sections.actionCount : null;
    }

    async function fetchViewerPullRequests(nowMs) {
        const query = GhinboxShip.buildShipSearchQuery(nowMs);
        const nodes = [];
        let after = null;
        for (let page = 0; page < GhinboxShip.MAX_SEARCH_PAGES; page += 1) {
            const data = await fetchGraphql(GhinboxShip.buildShipSearchGraphql(), { query, after });
            nodes.push(...(data?.search?.nodes || []));
            if (!data?.search?.pageInfo?.hasNextPage) {
                break;
            }
            after = data.search.pageInfo.endCursor;
        }
        return nodes;
    }

    // Stack members the search skipped (merged, draft, stale). A failed
    // lookup leaves them unknown, which only hides Ship It above them.
    async function fetchMissingStackMembers(prs, nowMs) {
        const found = [];
        await Promise.all(GhinboxShip.getMissingStackNumbers(prs).map(async (batch) => {
            try {
                const data = await fetchGraphql(
                    GhinboxShip.buildStackLookupGraphql(batch.repo, batch.numbers),
                    {}
                );
                Object.values(data?.repository || {}).forEach((node) => {
                    const pr = GhinboxShip.normalizePullRequest(node, { nowMs });
                    if (pr) {
                        found.push(pr);
                    }
                });
            } catch (error) {
                console.error(`Ship stack lookup failed for ${batch.repo}:`, error);
            }
        }));
        return found;
    }

    async function loadShip() {
        if (state.ship.loading) {
            return;
        }
        state.ship.loading = true;
        state.ship.error = null;
        render();
        try {
            const nowMs = Date.now();
            const nodes = await fetchViewerPullRequests(nowMs);
            const prs = nodes
                .map((node) => GhinboxShip.normalizePullRequest(node, { nowMs }))
                .filter(Boolean);
            prs.push(...(await fetchMissingStackMembers(prs, nowMs)));
            state.ship.prs = prs;
            state.ship.fetchedAt = nowMs;
            state.ship.fromCache = false;
            writeShipCache();
        } catch (error) {
            console.error('Ship load failed:', error);
            state.ship.error = error.message || String(error);
        } finally {
            state.ship.loading = false;
            bumpVersion();
            render();
        }
    }

    function maybeAutoLoadShip() {
        if (state.view !== 'ship' || state.ship.loading) {
            return;
        }
        const fetchedAt = state.ship.fetchedAt;
        if (!state.ship.fromCache && fetchedAt && Date.now() - fetchedAt < AUTO_RELOAD_AFTER_MS) {
            return;
        }
        withActionContext('Load ship', loadShip);
    }

    function shortRepo(repo) {
        return repo.replace(/^pytorch\//, '');
    }

    function ciLink(pr) {
        if (pr.ci.source === 'drci') {
            return `https://hud.pytorch.org/pr/${pr.repo}/${pr.number}`;
        }
        return `${pr.url}/checks`;
    }

    function renderCi(pr) {
        const stale = pr.ci.stale
            ? ' <span class="ship-ci-stale" title="Dr. CI has not caught up with the latest push">(older commit)</span>'
            : '';
        const unrelatedText = GhinboxShip.describeUnrelated(pr.ci);
        const unrelated = unrelatedText
            ? ` <span class="ship-ci-unrelated" title="Dr. CI does not block a normal merge on these">${escapeHtml(unrelatedText)}</span>`
            : '';
        return `<a class="ship-ci" data-ci-state="${pr.ci.state}" href="${escapeHtml(ciLink(pr))}" target="_blank" rel="noopener noreferrer">${escapeHtml(GhinboxShip.describeCi(pr.ci))}</a>${unrelated}${stale}`;
    }

    function renderShipButton(row) {
        if (!row.plan.canShip) {
            if (!GhinboxShip.isBlockedBelow(row.plan)) {
                return '';
            }
            return `<button class="btn ship-it-btn" type="button" data-pr-key="${escapeHtml(row.pr.key)}" data-blocked="true" title="${escapeHtml(row.waiting || 'Blocked by the stack below')}" disabled>${escapeHtml(GhinboxShip.getShipButtonLabel(row.plan))}</button>`;
        }
        const shipping = state.ship.shipping.has(row.pr.key);
        // Cached data may be stale; only ship what GitHub just confirmed.
        const stale = state.ship.fromCache;
        const hasErrors = row.plan.failures.length > 0;
        const label = shipping ? 'Shipping…' : GhinboxShip.getShipButtonLabel(row.plan);
        const title = stale
            ? 'Checking GitHub for changes…'
            : `Comment "${row.plan.command}" on #${row.pr.number}` +
                (row.plan.prNumbers.length > 1
                    ? `, landing ${row.plan.prNumbers.map((n) => `#${n}`).join(', ')}`
                    : '');
        return `<button class="btn ship-it-btn" type="button" data-pr-key="${escapeHtml(row.pr.key)}" data-has-errors="${hasErrors}" title="${escapeHtml(title)}"${shipping || stale ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
    }

    function renderMoreMenu(pr) {
        const open = openMenuKey === pr.key;
        const busy = state.ship.abandoning.has(pr.key);
        const menu = open
            ? `<div class="ship-menu" role="menu">
                <button class="ship-menu-item ship-abandon-btn" type="button" role="menuitem" data-pr-key="${escapeHtml(pr.key)}"${busy ? ' disabled' : ''}>${busy ? 'Abandoning…' : 'Abandon'}</button>
            </div>`
            : '';
        return `<div class="ship-more">
            <button class="btn ship-more-btn" type="button" data-pr-key="${escapeHtml(pr.key)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="More actions for #${pr.number}" title="More actions">…</button>
            ${menu}
        </div>`;
    }

    function renderRow(row) {
        const { pr } = row;
        const notes = [
            ...row.reasons.map((reason) => reason.url
                ? `<a class="ship-reason" data-severity="${reason.severity}" href="${escapeHtml(reason.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reason.label)}</a>`
                : `<span class="ship-reason" data-severity="${reason.severity}">${escapeHtml(reason.label)}</span>`),
            row.waiting ? `<span class="ship-waiting">${escapeHtml(row.waiting)}</span>` : '',
        ].join('');
        return `<li class="ship-row" data-pr-key="${escapeHtml(pr.key)}" data-needs-action="${row.needsAction}">
            <div class="ship-row-body">
                <div class="ship-row-title">
                    <a class="ship-pr-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortRepo(pr.repo))}#${pr.number}</a>
                    <span class="ship-title">${renderInlineCode(pr.title)}</span>
                </div>
                <div class="ship-row-meta">${renderCi(pr)}${notes}</div>
            </div>
            <span class="ship-status-pill" data-status="${row.status.key}">${escapeHtml(row.status.label)}</span>
            ${renderShipButton(row)}
            ${renderMoreMenu(pr)}
        </li>`;
    }

    function renderGroup(group) {
        const label = group.isStack
            ? `<div class="ship-stack-label">Stack · ${group.rows.length === group.stackSize
                ? `${group.stackSize} PRs`
                : `${group.rows.length} of ${group.stackSize} open PRs`}</div>`
            : '';
        return `<li class="ship-group" data-stack="${group.isStack}">
            ${label}
            <ul class="ship-rows">${group.rows.map(renderRow).join('')}</ul>
        </li>`;
    }

    function renderSection(name, title, groups, count, emptyText) {
        const body = groups.length
            ? `<ul class="ship-groups">${groups.map(renderGroup).join('')}</ul>`
            : `<p class="ship-empty">${escapeHtml(emptyText)}</p>`;
        return `<section class="ship-section" data-section="${name}">
            <h3>${escapeHtml(title)} <span class="count">${count}</span></h3>
            ${body}
        </section>`;
    }

    function renderShipPanel() {
        const show = state.view === 'ship';
        panel.hidden = !show;
        if (!show) {
            return;
        }
        refreshButton.disabled = state.ship.loading;
        refreshButton.textContent = state.ship.loading ? 'Loading…' : 'Refresh';
        errorLine.hidden = !state.ship.error;
        errorLine.textContent = state.ship.error ? `Could not load PRs: ${state.ship.error}` : '';
        const sections = getShipSections();
        if (!sections) {
            statusLine.textContent = state.ship.loading ? 'Loading your PRs from GitHub…' : '';
            sectionsContainer.innerHTML = '';
            return;
        }
        statusLine.textContent = `Open PRs you authored, updated in the last ${GhinboxShip.RECENT_DAYS} days` +
            (state.ship.fetchedAt ? ` · loaded ${formatRelativeTime(new Date(state.ship.fetchedAt).toISOString())}` : '') +
            (state.ship.loading ? ' · refreshing…' : '');
        sectionsContainer.innerHTML =
            renderUndo() +
            renderSection('action', 'Action needed', sections.action, sections.actionCount, 'Nothing needs you.') +
            renderSection('landing', 'Landing', sections.landing, sections.landingCount, 'Nothing is landing.') +
            renderSection('review', 'Review requested', sections.review, sections.reviewCount, 'Nothing is waiting on reviewers.');
    }

    function findRow(prKey) {
        const sections = getShipSections();
        if (!sections) {
            return null;
        }
        for (const group of [...sections.action, ...sections.landing, ...sections.review]) {
            const row = group.rows.find((item) => item.pr.key === prKey);
            if (row) {
                return row;
            }
        }
        return null;
    }

    async function ship(row) {
        const { pr, plan } = row;
        state.ship.shipping.add(pr.key);
        render();
        try {
            await fetchJson(`/github/rest/repos/${pr.repo}/issues/${pr.number}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: plan.command }),
            });
            const now = Date.now();
            plan.prKeys.forEach((key) => {
                state.ship.pendingMerges[key] = now;
            });
            bumpVersion();
            showStatus(`Commented "${plan.command}" on #${pr.number}`, 'success', { autoDismiss: true });
        } catch (error) {
            showStatus(`Ship It failed for #${pr.number}: ${error.message || error}`, 'error');
        } finally {
            state.ship.shipping.delete(pr.key);
            render();
        }
    }

    function findPr(prKey) {
        return state.ship.prs?.find((item) => item.key === prKey) || null;
    }

    async function setPullRequestState(pr, githubState) {
        await fetchJson(`/github/rest/repos/${pr.repo}/pulls/${pr.number}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: githubState }),
        });
        pr.state = githubState === 'closed' ? 'CLOSED' : 'OPEN';
        writeShipCache();
        bumpVersion();
    }

    async function abandon(prKey) {
        const pr = findPr(prKey);
        if (!pr || state.ship.abandoning.has(prKey)) {
            return;
        }
        openMenuKey = null;
        state.ship.abandoning.add(prKey);
        render();
        try {
            await setPullRequestState(pr, 'closed');
            abandoned = { key: pr.key, number: pr.number, title: pr.title, undoing: false };
        } catch (error) {
            showStatus(`Abandon failed for #${pr.number}: ${error.message || error}`, 'error');
        } finally {
            state.ship.abandoning.delete(prKey);
            render();
        }
    }

    async function undoAbandon() {
        const pr = abandoned && findPr(abandoned.key);
        if (!pr || abandoned.undoing) {
            return;
        }
        abandoned.undoing = true;
        renderShipPanel();
        try {
            await setPullRequestState(pr, 'open');
            abandoned = null;
            showStatus(`Reopened #${pr.number}`, 'success', { autoDismiss: true });
        } catch (error) {
            abandoned.undoing = false;
            showStatus(`Reopen failed for #${pr.number}: ${error.message || error}`, 'error');
        } finally {
            render();
        }
    }

    function renderUndo() {
        if (!abandoned) {
            return '';
        }
        return `<div class="ship-undo" role="status">
            <span>Abandoned #${abandoned.number} <span class="ship-title">${renderInlineCode(abandoned.title)}</span></span>
            <button class="btn ship-undo-btn" type="button"${abandoned.undoing ? ' disabled' : ''}>${abandoned.undoing ? 'Reopening…' : 'Undo'}</button>
            <button class="ship-undo-dismiss" type="button" aria-label="Dismiss">×</button>
        </div>`;
    }

    // One checkbox per (PR, Dr. CI section): ignoring failures is a claim
    // about each kind of breakage, not a single blanket "yes".
    function groupFailures(failures) {
        const groups = new Map();
        failures.forEach((failure) => {
            const key = `${failure.prKey}|${failure.section}`;
            if (!groups.has(key)) {
                groups.set(key, { prNumber: failure.prNumber, section: failure.section, jobs: [] });
            }
            groups.get(key).jobs.push(failure);
        });
        return Array.from(groups.values());
    }

    function renderAckJob(job) {
        const name = job.url
            ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.name)}</a>`
            : escapeHtml(job.name);
        const failures = job.failures.length
            ? `<ul class="ship-ack-failures">${job.failures.map((failure) => `<li><code>${escapeHtml(failure)}</code></li>`).join('')}</ul>`
            : '';
        return `<li>${name}${failures}</li>`;
    }

    function updateAckConfirm() {
        const checks = Array.from(dialog.querySelectorAll('.ship-ack-check'));
        dialog.querySelector('.ship-ack-confirm').disabled =
            !checks.length || checks.some((check) => !check.checked);
    }

    function openAckDialog(row) {
        ackRowKey = row.pr.key;
        const chain = row.plan.prNumbers.map((number) => `#${number}`).join(', ');
        dialog.querySelector('.ship-ack-title').textContent =
            `Ship ${chain} with ${row.plan.failures.length} blocking ${row.plan.failures.length === 1 ? 'failure' : 'failures'}?`;
        dialog.querySelector('.ship-ack-command').textContent = row.plan.command;
        dialog.querySelector('.ship-ack-list').innerHTML = groupFailures(row.plan.failures)
            .map((group) => `<li class="ship-ack-item">
                <label><input type="checkbox" class="ship-ack-check"> #${group.prNumber}: ${escapeHtml(group.section)} (${group.jobs.length} ${group.jobs.length === 1 ? 'job' : 'jobs'})</label>
                <ul class="ship-ack-jobs">${group.jobs.map(renderAckJob).join('')}</ul>
            </li>`)
            .join('');
        updateAckConfirm();
        dialog.showModal();
    }

    function handleShipClick(prKey) {
        const row = findRow(prKey);
        if (!row?.plan.canShip || state.ship.fromCache || state.ship.shipping.has(prKey)) {
            return;
        }
        if (row.plan.failures.length) {
            openAckDialog(row);
            return;
        }
        withActionContext('Ship It', () => ship(row));
    }

    panel.addEventListener('click', (event) => {
        const button = event.target.closest('.ship-it-btn');
        if (button) {
            handleShipClick(button.dataset.prKey);
            return;
        }
        const more = event.target.closest('.ship-more-btn');
        if (more) {
            openMenuKey = openMenuKey === more.dataset.prKey ? null : more.dataset.prKey;
            renderShipPanel();
            return;
        }
        const abandonButton = event.target.closest('.ship-abandon-btn');
        if (abandonButton) {
            withActionContext('Abandon PR', () => abandon(abandonButton.dataset.prKey));
            return;
        }
        if (event.target.closest('.ship-undo-btn')) {
            withActionContext('Undo abandon', undoAbandon);
            return;
        }
        if (event.target.closest('.ship-undo-dismiss')) {
            abandoned = null;
            renderShipPanel();
        }
    });
    document.addEventListener('click', (event) => {
        if (openMenuKey && !event.target.closest('.ship-more')) {
            openMenuKey = null;
            renderShipPanel();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (openMenuKey && event.key === 'Escape') {
            openMenuKey = null;
            renderShipPanel();
        }
    });
    refreshButton.addEventListener('click', () => {
        withActionContext('Refresh ship', loadShip);
    });
    if (dialog) {
        dialog.addEventListener('change', updateAckConfirm);
        dialog.querySelector('.ship-ack-confirm').addEventListener('click', () => {
            // Re-plan from current data: a refresh may have changed the stack.
            const row = findRow(ackRowKey);
            dialog.close();
            if (row?.plan.canShip) {
                withActionContext('Ship It (ignore failures)', () => ship(row));
            }
        });
        dialog.addEventListener('close', () => {
            ackRowKey = null;
        });
    }

    globalThis.getShipActionCount = getShipActionCount;
    globalThis.maybeAutoLoadShip = maybeAutoLoadShip;
    globalThis.loadShip = loadShip;

    readShipCache();
    registerRenderHook(renderShipPanel);
    renderShipPanel();
})();
