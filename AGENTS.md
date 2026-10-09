- Read `SOUL.md` before making architectural decisions (where state lives,
  client vs server, where logic goes, where test data comes from). It is the
  project's constitution; when code and soul disagree, build toward the soul.
- Do NOT attempt to install packages unless the user explicitly asks you to do
  so.  Only the packages specified in pyproject.toml are available.  You cannot add new packages.  If you desperately want another package, tell the user.
- Use `ghinbox/webapp/notifications.html` as the default UI file to edit; do not add or modify other notification UI files unless explicitly requested.
- If you modified Python files, use "ruff check" to check lint, "ruff format" to autoformat files and "pyrefly check ." to typecheck.  Do NOT do this if the change is HTML+JS only.
- Tests:
  - E2E (Playwright): run from `e2e/` via `npm test` for the default fast suite
    (excludes tests tagged `@slow`) or `npm run test:full` for the exhaustive suite.
    Focused scripts include `npm run test:agent`, `npm run test:smoke`,
    `npm run test:sync`, `npm run test:actions`, `npm run test:classification`,
    `npm run test:layout`, `npm run test:mutation`, and
    `npm run test:headed|test:debug|test:ui`.
    - **Important**: Unset proxy environment variables before running tests:
      `unset HTTPS_PROXY HTTP_PROXY X2P_AGENT_PROXY_ADDRESS && npm test`
    - Allow a longer timeout for `npm test` in automation (recommend 5 minutes / 300000 ms).
    - Playwright auto-starts the API server on a random free port (auto-allocated)
    - Override with `TEST_PORT=XXXX npm test` to use a fixed port
    - Multiple test runs can execute concurrently without port conflicts
  - Python tests: `uv run pytest` (only run if you modified Python)
  - There is no root `npm run test:e2e` script; use the `e2e/` package scripts.
- Fixtures:
  - Try not to invent fixtures from scratch; instead, we want to create production flows which we can extract fixtures from (this makes it easier to update the fixtures in the future.)  Use ezyang0 and htmlpurifierbot when running prod flows.
  - Update HTML fixtures from responses (non-interactive): `uv run python -m ghinbox.fixtures update --force`
  - Regenerate E2E JSON fixtures: `uv run python -m ghinbox.fixtures generate-e2e --force`
- Always run tests after making changes. Prefer the narrowest script that covers
  the changed behavior during iteration; run `npm run test:full` for broad sync,
  fixture, or test infrastructure changes.
- Always add E2E tests for new features.  If I ask you to fix a bug, first make an E2E test that exhibits the bug and fails, and then fix it.
- There may be multiple coding agents running at the same time; don't worry
  too much about unexpected changes, we are running SCM checkpoints regularly.
- Automatically commit your own changes at logical spots as you work.
- Prod/debug access:
  - Do not start a sync against prod unless the user explicitly asks for it.
    By default, inspect and interact with the server's existing local snapshot
    state.
  - The server exposes a local Unix domain socket for shell/agent HTTP access at
    `auth_state/ghinbox-debug.sock` by default. It bypasses the site password
    gate and is protected by filesystem permissions; do not proxy it through
    nginx or expose it remotely.
  - Prefer this socket for prod workshop/debug queries from this machine:
    `curl --unix-socket auth_state/ghinbox-debug.sock http://ghinbox/debug/state`
    and
    `curl --unix-socket auth_state/ghinbox-debug.sock http://ghinbox/github/rest/user`.
  - If the socket is missing, fall back to the site-auth cookie flow documented
    in `docs/PROD_QUERY_RECIPES.md`, or check whether the server was started
    with `--no-debug-socket`.
