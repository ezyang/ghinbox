"""Shared pytest fixtures."""

import os
import tempfile
from pathlib import Path

import pytest

from ghinbox.api import site_auth
from ghinbox.api.snapshot_store import init_snapshot_db

_ENV_PREFIXES = ("GHINBOX_",)


@pytest.fixture(autouse=True)
def _restore_ghinbox_env():
    # App code mutates os.environ directly (e.g. mark_github_session_expired
    # sets GHINBOX_NEEDS_AUTH, _load_env_file sets secrets), which monkeypatch
    # cannot undo. Snapshot and restore so tests cannot leak env state.
    saved = {
        key: value for key, value in os.environ.items() if key.startswith(_ENV_PREFIXES)
    }
    yield
    for key in list(os.environ):
        if key.startswith(_ENV_PREFIXES) and key not in saved:
            del os.environ[key]
    os.environ.update(saved)


@pytest.fixture(autouse=True)
def _isolated_site_auth_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # SiteAuthMiddleware lazily writes auth_state/site_secret.key on
    # construction; point it at a temp dir so tests never touch the repo's
    # auth_state directory.
    auth_dir = tmp_path / "auth_state"
    monkeypatch.setattr(site_auth, "AUTH_STATE_DIR", auth_dir)
    monkeypatch.setattr(site_auth, "SECRET_KEY_FILE", auth_dir / "site_secret.key")


@pytest.fixture(autouse=True)
def _isolated_snapshot_db(_restore_ghinbox_env, monkeypatch: pytest.MonkeyPatch):
    # TestClient(app) without a context manager never runs the app lifespan,
    # so the snapshot tables must be created here. A temp path also keeps
    # tests from touching the developer's auth_state/ghinbox_snapshots.db.
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setenv("GHINBOX_SNAPSHOT_DB_PATH", path)
    init_snapshot_db(path)
    yield
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass
