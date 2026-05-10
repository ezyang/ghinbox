"""Tests for server-owned notification snapshot construction."""

import asyncio
import os
import tempfile

import pytest

from ghinbox.api import snapshot_routes
from ghinbox.api.fetcher import FetchResult
from ghinbox.api.snapshot_store import get_snapshot, init_snapshot_db


@pytest.fixture
def db_path(monkeypatch: pytest.MonkeyPatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setenv("GHINBOX_SNAPSHOT_DB_PATH", path)
    init_snapshot_db(path)
    yield path
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass


def test_review_request_search_query_matches_client() -> None:
    query = snapshot_routes._build_review_request_search_query("pytorch", "pytorch")

    assert query == (
        "repo:pytorch/pytorch is:pr is:open user-review-requested:@me -review:approved"
    )


def test_search_item_becomes_synthetic_review_request_notification() -> None:
    notification = snapshot_routes._search_item_to_review_request_notification(
        "test",
        "repo",
        {
            "number": 10,
            "title": "Needs review",
            "html_url": "https://github.com/test/repo/pull/10",
            "draft": False,
            "updated_at": "2025-01-05T12:00:00Z",
            "created_at": "2025-01-05T10:00:00Z",
            "user": {
                "login": "alice",
                "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
            },
            "pull_request": {},
        },
    )

    assert notification is not None
    assert notification["id"] == "review-request:test/repo#10"
    assert notification["reason"] == "review_requested"
    assert notification["responsibility_source"] == "review-requested"
    assert notification["subject"]["type"] == "PullRequest"
    assert notification["subject"]["number"] == 10
    assert notification["subject"]["state"] == "open"
    assert notification["actors"] == [
        {
            "login": "alice",
            "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4",
        }
    ]
    assert notification["ui"]["action_tokens"] == {}


def test_snapshot_sync_merges_review_request_search_results(
    db_path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeFetcher:
        def fetch_repo_notifications(
            self,
            owner: str,
            repo: str,
            before: str | None = None,
            after: str | None = None,
        ) -> FetchResult:
            raise AssertionError("run_fetcher_call should invoke this through the shim")

    async def fake_run_fetcher_call(*args, **kwargs) -> FetchResult:
        assert kwargs["owner"] == "test"
        assert kwargs["repo"] == "repo"
        assert kwargs["after"] is None
        return FetchResult(
            html="<html></html>",
            url="https://github.com/notifications?query=repo:test/repo",
            status="ok",
        )

    async def fake_review_requests(owner: str, repo: str) -> list[dict]:
        assert owner == "test"
        assert repo == "repo"
        return [
            {
                "id": "review-request:test/repo#10",
                "unread": False,
                "reason": "review_requested",
                "responsibility_source": "review-requested",
                "updated_at": "2025-01-05T12:00:00Z",
                "last_read_at": "2025-01-05T12:00:00Z",
                "subject": {
                    "title": "Needs review",
                    "url": "https://github.com/test/repo/pull/10",
                    "type": "PullRequest",
                    "number": 10,
                    "state": "open",
                    "state_reason": None,
                },
                "actors": [],
                "ui": {"saved": False, "done": False, "action_tokens": {}},
            }
        ]

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(
        snapshot_routes,
        "_fetch_review_request_notifications",
        fake_review_requests,
    )

    asyncio.run(snapshot_routes._fetch_snapshot("test", "repo"))

    snapshot = get_snapshot("test/repo", db_path)
    assert snapshot is not None
    assert snapshot["notifications"] == [
        {
            "id": "review-request:test/repo#10",
            "unread": False,
            "reason": "review_requested",
            "responsibility_source": "review-requested",
            "updated_at": "2025-01-05T12:00:00Z",
            "last_read_at": "2025-01-05T12:00:00Z",
            "subject": {
                "title": "Needs review",
                "url": "https://github.com/test/repo/pull/10",
                "type": "PullRequest",
                "number": 10,
                "state": "open",
                "state_reason": None,
            },
            "actors": [],
            "ui": {"saved": False, "done": False, "action_tokens": {}},
        }
    ]
