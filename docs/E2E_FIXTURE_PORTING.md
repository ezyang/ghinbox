# E2E Fixture Policy

How E2E test data is sourced, and when to use which kind. See `SOUL.md`
axiom 4 for the underlying principle: fixtures are harvested, not invented.

## The pipeline

```
prod flow (ghinbox/flows/, real GitHub + test accounts)
  → responses/ (raw timestamped captures, gitignored)
  → tests/fixtures/*.html (curated, checked in; python -m ghinbox.fixtures update)
  → e2e/fixtures/*.json (parsed; python -m ghinbox.fixtures generate-e2e)
  → E2E specs (imported via e2e/tests/app-fixture.ts)
```

The HTML fixtures in `tests/fixtures/` are consumed by the Python parser
tests and are the regression tripwire for GitHub changing its markup.

## Current E2E fixtures

| Fixture | Source | Used by |
|---------|--------|---------|
| `notifications_mixed.json` | Hand-written | app-fixture.ts default; most specs |
| `notifications_empty.json` | Hand-written | sync.spec.ts |

`notifications_mixed.json` is deliberately synthetic: 5 notifications with
stable IDs `notif-1`..`notif-5`, 2 open and 3 closed, `notif-4` a merged PR,
`notif-5` a not_planned issue. Tests that assert exact counts and IDs depend
on this never changing.

## When to add a fixture

- **Deterministic logic tests** (exact counts, fixed IDs, specific state
  distributions): synthetic is correct. Prefer extending
  `notifications_mixed.json` usage or building small inline variations via
  app-fixture.ts helpers over inventing whole new payload files.
- **Realistic-shape tests** (pagination over 25+ items, real node IDs, real
  markup edge cases): harvest. Run a flow, then
  `python -m ghinbox.fixtures update --force` and add an entry to
  `E2E_FIXTURE_MAPPING` in `ghinbox/fixtures.py` before running
  `python -m ghinbox.fixtures generate-e2e --force`.

Only add an `E2E_FIXTURE_MAPPING` entry when a spec actually imports the
generated JSON. Generated-but-unreferenced fixtures rot silently; a batch of
them was deleted in June 2026 after sitting orphaned since the original
porting plan was written.

## Refresh workflow (when GitHub changes its HTML)

```bash
python -m ghinbox.run_flow pagination owner_account trigger_account
uv run python -m ghinbox.fixtures update --force
uv run python -m ghinbox.fixtures generate-e2e --force
cd e2e && npm test
```
