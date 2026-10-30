// Ship pane: the viewer's open PRs, live from GitHub, split into "Action
// needed", "Landing" and "Review requested", grouped by stack. Ship It
// posts the mergebot command as a PR comment (GitHub is the database);
// blocking Dr. CI failures must each be acknowledged before a `merge -i` goes
// out. The per-row "…" menu holds destructive actions (Abandon closes the PR);
// being tucked away, they run without a confirm and offer Undo instead.
// A bell on rows whose reviewers have been silent a week opens a dialog that
// DMs one of them on Slack through the server's `meta` CLI. The dialog can
// ask the server's LLM for someone better placed to review (from who wrote
// or approved the changed files) and request their review on GitHub.
(function () {
    const panel = document.getElementById('ship-panel');
    const dialog = document.getElementById('ship-ack-dialog');
    const pingDialog = document.getElementById('ship-ping-dialog');
    if (!panel) {
        return;
    }

    const AUTO_RELOAD_AFTER_MS = 2 * 60 * 1000;
    // GitHub usually finishes computing mergeability within seconds.
    const MERGEABLE_RECHECK_DELAYS_MS = [3000, 10000];
    // The last load, so a page reload renders at once while GitHub (several
    // seconds of GraphQL) revalidates in the background.
    const CACHE_KEY = 'ghnotif_ship_cache_v1';
    // Local-only, losable: when each (PR, reviewer) was last pinged, and the
    // Slack unixname last used for each GitHub login.
    const PINGS_KEY = 'ghnotif_ship_pings_v1';
    const SLACK_HANDLES_KEY = 'ghnotif_slack_handles_v1';
    const BELL_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Zm5-3.5A3.5 3.5 0 0 0 4.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.017.017 0 0 0-.003.01l.001.006c0 .002.002.004.004.006l.006.004.007.001h10.964l.007-.001.006-.004.004-.006.001-.007a.017.017 0 0 0-.003-.01l-1.703-2.554a1.745 1.745 0 0 1-.294-.97V5A3.5 3.5 0 0 0 8 1.5Z"></path></svg>';
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
    // PR key -> section a just-shipped row stays in, so the stack doesn't
    // jump while you look at its next PR. Settles on the next load from
    // GitHub or on leaving the tab.
    let heldSections = {};
    let pings = readJson(PINGS_KEY);
    let pingRowKey = null;
    let pingSending = false;
    // Slack unixname -> { state: 'loading' | 'ok' | 'missing', text, detail }.
    const slackLookups = new Map();
    // GitHub login -> { state: loading|ok|missing, unixname, status, detail }.
    const employeeLookups = new Map();
    // `${pr.key}@${headSha}` -> { state: loading|ok|error, label, why, detail }:
    // the server's LLM-proposed release notes label for a push.
    const labelSuggestions = new Map();
    const addingLabel = new Set();
    // `${pr.key}@${headSha}` -> { state: loading|ok|error, reviewers, detail }:
    // the server's LLM-proposed reviewers for a push.
    const reviewerSuggestions = new Map();

    function bumpVersion() {
        state.ship.version += 1;
    }

    function readJson(key) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || '{}');
            return value && typeof value === 'object' ? value : {};
        } catch (error) {
            console.warn(`Ignoring unreadable ${key}:`, error);
            return {};
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`Could not save ${key}:`, error);
        }
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
                GhinboxShip.applyPendingMerges(state.ship.prs, state.ship.pendingMerges),
                { nowMs: Date.now(), pings },
                heldSections
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

    // PRs by number, one aliased query per batch. A failed lookup leaves
    // its PRs out: unknown stack members only hide Ship It above them.
    async function fetchPullRequestBatches(batches, nowMs) {
        const found = [];
        await Promise.all(batches.map(async (batch) => {
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
                console.error(`Ship PR lookup failed for ${batch.repo}:`, error);
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
            // Stack members the search skipped (merged, draft, stale).
            prs.push(...(await fetchPullRequestBatches(GhinboxShip.getMissingStackNumbers(prs), nowMs)));
            state.ship.prs = prs;
            state.ship.fetchedAt = nowMs;
            state.ship.fromCache = false;
            heldSections = {};
            writeShipCache();
            scheduleMergeableRecheck(nowMs, 0);
        } catch (error) {
            console.error('Ship load failed:', error);
            state.ship.error = error.message || String(error);
        } finally {
            state.ship.loading = false;
            bumpVersion();
            render();
        }
    }

    // Re-ask GitHub about PRs whose mergeability it had not computed yet, so
    // a merge conflict surfaces without a manual reload.
    function scheduleMergeableRecheck(loadedAt, attempt) {
        if (attempt >= MERGEABLE_RECHECK_DELAYS_MS.length) {
            return;
        }
        setTimeout(async () => {
            if (state.ship.fetchedAt !== loadedAt || state.ship.loading) {
                return;
            }
            const batches = GhinboxShip.getUnknownMergeableNumbers(state.ship.prs);
            if (!batches.length) {
                return;
            }
            const fresh = await fetchPullRequestBatches(batches, Date.now());
            if (state.ship.fetchedAt !== loadedAt || state.ship.loading) {
                return;
            }
            state.ship.prs = GhinboxShip.replacePullRequests(state.ship.prs, fresh);
            writeShipCache();
            bumpVersion();
            render();
            scheduleMergeableRecheck(loadedAt, attempt + 1);
        }, MERGEABLE_RECHECK_DELAYS_MS[attempt]);
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

    function describeDays(days) {
        return `${days} ${days === 1 ? 'day' : 'days'}`;
    }

    function renderPingButton(row) {
        if (!row.ping) {
            return '';
        }
        const pick = row.ping.reviewers[0];
        const title = row.ping.due
            ? `Ping @${pick.login} on Slack (waiting ${describeDays(pick.waitingDays)})`
            : 'Reviewers pinged recently; ping again on Slack';
        return `<button class="btn ship-ping-btn" type="button" data-pr-key="${escapeHtml(row.pr.key)}" data-due="${row.ping.due}" aria-label="Ping a reviewer of #${row.pr.number} on Slack" title="${escapeHtml(title)}">${BELL_ICON}</button>`;
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

    function suggestionKey(pr) {
        return `${pr.key}@${pr.headSha || ''}`;
    }

    function renderLabelSuggestion(row) {
        const suggestion = row.suggestLabel && labelSuggestions.get(suggestionKey(row.pr));
        if (!suggestion) {
            return '';
        }
        if (suggestion.state === 'loading') {
            return '<span class="ship-label-suggestion" data-state="loading">Picking a label…</span>';
        }
        if (suggestion.state === 'error') {
            return `<span class="ship-label-suggestion" data-state="error" title="${escapeHtml(suggestion.detail)}">No label to propose</span>`;
        }
        const adding = addingLabel.has(row.pr.key);
        return `<span class="ship-label-suggestion" data-state="ok" title="${escapeHtml(suggestion.why)}">
            <code>${escapeHtml(suggestion.label)}</code>
            <button class="btn btn-small ship-add-label-btn" type="button" data-pr-key="${escapeHtml(row.pr.key)}"${adding ? ' disabled' : ''}>${adding ? 'Adding…' : 'Add label'}</button>
        </span>`;
    }

    // One proposal per push, one at a time: each is an LLM call.
    let suggesting = false;
    async function requestLabelSuggestions() {
        const sections = getShipSections();
        if (suggesting || !sections) {
            return;
        }
        const row = [...sections.action, ...sections.landing, ...sections.review]
            .flatMap((group) => group.rows)
            .find((item) => item.suggestLabel && !labelSuggestions.has(suggestionKey(item.pr)));
        if (!row) {
            return;
        }
        const { pr } = row;
        const key = suggestionKey(pr);
        suggesting = true;
        labelSuggestions.set(key, { state: 'loading' });
        renderShipPanel();
        try {
            const result = await fetchJson('/api/ship/release-label', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo: pr.repo, number: pr.number, head_sha: pr.headSha }),
            });
            labelSuggestions.set(key, { state: 'ok', label: result.label, why: result.why || '' });
        } catch (error) {
            console.warn(`No release notes label for #${pr.number}:`, error);
            labelSuggestions.set(key, { state: 'error', detail: error.detail || error.message || String(error) });
        } finally {
            suggesting = false;
            renderShipPanel();
        }
    }

    async function addSuggestedLabel(prKey) {
        const pr = findPr(prKey);
        const suggestion = pr && labelSuggestions.get(suggestionKey(pr));
        if (!pr || suggestion?.state !== 'ok' || addingLabel.has(prKey)) {
            return;
        }
        addingLabel.add(prKey);
        renderShipPanel();
        try {
            await fetchJson(`/github/rest/repos/${pr.repo}/issues/${pr.number}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ labels: [suggestion.label] }),
            });
            pr.labels = [...pr.labels, suggestion.label];
            writeShipCache();
            bumpVersion();
            showStatus(`Labeled #${pr.number} "${suggestion.label}"`, 'success', { autoDismiss: true });
        } catch (error) {
            showStatus(`Adding a label to #${pr.number} failed: ${error.message || error}`, 'error');
        } finally {
            addingLabel.delete(prKey);
            render();
        }
    }

    function renderRow(row) {
        const { pr } = row;
        const blocking = row.blocking
            ? `<span class="ship-blocking" data-approved="${row.blocking.approved > 0}" title="These can't land until #${pr.number} does">${escapeHtml(GhinboxShip.describeBlocking(row.blocking))}</span>`
            : '';
        const notes = [
            blocking,
            ...row.reasons.map((reason) => reason.url
                ? `<a class="ship-reason" data-severity="${reason.severity}" href="${escapeHtml(reason.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reason.label)}</a>`
                : `<span class="ship-reason" data-severity="${reason.severity}">${escapeHtml(reason.label)}</span>`),
            renderLabelSuggestion(row),
            row.waiting ? `<span class="ship-waiting">${escapeHtml(row.waiting)}</span>` : '',
            row.reviewWait ? `<span class="ship-review-wait" title="Review requested ${escapeHtml(new Date(row.reviewWait.since).toLocaleString())}">${escapeHtml(row.reviewWait.label)}</span>` : '',
        ].join('');
        return `<li class="ship-row" data-pr-key="${escapeHtml(pr.key)}" data-needs-action="${row.needsAction}">
            <div class="ship-row-body">
                <div class="ship-row-title">
                    <a class="ship-pr-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortRepo(pr.repo))}#${pr.number}</a>
                    <span class="ship-title">${renderInlineCode(pr.title)}</span>
                </div>
                <div class="ship-row-meta">${renderCi(pr)}${notes}</div>
            </div>
            ${renderPingButton(row)}
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
            if (Object.keys(heldSections).length) {
                heldSections = {};
                bumpVersion();
            }
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
        requestLabelSuggestions();
    }

    function findRow(prKey) {
        return findPlacement(prKey)?.row || null;
    }

    function findPlacement(prKey) {
        const sections = getShipSections();
        if (!sections) {
            return null;
        }
        for (const name of ['action', 'landing', 'review']) {
            for (const group of sections[name]) {
                const row = group.rows.find((item) => item.pr.key === prKey);
                if (row) {
                    return { row, section: name };
                }
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
                const section = findPlacement(key)?.section;
                if (section) {
                    heldSections[key] = section;
                }
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

    function renderSlackLookup(handle) {
        const lookup = slackLookups.get(handle);
        if (!handle || !lookup) {
            return '';
        }
        return `<span class="ship-ping-resolved" data-state="${lookup.state}" title="${escapeHtml(lookup.detail || '')}">${escapeHtml(lookup.text)}</span>`;
    }

    // Shows whose DM a unixname opens, since GitHub logins often differ.
    async function lookUpSlackUser(handle) {
        // A failed lookup is retried; it may have been a CLI hiccup.
        const known = slackLookups.get(handle);
        if (!handle || known?.final || ['loading', 'ok'].includes(known?.state)) {
            return;
        }
        slackLookups.set(handle, { state: 'loading', text: 'Looking up…' });
        renderPingResolved();
        try {
            const user = await fetchJson(`/api/slack/user?user=${encodeURIComponent(handle)}`);
            slackLookups.set(handle, { state: 'ok', text: `→ ${user.real_name || user.display_name || handle}` });
        } catch (error) {
            slackLookups.set(handle, {
                state: 'missing',
                text: 'No Slack user by that unixname',
                detail: String(error.message || error),
            });
        }
        renderPingResolved();
    }

    // Finds the unixname linked to a GitHub login, then fills it in if the
    // user is still on that reviewer and hasn't typed one.
    async function resolveEmployee(login) {
        if (['loading', 'ok'].includes(employeeLookups.get(login)?.state)) {
            return;
        }
        employeeLookups.set(login, { state: 'loading' });
        renderPingResolved();
        try {
            const employee = await fetchJson(`/api/slack/github-user?login=${encodeURIComponent(login)}`);
            employeeLookups.set(login, { state: 'ok', unixname: employee.unixname, status: employee.status });
        } catch (error) {
            employeeLookups.set(login, { state: 'missing', detail: String(error.message || error) });
        }
        if (pingDialog.open && getPingReviewer()?.login === login && !getPingHandle()) {
            fillPingHandle(login, { resolve: false });
        } else {
            renderPingResolved();
        }
    }

    function fillPingHandle(login, { resolve = true } = {}) {
        const remembered = readJson(SLACK_HANDLES_KEY)[login];
        const employee = employeeLookups.get(login);
        const handle = remembered || (employee?.state === 'ok' ? employee.unixname : '');
        pingDialog.querySelector('.ship-ping-handle').value = handle;
        if (!remembered && employee?.state === 'ok' && employee.status === 'former') {
            slackLookups.set(handle, { state: 'missing', text: 'Former employee; not on Slack', final: true });
        }
        renderPingResolved();
        if (handle) {
            lookUpSlackUser(handle);
        } else if (resolve) {
            resolveEmployee(login);
        }
        updatePingSend();
    }

    function getPingHandle() {
        return pingDialog.querySelector('.ship-ping-handle').value.trim();
    }

    function renderPingResolved() {
        const handle = getPingHandle();
        const login = getPingReviewer()?.login;
        const employee = login && employeeLookups.get(login);
        let html = renderSlackLookup(handle);
        if (!handle && employee?.state === 'loading') {
            html = '<span class="ship-ping-resolved" data-state="loading">Finding their unixname…</span>';
        } else if (!handle && employee?.state === 'missing') {
            html = `<span class="ship-ping-resolved" data-state="missing" title="${escapeHtml(employee.detail)}">No employee linked to @${escapeHtml(login)}; enter their unixname</span>`;
        }
        pingDialog.querySelector('.ship-ping-lookup').innerHTML = html;
    }

    function getPingReviewers(row) {
        if (!row?.ping) {
            return [];
        }
        const suggestions = reviewerSuggestions.get(suggestionKey(row.pr))?.reviewers;
        return [
            ...row.ping.reviewers,
            ...GhinboxShip.buildSuggestedReviewers(row.pr, row.ping, suggestions, { pings }),
        ];
    }

    function getPingReviewer() {
        const login = pingDialog.querySelector('.ship-ping-reviewer').value;
        return getPingReviewers(findRow(pingRowKey)).find((reviewer) => reviewer.login === login) || null;
    }

    function updatePingSend() {
        const send = pingDialog.querySelector('.ship-ping-send');
        send.disabled = pingSending || !getPingReviewer() || !getPingHandle() ||
            Boolean(slackLookups.get(getPingHandle())?.final) ||
            !pingDialog.querySelector('.ship-ping-message').value.trim();
        send.textContent = pingSending ? 'Sending…' : 'Send';
    }

    function renderPingOption(reviewer) {
        const label = [
            `@${reviewer.login}`,
            reviewer.name,
            // A suggestion's wait is the PR's, not theirs.
            !reviewer.suggested && reviewer.waitingDays !== null ? `waiting ${describeDays(reviewer.waitingDays)}` : '',
            reviewer.pingedAt ? `pinged ${formatRelativeTime(new Date(reviewer.pingedAt).toISOString())}` : '',
            reviewer.codeOwner ? 'code owner' : '',
        ].filter(Boolean).join(' · ');
        return `<option value="${escapeHtml(reviewer.login)}">${escapeHtml(label)}</option>`;
    }

    // Requested reviewers (best pick first), then any the LLM suggested.
    function renderPingReviewers(row) {
        const reviewers = getPingReviewers(row);
        const suggested = reviewers.filter((reviewer) => reviewer.suggested);
        pingDialog.querySelector('.ship-ping-reviewer').innerHTML =
            reviewers.filter((reviewer) => !reviewer.suggested).map(renderPingOption).join('') +
            (suggested.length
                ? `<optgroup label="Suggested">${suggested.map(renderPingOption).join('')}</optgroup>`
                : '');
    }

    function renderPingSuggest(row) {
        const suggestion = row && reviewerSuggestions.get(suggestionKey(row.pr));
        const button = pingDialog.querySelector('.ship-ping-suggest');
        const status = pingDialog.querySelector('.ship-ping-suggest-status');
        button.disabled = ['loading', 'ok'].includes(suggestion?.state);
        status.dataset.state = suggestion?.state || '';
        status.title = suggestion?.detail || '';
        // Suggestions since requested on GitHub are listed as requested.
        const listed = getPingReviewers(row).filter((reviewer) => reviewer.suggested).length;
        status.textContent = {
            loading: 'Looking through who wrote and approved these files…',
            ok: listed
                ? `Suggested ${listed} below`
                : (suggestion?.reviewers?.length ? '' : 'No one else stands out'),
            error: 'Could not suggest anyone',
        }[suggestion?.state] || '';
    }

    async function requestReviewerSuggestions() {
        const row = findRow(pingRowKey);
        if (!row) {
            return;
        }
        const { pr } = row;
        const key = suggestionKey(pr);
        if (['loading', 'ok'].includes(reviewerSuggestions.get(key)?.state)) {
            return;
        }
        reviewerSuggestions.set(key, { state: 'loading' });
        renderPingSuggest(row);
        try {
            const result = await fetchJson('/api/ship/reviewer-suggestions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo: pr.repo, number: pr.number, head_sha: pr.headSha }),
            });
            reviewerSuggestions.set(key, { state: 'ok', reviewers: result.reviewers || [] });
        } catch (error) {
            console.warn(`No reviewer suggestions for #${pr.number}:`, error);
            reviewerSuggestions.set(key, { state: 'error', detail: error.detail || error.message || String(error) });
        }
        const current = findRow(pingRowKey);
        if (!pingDialog.open || current?.pr.key !== pr.key) {
            return;
        }
        renderPingSuggest(current);
        const first = getPingReviewers(current).find((reviewer) => reviewer.suggested);
        if (first) {
            renderPingReviewers(current);
            pingDialog.querySelector('.ship-ping-reviewer').value = first.login;
            selectPingReviewer();
        }
    }

    // Fills the unixname and message for the chosen reviewer; a message the
    // user has edited is kept.
    function selectPingReviewer() {
        const row = findRow(pingRowKey);
        const reviewer = getPingReviewer();
        if (!row || !reviewer) {
            return;
        }
        const why = pingDialog.querySelector('.ship-ping-why');
        why.hidden = !reviewer.why;
        why.textContent = reviewer.why || '';
        pingDialog.querySelector('.ship-ping-request').hidden = !reviewer.suggested;
        const message = pingDialog.querySelector('.ship-ping-message');
        if (!message.value || message.value === message.dataset.generated) {
            message.value = GhinboxShip.buildPingMessage(row.pr, reviewer);
            message.dataset.generated = message.value;
        }
        fillPingHandle(reviewer.login);
    }

    function openPingDialog(row) {
        pingRowKey = row.pr.key;
        pingDialog.querySelector('.ship-ack-title').textContent =
            `Ping a reviewer of #${row.pr.number} on Slack`;
        renderPingReviewers(row);
        renderPingSuggest(row);
        pingDialog.querySelector('.ship-ping-request-box').checked = true;
        const message = pingDialog.querySelector('.ship-ping-message');
        message.value = '';
        message.dataset.generated = '';
        const error = pingDialog.querySelector('.ship-ping-error');
        error.hidden = true;
        error.textContent = '';
        pingDialog.showModal();
        selectPingReviewer();
    }

    async function sendPing() {
        const row = findRow(pingRowKey);
        const reviewer = getPingReviewer();
        const handle = getPingHandle();
        const markdown = pingDialog.querySelector('.ship-ping-message').value.trim();
        if (!row || !reviewer || !handle || pingSending) {
            return;
        }
        // Request first, so the ping postdates the request and quiets the bell.
        const requestReview = reviewer.suggested &&
            pingDialog.querySelector('.ship-ping-request-box').checked;
        pingSending = true;
        updatePingSend();
        try {
            if (requestReview) {
                try {
                    await fetchJson(`/github/rest/repos/${row.pr.repo}/pulls/${row.pr.number}/requested_reviewers`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reviewers: [reviewer.login] }),
                    });
                } catch (error) {
                    throw new Error(`requesting their review on GitHub failed: ${error.message || error}`);
                }
            }
            await fetchJson('/api/slack/ping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: handle, markdown }),
            });
        } catch (error) {
            const line = pingDialog.querySelector('.ship-ping-error');
            line.hidden = false;
            line.textContent = `Could not ping ${handle}: ${error.message || error}`;
            return;
        } finally {
            pingSending = false;
            updatePingSend();
        }
        writeJson(SLACK_HANDLES_KEY, { ...readJson(SLACK_HANDLES_KEY), [reviewer.login]: handle });
        const pingedAt = Date.now();
        pings = { ...pings, [GhinboxShip.getPingKey(row.pr, reviewer.login)]: pingedAt };
        writeJson(PINGS_KEY, pings);
        const pr = findPr(row.pr.key);
        if (requestReview && pr) {
            pr.requestedReviewers = [...(pr.requestedReviewers || []), {
                login: reviewer.login,
                name: reviewer.name,
                codeOwner: false,
                requestedAt: new Date(pingedAt - 1).toISOString(),
                lastHeardAt: null,
            }];
            writeShipCache();
        }
        bumpVersion();
        pingDialog.close();
        render();
        showStatus(
            requestReview
                ? `Requested a review from @${reviewer.login} and pinged them on Slack about #${row.pr.number}`
                : `Pinged @${reviewer.login} on Slack about #${row.pr.number}`,
            'success',
            { autoDismiss: true }
        );
    }

    panel.addEventListener('click', (event) => {
        const pingButton = event.target.closest('.ship-ping-btn');
        if (pingButton) {
            const row = findRow(pingButton.dataset.prKey);
            if (row?.ping) {
                openPingDialog(row);
            }
            return;
        }
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
        const addLabel = event.target.closest('.ship-add-label-btn');
        if (addLabel) {
            withActionContext('Add release notes label', () => addSuggestedLabel(addLabel.dataset.prKey));
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

    if (pingDialog) {
        pingDialog.addEventListener('input', updatePingSend);
        pingDialog.addEventListener('change', (event) => {
            if (event.target.classList.contains('ship-ping-reviewer')) {
                selectPingReviewer();
                return;
            }
            if (event.target.classList.contains('ship-ping-handle')) {
                renderPingResolved();
                lookUpSlackUser(getPingHandle());
            }
            updatePingSend();
        });
        // Enter in the unixname field looks it up instead of closing the form.
        pingDialog.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target.classList.contains('ship-ping-handle')) {
                event.preventDefault();
                event.target.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        pingDialog.querySelector('.ship-ping-suggest').addEventListener('click', () => {
            withActionContext('Suggest reviewers', requestReviewerSuggestions);
        });
        pingDialog.querySelector('.ship-ping-send').addEventListener('click', () => {
            withActionContext('Ping reviewer', sendPing);
        });
        pingDialog.addEventListener('close', () => {
            pingRowKey = null;
        });
    }

    globalThis.getShipActionCount = getShipActionCount;
    globalThis.maybeAutoLoadShip = maybeAutoLoadShip;
    globalThis.loadShip = loadShip;

    readShipCache();
    registerRenderHook(renderShipPanel);
    renderShipPanel();
})();
