# Prod Fixture Notes (Read-Only)

These fixtures are captured from a real account and are not reproducible. They
are meant for short-lived debugging and inspection only.

## Capture Flow

Use the read-only snapshot flow with a prod-scoped token:

```bash
python -m ghsim.run_flow prod_notifications_snapshot ezyang ezyang \
  --repo OWNER/REPO \
  --pages 2
```

Notes:
- The owner/trigger arguments can be the same account; no write actions occur.
- The flow only fetches notifications HTML and parsed JSON into `responses/`.
- Do not rely on these fixtures for deterministic tests.

## Non-Reproducible Data

The notifications page is time-sensitive. If you need to re-run the flow after
debugging, generate fresh fixtures and avoid updating existing golden files.

## TODO (Future Me)

- Plan for GitHub HTML changes: add a lightweight migration or fixture
  normalization step.
- Decide how to archive old prod fixtures without blocking parser updates.