- Background work (server):
  - The server re-syncs every stored snapshot (repos and profiles), one per
    tick, every `--snapshot-sync-interval-minutes` (default 5; 0 disables),
    skipping ticks when GitHub rate-limit headroom is low. `--test` disables
    it. Post-sync hooks run after each successful sync. Notification lists
    are scraped from HTML (no API quota); a steady-state sync spends ~5-20
    core calls refetching changed comment threads (measured 2026-09-24 from
    `logs/ghinbox.log`), so the interval is cheap to shorten.
  - The rolling Feed digest (`ghinbox/digest/`) is one such hook. After every
    profile sync it triages new/updated Feed items with an LLM (notes cached
    per item/updated_at in SQLite); "high" attention items become "Look at
    these" (sticky until the user marks them done or comments after them) and render as annotations on
    the Feed rows themselves. Composing "Out of the ordinary" re-reads every
    note against the user's baseline of a normal Feed
    (`ghinbox/digest/feed_baseline.md`, override with
    `GHINBOX_DIGEST_BASELINE_FILE`; editing it recomposes) and lists only what
    departs from it (empty on a normal day), so it runs once per `GHINBOX_DIGEST_COMPOSE_INTERVAL_HOURS` (default 24)
    or when the panel's Refresh (`POST /api/digest/{profile}/run`) forces it.
    Served at `GET /api/digest/{profile}`. Env: `GHINBOX_DIGEST_ENABLED=0`
    disables it, `GHINBOX_DIGEST_PROFILES` (default `pytorch`) chooses
    profiles, `GHINBOX_DIGEST_REPOS` (default
    `pytorch/pytorch,pytorch/test-infra,pytorch/ciforge`; `*` for all)
    chooses the repos whose
    Feed items are digested (triage, Replies check, auto-done): high-volume
    repos plus ones you never read; low-volume side repos like
    meta-pytorch/spmd_types stay in the Feed untouched. And
    `GHINBOX_DIGEST_LLM_COMMAND` overrides the tool-less
    `pi -p --mode json` (Muse) command; it must stay tool-less because prompts
    carry untrusted GitHub text. Use a `{prompt_file}` argument for CLIs that
    can't read stdin. Queue classification still comes from the client's UMD
    modules (run under Node), so server and UI agree on what is Feed.
  - Replies check (demote-only): before triage, the worker asks the LLM
    about each rule-based Replies item it has not judged at its current
    `updated_at` (`reply_check` calls; verdicts in `digest_reply_checks`).
    "fyi" verdicts are served as `reply_demotions`, and the shared JS
    classifier (client and server) moves those items to the Feed until new
    activity voids the verdict. It never promotes anything; finished
    delegated @claude tasks and forced outside-org replies are never
    candidates; with no verdict, or when the LLM fails, items stay in
    Replies.
  - Review screen (`ghinbox/digest/reviews.py`): after triage, the worker
    asks the LLM (`review` calls, batches of 4) which of the user's buckets
    each Reviews > Needs review > External PR fits: `easy`, `context` (code
    the user knows), `important`; none = "skip". The rubric is
    `ghinbox/digest/review_rubric.md` (override with
    `GHINBOX_REVIEW_RUBRIC_FILE`); editing it re-judges every PR. External
    needs author permissions, which the worker fetches and caches for 7 days
    (`digest_author_permissions`) and then reclassifies with the shared JS
    classifier. Each changed PR costs one `/pulls/N` read; only a new head
    SHA also fetches `/pulls/N/files` (patches) and calls the LLM. Verdicts
    live in `digest_review_assessments`, are served as `review_assessments`,
    and render as chips on Reviews rows; the "Worth a look" filter hides
    only "skip" verdicts (demote-only, unjudged PRs stay). Failures land in
    `reviews.error` and never break the Feed digest.
    `GHINBOX_DIGEST_REVIEWS=0` disables it.
  - Reviews duplicates: a real thread for a PR waiting in Reviews shows in
    neither Feed nor Replies; the client's duplicate cleanup and the digest
    worker mark it done.
  - LLM cost: every triage/reply_check/compose call is logged to `digest_llm_calls`
    (tokens from pi's JSON usage, prompt/response size, latency, errors) and
    summed over the last 24h as `llm_usage` in the digest response and the
    panel. Use it to tune batch sizes and compose cadence.
  - Digest auto-done: right after triage, on every sync, the worker marks
    triaged Feed items done on GitHub (REST), so the GitHub inbox/mobile app
    keeps only Replies, reviews, and "Look at these". It never marks done
    surfaced items or untriaged items. Surfaced = "high" attention, or
    "medium" with a direct human mention/reply that the Replies check did not
    demote; other direct pings in the Feed are marked done. Auto-done
    items wait in the digest queue (`queue_count`, local-only; see SOUL.md)
    until the next compose, then keep feeding the digest for
    `GHINBOX_DIGEST_WINDOW_HOURS` (default 24); new activity brings an item
    back through the pipeline. The same pass first marks the classifier's
    low-priority trash done (bot-only chatter on your PRs, approved/closed
    noise), mirroring the webapp's post-sync sweep so it runs with no tab
    open; it skips synthetic rows and items whose snapshot comments predate
    their latest activity. `GHINBOX_DIGEST_AUTO_DONE=0` disables both.
  - The client pulls a newer server snapshot every 5 minutes and when the tab
    becomes visible again (no GitHub calls), skipping it while the user is
    mid-action or when the sync started before the last local mark-done.
    Reviews reloads live from GitHub when you enter the view.
- PRs tab (view key `ship`; `notifications-ship.js` pure model, `notifications-ship-view.js`
  wiring): the viewer's open non-draft PRs updated in the last 90 days,
  fetched live via GraphQL search on entering the tab (not part of the
  notification snapshot; the last load is cached in localStorage and shown
  at once while it revalidates, with Ship It disabled until then), grouped by
  ghstack stack into "Action needed" / "Landing" / "Review requested" (each
  PR goes to its own section, so a stack can split; PRs below a
  requested/merging stack top are Landing too). CI status comes from
  the Dr. CI comment (blocking: NEW/UNCLASSIFIED/CANCELLED; unrelated:
  FLAKY/BROKEN TRUNK/UNSTABLE/non-blocking, shown in yellow, never red),
  falling back to the check rollup; jobs that all say "refusing to run CI"
  (ghstack too deep) are "CI not run", a hard blocker. Ship It (mergebot repos
  only) comments `@pytorchbot merge` on a PR when it and every open PR below
  it in the stack is approved and unblocked (otherwise approved PRs get a
  disabled "Ship Stacked"); blocking failures need a per-(PR, section)
  acknowledgement and post `@pytorchbot merge -i`. The row "…" menu holds
  destructive actions (Abandon = close the PR). A human comment or
  commented review newer than both the head commit and the author's own last
  comment/review is an "Unaddressed comment" (Action needed, advisory). Parser
  fixtures in `e2e/fixtures/ship/` are harvested with
  `scripts/harvest_ship_fixtures.py`.
- Feed summaries:
  - When asked to generate a feed summary/digest, extract the server-owned
    snapshot over the debug socket with `uv run python scripts/feed_digest.py
    --extract > /tmp/feed_data.json` (use `uv run`; the script needs `httpx`).
    By default this targets the **`pytorch` profile** (org:pytorch +
    org:meta-pytorch + org:google-pytorch + everything else), which is the
    user's real feed — not a single repo. Use
    `--repo owner/repo` only for an ad-hoc single-repo digest.
  - The extract prints a `snapshot_health` block. If it emits a staleness
    WARNING (`synced_at` older than 6h), the snapshot has drifted from GitHub;
    do NOT trust the digest. Re-sync the profile first with the webapp's Sync
    button or with `--extract --sync` (both trigger a live server-side
    GitHub rebuild and poll to completion) — but only run `--sync` when the
    user has asked for a fresh/full sync, since it hits GitHub.
  - Generate an HTML report by default at `/tmp/feed-report.html`; do not stop
    at a chat-only summary. The report is a CURATED digest, NOT an exhaustive
    listing — the user already has ghinbox to page through every notification.
    Its job is to surface the small set of items worth attention plus a few
    LLM-generated prose "vibe" summaries of the rest.
  - Structure the report in two parts: (1) "Look at these" — a short hand-picked
    list (~5-15 items, hard cap ~20) of notifications that genuinely warrant
    attention. STRONGLY prefer OPEN items; a closed/merged item is resolved by
    default, so only surface it with a concrete live reason (reverted, reopened,
    or a human explicitly waiting). Prioritize the user's own delegated @claude
    tasks whose answers are now waiting, reply-nature items, reverts/rollbacks,
    and direct @-mentions from real humans (not bots). Each gets a one-line "why
    it matters" and a GitHub link, plus a single "Open all" button; (2) "Overall
    vibe" — a few short prose paragraphs characterizing the rest thematically,
    WITHOUT listing the individual PRs/issues behind each theme (at most a couple
    representative links per theme).
  - Weight the mention signals correctly. In `report_items[].reply_signals`,
    `"@-mentioned by X"` is a genuine direct ping and `"replied to by X"` is a
    real reply after the user — these are the high-signal items to surface. But
    `"cc'd (broadcast) by X"` means the user was one of many names in a large
    cc list (e.g. a module cc), which is weak "this touches your area" noise,
    NOT someone asking the user directly — do not surface a broadcast cc as an
    action item just because it mentions the user. Most of the feed is
    typically broadcast cc's; the genuinely actionable set (direct mentions +
    replied-after) is much smaller, and the report's counts should make that
    split visible rather than implying the whole mention pile needs attention.
  - Report ONLY what the data supports: badges/labels must come from
    `report_items[].labels`/`state`/signals, not invented severity tags. Do not
    call something a "release blocker" (or similar) unless a label or an
    explicit human statement in the snippets says so.
  - Do NOT enumerate every feed item or create one section per theme with full
    item lists. If more than ~20 items qualify for "Look at these", keep the most
    important and say how many were omitted.
  - Keep the report lightweight enough to open quickly from `file://`: no full
    JSON payload, no giant all-items tables, no per-theme exhaustive lists, and
    derive "Open all" URLs from links already present in the DOM.
  - Keep marking done as a separate explicit action. Never run
    `scripts/feed_digest.py --mark-done` unless the user asks to mark feed
    items done after reviewing the report.
  - When the user asks to mark the feed done, mark the entire current Feed.
    Do not implicitly preserve reply-nature, direct-mention, or surfaced items;
    pass `--exclude-ids` only for items the user explicitly asks to keep.
