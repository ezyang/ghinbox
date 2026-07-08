"""Tests for local-only notification state routes."""

import os
import tempfile
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from ghinbox.api.app import app
from ghinbox.api.snapshot_store import init_snapshot_db


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setenv("GHINBOX_SNAPSHOT_DB_PATH", path)
    init_snapshot_db(path)
    yield TestClient(app)
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass


@pytest.mark.parametrize(
    ("path", "payload", "field", "value"),
    [
        ("bookmarks", {"bookmarked": True}, "bookmarked", True),
        ("replies-muted", {"replies_muted": True}, "replies_muted", True),
        (
            "read-comment-watermarks",
            {"read_comment_watermark_at": "2026-01-07T12:00:00Z"},
            "read_comment_watermark_at",
            "2026-01-07T12:00:00Z",
        ),
    ],
)
def test_local_state_routes_accept_synthetic_review_request_ids(
    client: TestClient,
    path: str,
    payload: dict[str, bool | str],
    field: str,
    value: bool | str,
) -> None:
    notification_id = "review-request:test/repo#42"
    response = client.put(
        f"/notifications/html/repo/test/repo/{path}/{quote(notification_id, safe='')}",
        json=payload,
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "repo": "test/repo",
        "notification_id": notification_id,
        field: value,
    }
