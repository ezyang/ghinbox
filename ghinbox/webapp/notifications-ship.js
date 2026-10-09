// Pure decisions for the Ship pane: the user's open PRs split into "Action
// needed" and "Review requested", grouped by ghstack stack, with CI status
// read through Dr. CI and a Ship It plan that posts `@pytorchbot merge`.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.GhinboxShip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DRCI_MARKER = '<!-- drci-comment-start -->';
    const MERGEBOT_LOGIN = 'pytorchmergebot';
    // Repos whose PRs land through pytorchbot even before Dr. CI has posted.
    const MERGEBOT_REPOS = new Set(['pytorch/pytorch']);
    // Open PRs untouched for longer than this are parked, not on the radar.
    const RECENT_DAYS = 90;
    const SEARCH_PAGE_SIZE = 25;
    const MAX_SEARCH_PAGES = 8;
    const STACK_LOOKUP_BATCH = 20;

    const PR_FRAGMENT = `
fragment ShipPullRequest on PullRequest {
  number
  title
  url
  state
  merged
  isDraft
  updatedAt
  mergeable
  reviewDecision
  body
  repository { nameWithOwner }
  labels(first: 30) { nodes { name } }
  reviewRequests(first: 1) { totalCount }
  latestOpinionatedReviews(first: 10) { nodes { state author { login } } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
  headComments: comments(first: 10) { nodes { author { login } body createdAt } }
  tailComments: comments(last: 8) { nodes { author { login } body createdAt } }
}`;

    function formatSearchDate(ms) {
        return new Date(ms).toISOString().slice(0, 10);
    }

    // Drafts stay out: reviewers are not asked about them and they would
    // bury the list. A draft inside a stack still shows via the stack lookup.
    function buildShipSearchQuery(nowMs = Date.now()) {
        const since = formatSearchDate(nowMs - RECENT_DAYS * 24 * 60 * 60 * 1000);
        return `is:pr is:open author:@me archived:false draft:false updated:>=${since}`;
    }

    function buildShipSearchGraphql() {
        return `query ShipPullRequests($query: String!, $after: String) {
  search(query: $query, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...ShipPullRequest }
  }
  rateLimit { limit remaining resetAt }
}
${PR_FRAGMENT}`;
    }

    function buildStackLookupGraphql(repo, numbers) {
        const [owner, name] = String(repo).split('/');
        const fields = numbers
            .map((number) => `    pr${number}: pullRequest(number: ${number}) { ...ShipPullRequest }`)
            .join('\n');
        return `query ShipStackLookup {
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
${fields}
  }
  rateLimit { limit remaining resetAt }
}
${PR_FRAGMENT}`;
    }

    function normalizeText(text) {
        return String(text || '').replace(/\r\n/g, '\n');
    }

    // Sections Dr. CI says a standard `@pytorchbot merge` tolerates: trunk
    // flakiness, failures already on the merge base, unstable jobs, and
    // anything it labels non-blocking (AI-suppressed, CRCR downstream).
    function getDrCiSectionKind(name) {
        const upper = String(name || '').toUpperCase();
        if (upper.includes('NON-BLOCKING')) {
            return 'unrelated';
        }
        if (/^(FLAKY|BROKEN TRUNK|UNSTABLE)\b/.test(upper)) {
            return 'unrelated';
        }
        return 'blocking';
    }

    function getDrCiHeadlineStatus(headline) {
        if (headline.startsWith(':white_check_mark:')) {
            return 'success';
        }
        if (headline.startsWith(':hourglass_flowing_sand:')) {
            return 'pending';
        }
        if (headline.startsWith(':x:')) {
            return 'failure';
        }
        return 'unknown';
    }

    function stripEmoji(text) {
        return String(text || '').replace(/^:[a-z_]+:\s*/, '').trim();
    }

    function parseDrCiComment(body) {
        const text = normalizeText(body);
        if (!text.includes(DRCI_MARKER)) {
            return null;
        }
        const result = {
            headline: null,
            headlineStatus: 'unknown',
            headSha: null,
            pendingCount: 0,
            sevs: [],
            sections: [],
            greenLight: null,
        };
        let section = null;
        let inSev = false;
        for (const line of text.split('\n')) {
            const header = line.match(/^## (.+)$/);
            if (header) {
                const headline = header[1].trim();
                section = null;
                inSev = /Active SEVs?\b/.test(headline);
                if (inSev || headline.startsWith(':link:')) {
                    continue;
                }
                result.headline = stripEmoji(headline);
                result.headlineStatus = getDrCiHeadlineStatus(headline);
                const pending = headline.match(/(\d+) Pending/);
                result.pendingCount = pending ? Number(pending[1]) : 0;
                continue;
            }
            if (inSev) {
                const sev = line.match(/^\* \[(.+?)\]\((\S+?)\)/);
                if (sev) {
                    result.sevs.push({ title: sev[1], url: sev[2] });
                }
                continue;
            }
            const asOf = line.match(/^As of commit ([0-9a-f]{7,40})/);
            if (asOf) {
                result.headSha = asOf[1];
                continue;
            }
            // Top-level sections start at column 0; AI verdicts nested inside a
            // job are indented and must not open a new section.
            const summary = line.match(/^<details[^>]*><summary>(.*?)<b>([^<]+)<\/b>(.*?)<\/summary>/);
            if (summary) {
                const name = summary[2].trim();
                section = null;
                if (name === 'GREEN LIGHT') {
                    const detail = summary[3].replace(/^\s*-\s*/, '').replace(/:$/, '');
                    result.greenLight = {
                        approved: /approved to be merged without human review/.test(detail),
                        outdated: /OUTDATED/.test(detail),
                        detail,
                    };
                    continue;
                }
                section = { name, kind: getDrCiSectionKind(name), jobs: [] };
                result.sections.push(section);
                continue;
            }
            if (!section) {
                continue;
            }
            const job = line.match(/^\* \[(.+?)\]\((\S+?)\)/);
            if (job) {
                section.jobs.push({ name: job[1], url: job[2], failures: [] });
                continue;
            }
            const failure = line.match(/^ {4}`(.+)`\s*$/);
            if (failure && section.jobs.length) {
                section.jobs[section.jobs.length - 1].failures.push(failure[1]);
            }
        }
        return result;
    }

    function shaMatches(a, b) {
        if (!a || !b) {
            return true;
        }
        const length = Math.min(a.length, b.length);
        return a.slice(0, length) === b.slice(0, length);
    }

    // CI state as a merge would see it: "failing" means a standard merge
    // would refuse (Dr. CI blocking jobs, or a red rollup without Dr. CI).
    function summarizeCi({ drci, rollup, headSha, url }) {
        if (drci) {
            const blockingJobs = [];
            let unrelatedCount = 0;
            drci.sections.forEach((section) => {
                if (section.kind === 'blocking') {
                    section.jobs.forEach((job) => {
                        blockingJobs.push({ ...job, section: section.name });
                    });
                } else {
                    unrelatedCount += section.jobs.length;
                }
            });
            const state = blockingJobs.length
                ? 'failing'
                : drci.pendingCount > 0
                    ? 'pending'
                    : drci.headlineStatus === 'unknown' ? 'unknown' : 'green';
            return {
                source: 'drci',
                state,
                headline: drci.headline,
                blockingJobs,
                unrelatedCount,
                pendingCount: drci.pendingCount,
                stale: !shaMatches(drci.headSha, headSha),
                sevs: drci.sevs,
            };
        }
        const rollupState = String(rollup || '').toUpperCase();
        const state =
            rollupState === 'SUCCESS' ? 'green' :
            rollupState === 'PENDING' || rollupState === 'EXPECTED' ? 'pending' :
            rollupState === 'FAILURE' || rollupState === 'ERROR' ? 'failing' :
            'none';
        return {
            source: 'rollup',
            state,
            headline: null,
            blockingJobs: state === 'failing'
                ? [{ name: 'CI checks (no Dr. CI classification)', url: url ? `${url}/checks` : '', failures: [], section: 'FAILING CHECKS' }]
                : [],
            unrelatedCount: 0,
            pendingCount: 0,
            stale: false,
            sevs: [],
        };
    }

    // "Stack from [ghstack](...) (oldest at bottom):" followed by "* #N"
    // lines, newest first, with "__->__" marking this PR.
    function parseGhstackStack(body) {
        const text = normalizeText(body);
        const start = text.search(/Stack from \[ghstack\]/);
        if (start < 0) {
            return null;
        }
        const numbers = [];
        let current = null;
        for (const line of text.slice(start).split('\n').slice(1)) {
            const entry = line.match(/^\* (__->__ )?#(\d+)\s*$/);
            if (entry) {
                const number = Number(entry[2]);
                numbers.push(number);
                if (entry[1]) {
                    current = number;
                }
                continue;
            }
            if (numbers.length || line.trim()) {
                break;
            }
        }
        return numbers.length ? { numbers, current } : null;
    }

    function parseMergeFailureReason(body) {
        const reason = normalizeText(body).match(/\*\*Reason\*\*:\s*(.+)/);
        if (!reason) {
            return 'Merge failed';
        }
        // Drop markdown links down to their text so the reason stays short.
        return reason[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    }

    const MERGE_REQUEST_RE = /^@pytorch(?:merge)?bot\s+merge\b/im;
    // Merges take hours at most ("ETA 0-4 Hours"); an older in-flight event
    // with no outcome is not worth trusting.
    const MERGE_IN_FLIGHT_STALE_MS = 12 * 60 * 60 * 1000;

    // The newest merge lifecycle event among the PR's last comments. A
    // failure older than the head commit no longer applies, and a revert
    // ends whatever merge came before it.
    function getMergebotState(comments, { headCommittedAt = null, nowMs = Date.now() } = {}) {
        let event = null;
        (comments || []).forEach((comment) => {
            const login = comment?.author?.login || '';
            const body = normalizeText(comment?.body).trim();
            const at = comment?.createdAt || null;
            if (login === MERGEBOT_LOGIN) {
                const stackMerge = body.match(/^Starting merge as part of PR stack under #(\d+)/);
                if (stackMerge) {
                    event = { state: 'merging', at, underNumber: Number(stackMerge[1]) };
                } else if (/^#+ Merge started/.test(body)) {
                    event = { state: 'merging', at };
                } else if (/^#+ Merge failed/.test(body)) {
                    event = { state: 'failed', reason: parseMergeFailureReason(body), at };
                } else if (/successfully reverted|started a revert job/.test(body)) {
                    event = null;
                }
                return;
            }
            if (MERGE_REQUEST_RE.test(body)) {
                event = { state: 'requested', at };
            }
        });
        const atMs = event?.at ? Date.parse(event.at) : NaN;
        if (
            event?.state === 'failed' &&
            headCommittedAt && Number.isFinite(atMs) &&
            Date.parse(headCommittedAt) > atMs
        ) {
            return null;
        }
        if (
            (event?.state === 'merging' || event?.state === 'requested') &&
            Number.isFinite(atMs) && nowMs - atMs > MERGE_IN_FLIGHT_STALE_MS
        ) {
            return null;
        }
        return event;
    }

    // Mergebot reports a stack merge's outcome only on the PR it was asked
    // to merge, so a member merging "under #N" is merging only while #N is.
    function resolveStackMerges(prs) {
        const byKey = new Map(prs.map((pr) => [pr.key, pr]));
        return prs.map((pr) => {
            const under = pr.mergebot?.underNumber;
            if (pr.mergebot?.state !== 'merging' || !under) {
                return pr;
            }
            const top = byKey.get(`${pr.repo}#${under}`);
            const topState = top?.mergebot?.state;
            if (!top || top.merged || topState === 'merging' || topState === 'requested') {
                return pr;
            }
            return { ...pr, mergebot: null };
        });
    }

    function normalizePullRequest(node, { nowMs = Date.now() } = {}) {
        if (!node || !node.number || !node.repository?.nameWithOwner) {
            return null;
        }
        const repo = node.repository.nameWithOwner;
        const commit = node.commits?.nodes?.[0]?.commit || null;
        const headComments = (node.headComments?.nodes || []).filter(Boolean);
        const tailComments = (node.tailComments?.nodes || []).filter(Boolean);
        const drciComment = headComments.find((comment) =>
            normalizeText(comment.body).includes(DRCI_MARKER)
        );
        const drci = parseDrCiComment(drciComment?.body);
        const headSha = commit?.oid || null;
        return {
            key: `${repo}#${node.number}`,
            repo,
            number: node.number,
            title: node.title || '',
            url: node.url || `https://github.com/${repo}/pull/${node.number}`,
            state: node.state || 'OPEN',
            merged: Boolean(node.merged),
            isDraft: Boolean(node.isDraft),
            updatedAt: node.updatedAt || null,
            mergeable: node.mergeable || 'UNKNOWN',
            reviewDecision: node.reviewDecision || null,
            labels: (node.labels?.nodes || []).map((label) => label?.name).filter(Boolean),
            reviewRequestCount: node.reviewRequests?.totalCount || 0,
            reviews: (node.latestOpinionatedReviews?.nodes || [])
                .filter(Boolean)
                .map((review) => ({ state: review.state, login: review.author?.login || '' })),
            headSha,
            headCommittedAt: commit?.committedDate || null,
            ci: summarizeCi({
                drci,
                rollup: commit?.statusCheckRollup?.state,
                headSha,
                url: node.url,
            }),
            mergebot: getMergebotState(tailComments, {
                headCommittedAt: commit?.committedDate || null,
                nowMs,
            }),
            stack: parseGhstackStack(node.body),
            usesMergebot: Boolean(drci) || MERGEBOT_REPOS.has(repo),
        };
    }

    // Stack members the search did not return (drafts, stale, merged, or
    // closed), grouped per repo so one aliased query per repo fetches them.
    function getMissingStackNumbers(prs) {
        const known = new Set(prs.map((pr) => pr.key));
        const missing = new Map();
        prs.forEach((pr) => {
            (pr.stack?.numbers || []).forEach((number) => {
                const key = `${pr.repo}#${number}`;
                if (known.has(key)) {
                    return;
                }
                if (!missing.has(pr.repo)) {
                    missing.set(pr.repo, new Set());
                }
                missing.get(pr.repo).add(number);
            });
        });
        const batches = [];
        missing.forEach((numbers, repo) => {
            const sorted = Array.from(numbers).sort((a, b) => b - a);
            for (let i = 0; i < sorted.length; i += STACK_LOOKUP_BATCH) {
                batches.push({ repo, numbers: sorted.slice(i, i + STACK_LOOKUP_BATCH) });
            }
        });
        return batches;
    }

    // A just-posted merge request shows before GitHub's comment list catches
    // up; a newer event from GitHub wins.
    function applyPendingMerges(prs, pendingMerges) {
        const pending = pendingMerges || {};
        return prs.map((pr) => {
            const at = pending[pr.key];
            if (!at) {
                return pr;
            }
            const knownAt = pr.mergebot?.at ? Date.parse(pr.mergebot.at) : 0;
            if (knownAt >= at) {
                return pr;
            }
            return { ...pr, mergebot: { state: 'requested', at: new Date(at).toISOString() } };
        });
    }

    function isApproved(pr) {
        if (pr.reviewDecision === 'APPROVED') {
            return true;
        }
        if (pr.reviewDecision) {
            return false;
        }
        // Repos without required reviews report no decision; read the reviews.
        return pr.reviews.some((review) => review.state === 'APPROVED') &&
            !pr.reviews.some((review) => review.state === 'CHANGES_REQUESTED');
    }

    // pytorchbot refuses to merge pytorch/pytorch PRs without one of these.
    function needsReleaseNotesLabel(pr) {
        return pr.repo === 'pytorch/pytorch' && !pr.labels.some((label) =>
            label.startsWith('release notes:') || label === 'topic: not user facing'
        );
    }

    // Per-PR facts, ignoring the stack. `blockers` are things only the
    // author can fix; `ready` means this PR alone could be merged now.
    function assessPullRequest(pr) {
        const open = pr.state === 'OPEN';
        const approved = isApproved(pr);
        const merging = pr.mergebot?.state === 'merging' || pr.mergebot?.state === 'requested';
        const blockers = [];
        if (!open) {
            return {
                open,
                approved,
                merging: false,
                blockers: pr.merged ? [] : [{ code: 'closed', label: 'Closed without merging' }],
                ready: false,
                waitingOnReview: false,
            };
        }
        if (pr.isDraft) {
            blockers.push({ code: 'draft', label: 'Draft' });
        }
        if (pr.mergeable === 'CONFLICTING') {
            blockers.push({ code: 'conflict', label: 'Merge conflict' });
        }
        if (pr.reviewDecision === 'CHANGES_REQUESTED') {
            blockers.push({ code: 'changes-requested', label: 'Changes requested' });
        }
        if (pr.usesMergebot && needsReleaseNotesLabel(pr)) {
            blockers.push({ code: 'needs-label', label: 'Needs release notes label' });
        }
        if (pr.labels.includes('Reverted')) {
            blockers.push({ code: 'reverted', label: 'Reverted' });
        }
        if (pr.mergebot?.state === 'failed') {
            blockers.push({ code: 'merge-failed', label: `Merge failed: ${pr.mergebot.reason}` });
        }
        const reviewless =
            !approved && !pr.isDraft &&
            pr.reviewRequestCount === 0 && pr.reviews.length === 0;
        if (reviewless) {
            blockers.push({ code: 'no-reviewers', label: 'No reviewers' });
        }
        if (!approved && !merging && pr.ci.state === 'failing') {
            const count = pr.ci.blockingJobs.length;
            blockers.push({
                code: 'ci-failing',
                label: `CI: ${count} blocking ${count === 1 ? 'failure' : 'failures'}`,
            });
        }
        // A reverted PR may relaunch, but only once the author decides to.
        const hardBlocked = blockers.some((blocker) =>
            ['draft', 'conflict', 'changes-requested', 'needs-label', 'closed'].includes(blocker.code)
        );
        return {
            open,
            approved,
            merging,
            blockers,
            ready: approved && !hardBlocked && !merging,
            waitingOnReview: !approved && !pr.isDraft && !reviewless,
        };
    }

    function describeLowerBlocker(lower, assessment) {
        if (!assessment.open) {
            return 'closed without merging';
        }
        if (assessment.merging) {
            return 'already merging';
        }
        const blocker = assessment.blockers.find((item) =>
            ['draft', 'conflict', 'changes-requested', 'needs-label', 'closed'].includes(item.code)
        );
        if (blocker) {
            return blocker.label.toLowerCase();
        }
        return assessment.approved ? 'not ready' : 'awaiting review';
    }

    // Commenting `@pytorchbot merge` on a ghstack PR lands it together with
    // every open PR below it, so Ship It needs the whole sub-stack ready.
    function planShip(pr, prsByKey) {
        if (!pr.usesMergebot) {
            return { canShip: false, reason: 'no-mergebot' };
        }
        const assessment = assessPullRequest(pr);
        if (!assessment.ready) {
            return { canShip: false, reason: 'not-ready' };
        }
        const chain = [pr];
        const missing = [];
        const blockedBy = [];
        if (pr.stack) {
            const index = pr.stack.numbers.indexOf(pr.number);
            const below = index >= 0 ? pr.stack.numbers.slice(index + 1) : [];
            below.forEach((number) => {
                const lower = prsByKey.get(`${pr.repo}#${number}`);
                if (!lower) {
                    missing.push(number);
                    return;
                }
                if (lower.merged) {
                    return;
                }
                const lowerAssessment = assessPullRequest(lower);
                if (!lowerAssessment.ready) {
                    blockedBy.push({ number, why: describeLowerBlocker(lower, lowerAssessment) });
                    return;
                }
                chain.push(lower);
            });
        }
        if (missing.length) {
            return { canShip: false, reason: 'unknown-below', missing };
        }
        if (blockedBy.length) {
            return { canShip: false, reason: 'blocked-below', blockedBy };
        }
        const failures = [];
        let pendingCount = 0;
        chain.forEach((member) => {
            pendingCount += member.ci.pendingCount;
            member.ci.blockingJobs.forEach((job) => {
                failures.push({ ...job, prNumber: member.number, prKey: member.key });
            });
        });
        return {
            canShip: true,
            prKeys: chain.map((member) => member.key),
            prNumbers: chain.map((member) => member.number),
            failures,
            pendingCount,
            command: failures.length ? '@pytorchbot merge -i' : '@pytorchbot merge',
        };
    }

    function getShipButtonLabel(plan) {
        const parts = [];
        if (plan.prNumbers.length > 1) {
            parts.push(`${plan.prNumbers.length} PRs`);
        }
        if (plan.failures.length) {
            parts.push(`${plan.failures.length} ${plan.failures.length === 1 ? 'error' : 'errors'}`);
        }
        return parts.length ? `Ship It (${parts.join(', ')})` : 'Ship It';
    }

    // Union PRs that list each other in a ghstack stack; order each group
    // newest-first by the stack list that covers the most members.
    function groupIntoStacks(prs) {
        const byKey = new Map(prs.map((pr) => [pr.key, pr]));
        const parent = new Map(prs.map((pr) => [pr.key, pr.key]));
        function find(key) {
            let current = key;
            while (parent.get(current) !== current) {
                current = parent.get(current);
            }
            return current;
        }
        prs.forEach((pr) => {
            (pr.stack?.numbers || []).forEach((number) => {
                const other = `${pr.repo}#${number}`;
                if (byKey.has(other)) {
                    parent.set(find(other), find(pr.key));
                }
            });
        });
        const members = new Map();
        prs.forEach((pr) => {
            const root = find(pr.key);
            if (!members.has(root)) {
                members.set(root, []);
            }
            members.get(root).push(pr);
        });
        return Array.from(members.values()).map((group) => {
            if (group.length === 1) {
                return group;
            }
            const groupNumbers = new Set(group.map((pr) => pr.number));
            const reference = group
                .filter((pr) => pr.stack)
                .map((pr) => ({
                    pr,
                    covered: pr.stack.numbers.filter((number) => groupNumbers.has(number)).length,
                }))
                .sort((a, b) =>
                    b.covered - a.covered ||
                    String(b.pr.updatedAt).localeCompare(String(a.pr.updatedAt))
                )[0]?.pr;
            const order = reference ? reference.stack.numbers : [];
            const rank = (pr) => {
                const index = order.indexOf(pr.number);
                return index >= 0 ? index : order.length;
            };
            return group.slice().sort((a, b) => rank(a) - rank(b) || b.number - a.number);
        });
    }

    function describeWaiting(pr, assessment, plan) {
        if (pr.mergebot?.state === 'merging') {
            return 'Merging';
        }
        if (pr.mergebot?.state === 'requested') {
            return 'Merge requested';
        }
        if (plan.reason === 'blocked-below') {
            return `Approved; waiting on ${plan.blockedBy
                .map((item) => `#${item.number} (${item.why})`)
                .join(', ')}`;
        }
        if (plan.reason === 'unknown-below') {
            return `Approved; can't see ${plan.missing.map((number) => `#${number}`).join(', ')} below`;
        }
        if (assessment.approved) {
            return 'Approved';
        }
        return 'Awaiting review';
    }

    function buildRow(pr, prsByKey) {
        const assessment = assessPullRequest(pr);
        const plan = planShip(pr, prsByKey);
        const reasons = assessment.blockers.map((blocker) => blocker.label);
        // Approved without a mergebot is still on the author: land it by hand.
        const landByHand = assessment.ready && !pr.usesMergebot;
        if (landByHand) {
            reasons.unshift('Approved; merge on GitHub');
        }
        const needsAction = plan.canShip || landByHand || assessment.blockers.length > 0;
        return {
            pr,
            assessment,
            plan,
            reasons,
            waiting: needsAction ? null : describeWaiting(pr, assessment, plan),
            needsAction,
        };
    }

    function buildShipSections(inputPrs) {
        const prs = resolveStackMerges(inputPrs);
        const prsByKey = new Map(prs.map((pr) => [pr.key, pr]));
        const action = [];
        const review = [];
        groupIntoStacks(prs).forEach((group) => {
            // Merged stack members are done; they only mattered for planning.
            const visible = group.filter((pr) => !pr.merged);
            if (!visible.length || !visible.some((pr) => pr.state === 'OPEN')) {
                return;
            }
            const rows = visible.map((pr) => buildRow(pr, prsByKey));
            const updatedAt = visible
                .map((pr) => pr.updatedAt || '')
                .sort()
                .pop();
            const entry = {
                key: visible[0].key,
                isStack: group.length > 1 || Boolean(visible[0].stack && visible[0].stack.numbers.length > 1),
                rows,
                updatedAt,
            };
            (rows.some((row) => row.needsAction) ? action : review).push(entry);
        });
        const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
        action.sort(byRecent);
        review.sort(byRecent);
        const countRows = (groups, predicate) =>
            groups.reduce((total, group) => total + group.rows.filter(predicate).length, 0);
        return {
            action,
            review,
            actionCount: countRows(action, (row) => row.needsAction),
            reviewCount: countRows(review, () => true) + countRows(action, (row) => !row.needsAction),
        };
    }

    function describeCi(ci) {
        if (ci.state === 'failing') {
            const count = ci.blockingJobs.length;
            return `${count} blocking ${count === 1 ? 'failure' : 'failures'}`;
        }
        if (ci.state === 'pending') {
            return ci.pendingCount ? `CI pending (${ci.pendingCount})` : 'CI pending';
        }
        if (ci.state === 'green') {
            return ci.unrelatedCount
                ? `CI green (${ci.unrelatedCount} unrelated)`
                : 'CI green';
        }
        if (ci.state === 'unknown') {
            return ci.headline || 'CI unknown';
        }
        return 'No CI';
    }

    return {
        DRCI_MARKER,
        MERGEBOT_REPOS,
        MAX_SEARCH_PAGES,
        RECENT_DAYS,
        applyPendingMerges,
        assessPullRequest,
        buildShipSearchGraphql,
        buildShipSearchQuery,
        buildShipSections,
        buildStackLookupGraphql,
        describeCi,
        getDrCiSectionKind,
        getMergebotState,
        getMissingStackNumbers,
        getShipButtonLabel,
        groupIntoStacks,
        needsReleaseNotesLabel,
        normalizePullRequest,
        parseDrCiComment,
        parseGhstackStack,
        planShip,
        resolveStackMerges,
        summarizeCi,
    };
});
