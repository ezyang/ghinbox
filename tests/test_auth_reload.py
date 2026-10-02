"""Web login must survive a worker auto-reload.

The server parent decides at startup whether GitHub auth is missing and sets
GHINBOX_NEEDS_AUTH=1 in its environment. Web login clears that flag only in
the worker process; StatReload respawns the worker from the parent's env, so
the worker must notice on startup that a login happened since then.
"""

import asyncio
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI

from ghinbox import auth_common
from ghinbox.api import app as app_module
from ghinbox.api import login_routes, server


class FakeFetcher:
    def __init__(self, account: str, headless: bool) -> None:
        self.account = account
        self.headless = headless

    def stop(self) -> None:
        pass


@pytest.fixture
def auth_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "auth_state"
    path.mkdir()
    monkeypatch.setattr(auth_common, "AUTH_STATE_DIR", path)
    return path


@pytest.fixture
def stored_fetcher(monkeypatch: pytest.MonkeyPatch) -> list[object]:
    stored: list[object] = [None]

    def fake_set_fetcher(fetcher: object) -> None:
        stored[0] = fetcher

    async def fake_run_fetcher_call(func, *args, **kwargs):
        return func(*args, **kwargs)

    for module in (app_module, login_routes):
        monkeypatch.setattr(module, "NotificationsFetcher", FakeFetcher)
        monkeypatch.setattr(module, "set_fetcher", fake_set_fetcher)
        monkeypatch.setattr(module, "get_fetcher", lambda: stored[0])
        monkeypatch.setattr(module, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(app_module, "shutdown_fetcher_executor", lambda: None)
    monkeypatch.setenv("GHINBOX_SNAPSHOT_SYNC_INTERVAL_SECONDS", "0")
    return stored


def _start_worker(stored: list[object]) -> object:
    """Run the app lifespan startup the way a freshly spawned worker would."""
    seen: list[object] = []

    async def run() -> None:
        async with app_module.lifespan(FastAPI()):
            seen.append(stored[0])

    asyncio.run(run())
    return seen[0]


def _start_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GHINBOX_TEST_MODE", raising=False)
    monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "ghinbox.api.server",
            "--no-reload",
            "--no-debug-socket",
            "--no-request-log",
            "--env-file",
            str(tmp_path / "missing.env"),
            "--port",
            "0",
        ],
    )
    monkeypatch.setattr(server, "_run_uvicorn", lambda **kwargs: None)
    assert server.main() == 0


def _write_auth_state(auth_dir: Path, mtime: float) -> None:
    path = auth_dir / "default.json"
    path.write_text('{"cookies": [], "origins": []}')
    os.utime(path, (mtime, mtime))


def test_reloaded_worker_keeps_web_login_made_after_startup(
    auth_dir: Path,
    stored_fetcher: list[object],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Parent starts with no stored browser auth: web-login mode.
    _start_parent(tmp_path, monkeypatch)
    assert os.environ["GHINBOX_NEEDS_AUTH"] == "1"
    parent_env = dict(os.environ)

    # The user completes web login, which writes fresh auth state.
    _write_auth_state(auth_dir, mtime=2_000_000_000)

    # A code change respawns the worker from the parent's environment.
    os.environ.clear()
    os.environ.update(parent_env)
    fetcher = _start_worker(stored_fetcher)

    assert "GHINBOX_NEEDS_AUTH" not in os.environ
    assert os.environ["GHINBOX_ACCOUNT"] == "default"
    assert isinstance(fetcher, FakeFetcher)
    assert fetcher.account == "default"
    assert asyncio.run(login_routes.needs_login()) == {
        "needs_login": False,
        "account": "default",
    }


def test_reloaded_worker_keeps_needing_auth_without_new_login(
    auth_dir: Path,
    stored_fetcher: list[object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Parent judged this (unchanged) auth state invalid at startup.
    _write_auth_state(auth_dir, mtime=1_000_000_000)
    monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")
    monkeypatch.setenv(login_routes.NEEDS_AUTH_STATE_MTIME_ENV, "1000000000.0")
    monkeypatch.delenv("GHINBOX_ACCOUNT", raising=False)

    fetcher = _start_worker(stored_fetcher)

    assert os.environ["GHINBOX_NEEDS_AUTH"] == "1"
    assert fetcher is None
    assert asyncio.run(login_routes.needs_login()) == {
        "needs_login": True,
        "account": "default",
    }


def test_reloaded_worker_recovers_when_stale_auth_was_replaced(
    auth_dir: Path,
    stored_fetcher: list[object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Expired token + expired browser session at startup; the parent does not
    # set GHINBOX_ACCOUNT on that path, so the worker must default it.
    monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")
    monkeypatch.setenv(login_routes.NEEDS_AUTH_STATE_MTIME_ENV, "1000000000.0")
    monkeypatch.delenv("GHINBOX_ACCOUNT", raising=False)
    _write_auth_state(auth_dir, mtime=1_000_000_500)

    fetcher = _start_worker(stored_fetcher)

    assert "GHINBOX_NEEDS_AUTH" not in os.environ
    assert os.environ["GHINBOX_ACCOUNT"] == "default"
    assert isinstance(fetcher, FakeFetcher)
