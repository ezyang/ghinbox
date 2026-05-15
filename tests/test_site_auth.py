import asyncio
import socket
import stat

from ghinbox.api.server import _bind_debug_socket
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


def _request(middleware: SiteAuthMiddleware, *, client, server) -> int:
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/debug/state",
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


def test_bind_debug_socket_replaces_stale_socket(tmp_path) -> None:
    path = tmp_path / "debug.sock"

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
