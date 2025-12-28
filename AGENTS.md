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
  "pyrefly" to typecheck.
- When writing the PR description, include the original user request VERBATIM.
- Tests:
  - Unit tests: `uv run pytest`
  - E2E (Playwright): run from `e2e/` via `npm test` (or `npm run test:headed|test:debug|test:ui`)
    - Playwright auto-starts the API server with `uv run python -m ghsim.api.server --test --no-reload --port 8000`
    - Base URL is `http://localhost:8000/app/`
  - There is no root `npm run test:e2e` script; use the `e2e/` package scripts.
- Fixtures:
  - Update HTML fixtures from responses (non-interactive): `uv run python -m ghsim.fixtures update --force`
  - Regenerate E2E JSON fixtures: `uv run python -m ghsim.fixtures generate-e2e --force`
- Always run tests after making changes.
- Always add E2E tests for new features.
