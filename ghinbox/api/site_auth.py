"""
Site-level password authentication.

Cookie-based password gate protecting the entire site with a single shared
password.  When ``GHINBOX_SITE_PASSWORD`` is set the middleware redirects
unauthenticated browsers to a login form and returns 401 for API calls.

The password is never stored — only a PBKDF2 hash derived with the server
secret as salt.  The cookie is signed with ``HMAC(server_secret,
password_hash)`` so rotating either the password *or* the secret
invalidates all sessions.
"""

import hashlib
import hmac
import os
import secrets
import string
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

AUTH_STATE_DIR = Path("auth_state")
SECRET_KEY_FILE = AUTH_STATE_DIR / "site_secret.key"
COOKIE_NAME = "ghinbox_site_session"
COOKIE_MAX_AGE = 7 * 24 * 60 * 60  # 7 days in seconds
PBKDF2_ITERATIONS = 600_000

# Paths that are always accessible without authentication
EXEMPT_PREFIXES = ("/site-auth/", "/health")


def _get_server_secret() -> bytes:
    """Return (and lazily create) a persistent 32-byte server secret."""
    if SECRET_KEY_FILE.exists():
        return SECRET_KEY_FILE.read_bytes()
    AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_bytes(32)
    SECRET_KEY_FILE.write_bytes(secret)
    return secret


def _password_hash(password: str, server_secret: bytes) -> bytes:
    """PBKDF2-HMAC-SHA256 hash of *password* salted with *server_secret*."""
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode(),
        server_secret,
        PBKDF2_ITERATIONS,
    )


def _signing_key(server_secret: bytes, pw_hash: bytes) -> bytes:
    """Derive a signing key so that changing password or secret invalidates cookies."""
    return hmac.new(server_secret, pw_hash, "sha256").digest()


def _make_serializer(signing_key: bytes) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(signing_key)


# ---------------------------------------------------------------------------
# ASGI middleware
# ---------------------------------------------------------------------------


class SiteAuthMiddleware:
    """Raw ASGI middleware that enforces site-level password auth."""

    def __init__(self, app):
        self.app = app
        self._password: str | None = os.environ.get("GHINBOX_SITE_PASSWORD")
        self._test_mode: bool = os.environ.get("GHINBOX_TEST_MODE") == "1"

        if self._password:
            secret = _get_server_secret()
            pw_hash = _password_hash(self._password, secret)
            self._signing_key = _signing_key(secret, pw_hash)
        else:
            self._signing_key = b""

    # -- helpers ------------------------------------------------------------

    def _is_exempt(self, path: str) -> bool:
        for prefix in EXEMPT_PREFIXES:
            if path.startswith(prefix):
                return True
        return False

    def _cookie_from_headers(self, headers: list[tuple[bytes, bytes]]) -> str | None:
        for key, value in headers:
            if key == b"cookie":
                for part in value.decode().split(";"):
                    part = part.strip()
                    if part.startswith(f"{COOKIE_NAME}="):
                        return part[len(COOKIE_NAME) + 1 :]
        return None

    def _is_authenticated(self, cookie_value: str) -> bool:
        try:
            serializer = _make_serializer(self._signing_key)
            serializer.loads(cookie_value, max_age=COOKIE_MAX_AGE)
            return True
        except (BadSignature, SignatureExpired):
            return False

    @staticmethod
    def _wants_html(headers: list[tuple[bytes, bytes]]) -> bool:
        for key, value in headers:
            if key == b"accept":
                return b"text/html" in value
        return False

    # -- ASGI ---------------------------------------------------------------

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Bypass when no password configured or in test mode
        if not self._password or self._test_mode:
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "/")

        if self._is_exempt(path):
            await self.app(scope, receive, send)
            return

        # Check cookie
        headers = scope.get("headers", [])
        cookie = self._cookie_from_headers(headers)
        if cookie and self._is_authenticated(cookie):
            await self.app(scope, receive, send)
            return

        # Not authenticated — respond appropriately
        if self._wants_html(headers):
            redirect_url = f"/site-auth/login?next={quote(path, safe='')}"
            response = RedirectResponse(url=redirect_url, status_code=302)
        else:
            response = Response(
                content='{"detail":"Site authentication required"}',
                status_code=401,
                media_type="application/json",
            )

        await response(scope, receive, send)


# ---------------------------------------------------------------------------
# FastAPI router for login / logout
# ---------------------------------------------------------------------------

_LOGIN_TEMPLATE = string.Template("""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — ghinbox</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         display: flex; justify-content: center; align-items: center; min-height: 100vh;
         margin: 0; background: #f6f8fa; color: #24292f; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px;
          padding: 2rem; width: 340px; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  h1 { font-size: 1.25rem; margin: 0 0 1.5rem; text-align: center; }
  .warning { background: #fff5f5; border: 1px solid #ffd7d7; color: #b62324;
             padding: .75rem; border-radius: 6px; font-size: .8125rem;
             margin-bottom: 1rem; line-height: 1.4; }
  label { display: block; font-size: .875rem; font-weight: 600; margin-bottom: .25rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; font-size: .875rem;
                          border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 1rem; }
  button { width: 100%; padding: .6rem; font-size: .875rem; font-weight: 600;
           background: #2da44e; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #2c974b; }
  .error { color: #cf222e; font-size: .8125rem; margin-bottom: 1rem; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>ghinbox</h1>
  $warning
  $error
  <form method="post" action="/site-auth/login">
    <input type="hidden" name="next" value="$next_url">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>
""")

router = APIRouter(prefix="/site-auth", tags=["site-auth"])


def _warning_banner(request: Request) -> str:
    site_password = os.environ.get("GHINBOX_SITE_PASSWORD", "")
    if site_password:
        return ""

    hostname = request.url.hostname or ""
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return ""

    return (
        '<div class="warning">'
        "<strong>Warning:</strong> No site password is configured, so anyone who can "
        "reach this server can access and use your GitHub credentials. Set "
        "<code>GHINBOX_SITE_PASSWORD</code> before exposing ghinbox publicly."
        "</div>"
    )


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, next: str = "/"):
    html = _LOGIN_TEMPLATE.substitute(
        next_url=next,
        error="",
        warning=_warning_banner(request),
    )
    return HTMLResponse(content=html)


@router.post("/login")
async def login_submit(request: Request):
    form = await request.form()
    password = form.get("password", "")
    next_url = form.get("next", "/")

    site_password = os.environ.get("GHINBOX_SITE_PASSWORD", "")
    if not site_password or not hmac.compare_digest(str(password), site_password):
        html = _LOGIN_TEMPLATE.substitute(
            next_url=next_url,
            error='<p class="error">Incorrect password.</p>',
            warning=_warning_banner(request),
        )
        return HTMLResponse(content=html, status_code=403)

    # Build signed cookie
    secret = _get_server_secret()
    pw_hash = _password_hash(site_password, secret)
    key = _signing_key(secret, pw_hash)
    serializer = _make_serializer(key)
    token = serializer.dumps({"ok": True})

    # Determine if Secure flag should be set
    scheme = request.url.scheme
    secure = scheme == "https"

    response = RedirectResponse(url=str(next_url), status_code=302)
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
        secure=secure,
    )
    return response


@router.post("/logout")
async def logout():
    response = RedirectResponse(url="/site-auth/login", status_code=302)
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
