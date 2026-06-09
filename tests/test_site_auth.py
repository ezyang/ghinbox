import asyncio
from pathlib import Path
import socket
import stat
import tempfile

from ghinbox.api.server import _bind_debug_socket
from ghinbox.api import site_auth
from ghinbox.api.site_auth import SiteAuthMiddleware


async def _ok_app(scope, receive, send) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    await send({"type": "http.response.body", "body": b"ok"})


def _request(
    middleware: SiteAuthMiddleware, *, client, server, path: str = "/debug/state"
) -> int:
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": [],
        "client": client,
        "server": server,
    }
    asyncio.run(middleware(scope, receive, send))
    return messages[0]["status"]


def test_site_auth_allows_debug_socket_requests(monkeypatch) -> None:
    monkeypatch.setenv("GHINBOX_SITE_PASSWORD", "secret")
    monkeypatch.setenv("GHINBOX_DEBUG_SOCKET_ENABLED", "1")

    middleware = SiteAuthMiddleware(_ok_app)

    assert _request(middleware, client=None, server=None) == 200
    assert (
        _request(middleware, client=("127.0.0.1", 12345), server=("127.0.0.1", 8000))
        == 401
    )


def test_site_auth_allows_public_github_webhook_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("GHINBOX_SITE_PASSWORD", "secret")

    middleware = SiteAuthMiddleware(_ok_app)

    assert (
        _request(
            middleware,
            client=("127.0.0.1", 12345),
            server=("127.0.0.1", 8000),
            path="/webhooks/github/push",
        )
        == 200
    )
    assert (
        _request(
            middleware,
            client=("127.0.0.1", 12345),
            server=("127.0.0.1", 8000),
            path="/webhooks/github/other",
        )
        == 401
    )


def test_bind_debug_socket_replaces_stale_socket() -> None:
    with tempfile.TemporaryDirectory(prefix="ghs-") as tmp_dir:
        path = Path(tmp_dir) / "debug.sock"

        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(path))
        stale.close()

        sock = _bind_debug_socket(path)
        try:
            mode = path.stat().st_mode
            assert stat.S_ISSOCK(mode)
            assert stat.S_IMODE(mode) == 0o600
        finally:
            sock.close()
            path.unlink()


def test_server_secret_storage_is_private(tmp_path, monkeypatch) -> None:
    auth_state_dir = tmp_path / "auth_state"
    secret_key_file = auth_state_dir / "site_secret.key"
    monkeypatch.setattr(site_auth, "AUTH_STATE_DIR", auth_state_dir)
    monkeypatch.setattr(site_auth, "SECRET_KEY_FILE", secret_key_file)

    site_auth._get_server_secret()

    assert stat.S_IMODE(auth_state_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(secret_key_file.stat().st_mode) == 0o600