- E2E test authoring rules:
  - Prefer helpers in `e2e/tests/app-fixture.ts` for auth/repo setup, API route
    mocks, cached app state, queue/subfilter clicks, and action endpoint mocks.
    Add missing helpers there before copying route setup across specs.
  - Use tags in test titles/describes to keep focused runs cheap:
    `@smoke` for the agent/PR fast path, `@slow` for exhaustive scenario tests,
    `@sync`, `@classification`, `@layout`, and `@mutation` for focused suites.
  - Keep pure queue classification, filtering, sorting, sync decision, and
    comment-interest logic out of browser tests when possible; prefer compact
    unit/table tests for that logic and one Playwright test for DOM wiring.
  - **Never use `waitForTimeout`.**  Wait for a specific condition instead:
    - Scroll: `page.waitForFunction(() => window.scrollY > 0)`
    - "Nothing happened": `expect.poll(() => flag, { timeout: 500 }).toBe(false)`
      or `expect(locator).not.toContainText(text, { timeout: 1200 })`
  - **Prefer auto-retrying Playwright assertions** (`toContainText`, `toHaveCount`,
    `toBeVisible`, `toHaveAttribute`, `toHaveClass`, `toHaveJSProperty`, `toHaveURL`)
    over extracting a value with `evaluate`/`getAttribute`/`textContent` then
    asserting with `toBe`/`toContain`. The retrying versions handle DOM timing.
  - **Every test must have at least one explicit `expect()` call.** Do not rely
    solely on `waitForURL`/`waitForFunction` throwing on timeout.
  - **Use specific expected values** when fixture data is deterministic.
    `toBeTruthy()` hides bugs; `toBe('issue-open')` catches them.
- Troubleshooting E2E tests:
  - **Popup tests fail with `chrome-error://chromewebdata/`**: Tests that open
    new tabs to GitHub URLs require internet access. Without it, navigation fails.
  - **Flaky tests in parallel**: Some tests (e.g., mark-done with new comments
    detection) may be timing-sensitive. Run individually to confirm:
    `npx playwright test "filename.spec.ts:lineNumber"`
