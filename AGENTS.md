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
  - **Tests fail with escaped HTML (e.g., `<details>` shown as text)**: The webapp
    loads `marked.js` and `DOMPurify` from CDN (`cdn.jsdelivr.net`). If these fail
    to load, markdown rendering falls back to `escapeHtml()`. Ensure internet
    access is available and proxy variables are unset.
  - **Popup tests fail with `chrome-error://chromewebdata/`**: Tests that open
    new tabs to GitHub URLs require internet access. Without it, navigation fails.
  - **Flaky tests in parallel**: Some tests (e.g., mark-done with new comments
    detection) may be timing-sensitive. Run individually to confirm:
    `npx playwright test "filename.spec.ts:lineNumber"`
