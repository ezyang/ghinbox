# Push-Triggered Deployment

ghinbox can update a clean source checkout when GitHub sends a signed push
webhook for `main`. The receiver is:

```text
POST /webhooks/github/push
```

This exact path bypasses the site-password middleware because GitHub cannot
use a browser session cookie. It instead requires GitHub's
`X-Hub-Signature-256` HMAC signature. Other `/webhooks/github/*` paths remain
behind site authentication.

## Configuration

The server loads a private local settings file at `auth_state/ghinbox.env` by
default. Keep both the site password and webhook secret there so they are not
exposed in process arguments:

```bash
install -m 600 /dev/null auth_state/ghinbox.env
$EDITOR auth_state/ghinbox.env
```

```text
GHINBOX_SITE_PASSWORD=<site access password>
GHINBOX_WEBHOOK_SECRET=<output of: openssl rand -hex 32>
GHINBOX_WEBHOOK_REPOSITORY=ezyang/ghinbox
```

`auth_state/` is gitignored and the server rejects an environment file
accessible by group or other users. Values are literal text without shell
quoting or variable expansion. Start the service without passing secrets on
the command line:

```bash
uv run ghinbox --reload
```

Use `--env-file /path/to/other/private.env` only when a process supervisor
needs to store the file elsewhere.

In the GitHub repository webhook settings:

- Payload URL: `https://ghinbox.cranbury.ezyang.com/webhooks/github/push`
- Content type: `application/json` preferred; `application/x-www-form-urlencoded`
  is also accepted
- Secret: the value of `GHINBOX_WEBHOOK_SECRET`
- Events: only `push`

## Update Safety

For a signed push to `refs/heads/main`, the receiver runs the equivalent of:

```bash
git status --porcelain --untracked-files=normal
git fetch origin refs/heads/main:refs/remotes/origin/main
git merge --ff-only origin/main
```

The update is rejected if the serving checkout is not on `main`, contains
local changes or untracked files, or cannot fast-forward to `origin/main`.
Updates are serialized within the server process.

When the server is running from this source checkout using its default reload
behavior, changed Python, HTML, JavaScript, or CSS sources cause Uvicorn to
reload. For a service started with `--no-reload`, arrange an external service
restart after updates before relying on this mechanism for production.

## Optional Host Isolation

Nginx may expose only this endpoint on a dedicated hostname while forwarding
it to the same process:

```nginx
location = /webhooks/github/push {
    proxy_pass http://127.0.0.1:8000;
}
```

A separate hostname reduces exposed routing surface, but it does not replace
signature validation; keep the webhook secret configured in either layout.
