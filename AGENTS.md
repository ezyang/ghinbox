- ONLY use non-interactive commands like cat, sed, apply_patch to do edits.
  Do NOT use interactive editors.
- Do NOT attempt to install packages.  Only the packages specified in
  pyproject.toml are available.  You cannot add new packages.  If you
  desperately want another package, make a note of it in the final PR
  description.
- Use conventional commits to format PR title
- There are no nested AGENTS.md files, this is the only agents file
- Use `webapp/notifications.html` as the default UI file to edit; do not add or modify other notification UI files unless explicitly requested.
- Use "ruff check" to check lint, "ruff format" to autoformat files and
  "pyrefly check ." to typecheck.
- When writing the PR description, include the original user request VERBATIM.
- Tests:
  - Unit tests: `uv run pytest`
  - E2E (Playwright): run from `e2e/` via `npm test` (or `npm run test:headed|test:debug|test:ui`)
    - Allow a longer timeout for `npm test` in automation (recommend 5 minutes / 300000 ms).
    - Playwright auto-starts the API server with `uv run python -m ghinbox.api.server --test --no-reload --port 8001`
    - Base URL is `http://localhost:8001/app/`
    - Tests use port 8001 (not 8000) to avoid conflicts with production servers
    - Override with `TEST_PORT=XXXX npm test` if needed
  - There is no root `npm run test:e2e` script; use the `e2e/` package scripts.
- Fixtures:
  - Update HTML fixtures from responses (non-interactive): `uv run python -m ghinbox.fixtures update --force`
  - Regenerate E2E JSON fixtures: `uv run python -m ghinbox.fixtures generate-e2e --force`
- Always run tests after making changes.
- Always add E2E tests for new features.
- There may be multiple coding agents running at the same time; don't worry
  too much about unexpected changes, we are running SCM checkpoints regularly.
