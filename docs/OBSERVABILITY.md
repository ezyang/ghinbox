# Production Observability

ghinbox exposes a small local debug API and JSONL request logging for live
troubleshooting.  The debug API is served by the same FastAPI process and is
protected by the site password when `--site-password` is configured.
By default, the CLI also exposes the same HTTP app on
`auth_state/ghinbox-debug.sock` for local shell/agent access. That socket
bypasses the site password gate and must not be proxied remotely.

## Request logs

When started through the CLI, ghinbox writes request metadata to
`logs/ghinbox.log` by default:

Configure `GHINBOX_SITE_PASSWORD` in the private `auth_state/ghinbox.env`
launch settings file described in
[DEPLOYMENT_WEBHOOK.md](DEPLOYMENT_WEBHOOK.md), then run:

```bash
uv run ghinbox
```

Each line is a JSON object with:

- `timestamp`
- `request_id`
- `method`
- `path`
- `query`
- `status_code`
- `duration_ms`
- `client`
- `user_agent`

Request and response bodies are not logged.  Authorization headers, cookies,
GitHub tokens, and site passwords are not logged.

Outbound GitHub API audit events are written to the same JSONL file when
request logging is enabled. These events use `event: "github_api_call"` and
record method, sanitized GitHub endpoint path, query key names, status, source
label, duration, and any GitHub `x-ratelimit-*` response headers. Query values,
request bodies, response bodies, authorization headers, and tokens are not
logged.

Use `--log-file` to choose another file:

```bash
uv run ghinbox --log-file /tmp/ghinbox.log
```

Use `--no-request-log` to disable file logging while keeping the in-memory
recent request buffer:

```bash
uv run ghinbox --no-request-log
```

The file logger rotates at 5 MiB and keeps 3 backups.

## Debug endpoints

`GET /debug/state` returns non-secret server state:

```bash
curl -sS -b cookies.txt http://127.0.0.1:8000/debug/state
```

From a local shell on the server host, prefer the Unix socket:

```bash
curl -sS --unix-socket auth_state/ghinbox-debug.sock \
  http://ghinbox/debug/state
```

Useful fields include whether test mode is enabled, whether site auth is
enabled, whether live fetching is configured, the active account name, and the
request log path.

`GET /debug/requests` returns the recent in-memory request buffer:

```bash
curl -sS -b cookies.txt 'http://127.0.0.1:8000/debug/requests?limit=20'
```

`POST /debug/requests/clear` clears only the in-memory buffer:

```bash
curl -sS -X POST -b cookies.txt http://127.0.0.1:8000/debug/requests/clear
```

`GET /debug/github-api-calls` reports recent sanitized outbound GitHub API
calls, including source labels and rate-limit response headers:

```bash
curl -sS --unix-socket auth_state/ghinbox-debug.sock \
  'http://ghinbox/debug/github-api-calls?limit=50'
```

`POST /debug/github-api-calls/clear` clears that in-memory buffer.

`GET /debug/deployments` reports signed webhook deployment decisions without
recording request bodies or secrets. It includes GitHub delivery and request
IDs, repository/ref, outcome, and commit IDs for accepted updates:

```bash
curl -sS --unix-socket auth_state/ghinbox-debug.sock \
  http://ghinbox/debug/deployments
```

Every HTTP response includes an `x-ghinbox-request-id` header.  Use that value
to connect a browser/API failure with `/debug/requests` or a JSONL log line.

## Site password with curl

If the server was started with `--site-password`, first create a cookie jar:

```bash
curl -sS -c cookies.txt \
  -d "password=$GHINBOX_SITE_PASSWORD" \
  -d "next=/" \
  http://127.0.0.1:8000/site-auth/login
```

Then pass `-b cookies.txt` to debug API calls.

## Current scope

The observability layer records server request metadata and sanitized outbound
GitHub API metadata.  It does not capture GitHub API response bodies or
Playwright page HTML.  Use the existing `responses/` capture flows when you
need fixture-quality GitHub responses.
