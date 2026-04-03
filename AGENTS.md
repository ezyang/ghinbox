- Do NOT attempt to install packages unless the user explicitly asks you to do
  so.  Only the packages specified in pyproject.toml are available.  You cannot add new packages.  If you desperately want another package, tell the user.
- Use `ghinbox/webapp/notifications.html` as the default UI file to edit; do not add or modify other notification UI files unless explicitly requested.
- If you modified Python files, use "ruff check" to check lint, "ruff format" to autoformat files and "pyrefly check ." to typecheck.  Do NOT do this if the change is HTML+JS only.
- Tests:
  - E2E (Playwright): run from `e2e/` via `npm test` (or `npm run test:headed|test:debug|test:ui`)
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
- Always run tests after making changes.
- Always add E2E tests for new features.  If I ask you to fix a bug, first make an E2E test that exhibits the bug and fails, and then fix it.
- There may be multiple coding agents running at the same time; don't worry
  too much about unexpected changes, we are running SCM checkpoints regularly.
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
