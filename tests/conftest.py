"""Shared pytest fixtures."""

import os
import tempfile

import pytest

from ghinbox.api.snapshot_store import init_snapshot_db


@pytest.fixture(autouse=True)
def _isolated_snapshot_db(monkeypatch: pytest.MonkeyPatch):
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
