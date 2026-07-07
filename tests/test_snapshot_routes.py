"""Tests for server-owned notification snapshot construction."""

import asyncio
import os
import tempfile
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from ghinbox.api import github_proxy, notification_shapes, snapshot_routes
from ghinbox.api.fetcher import FetchResult
from ghinbox.api.snapshot_store import (
    get_snapshot,
    get_sync_state,
    init_snapshot_db,
    save_snapshot,
    set_notification_read_comment_watermark,
)


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
    query = notification_shapes.build_review_request_search_query("pytorch", "pytorch")

    assert query == "repo:pytorch/pytorch is:pr is:open user-review-requested:@me"


def test_search_item_becomes_synthetic_review_request_notification() -> None:
    notification = notification_shapes.search_item_to_review_request_notification(
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
    assert notification["repository"] == {
        "owner": "test",
        "name": "repo",
        "full_name": "test/repo",
    }
    assert notification["subject"]["type"] == "PullRequest"
    assert notification["subject"]["number"] == 10
    assert notification["subject"]["state"] == "open"
    assert notification["last_read_at"] is None
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

    async def fake_review_requests(
        owner: str, repo: str, query: str | None = None
    ) -> list[dict]:
        assert owner == "test"
        assert repo == "repo"
        return [
            {
                "id": "review-request:test/repo#10",
                "unread": False,
                "reason": "review_requested",
                "responsibility_source": "review-requested",
                "updated_at": "2025-01-05T12:00:00Z",
                "last_read_at": None,
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

    set_notification_read_comment_watermark(
        "test/repo",
        "review-request:test/repo#10",
        "2025-01-05T11:30:00Z",
        db_path,
    )
    captured_comment_cache_notifications: list[dict] = []

    async def fake_fetch_snapshot_comment_cache(
        owner: str | None,
        repo: str | None,
        notifications: list[dict],
        *,
        on_progress=None,
    ) -> dict:
        assert owner is None
        assert repo is None
        captured_comment_cache_notifications.extend(notifications)
        intermediate_snapshot = get_snapshot("test/repo", db_path)
        assert intermediate_snapshot is not None
        assert intermediate_snapshot["notifications"][0]["id"] == (
            "review-request:test/repo#10"
        )
        assert intermediate_snapshot["comment_cache"] is None
        if on_progress is not None:
            on_progress(("review-request:test/repo#10", {"comments": []}))
        return {"version": 1, "threads": {}}

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(
        snapshot_routes,
        "fetch_review_request_notifications",
        fake_review_requests,
    )
    monkeypatch.setattr(
        snapshot_routes,
        "_fetch_snapshot_comment_cache",
        fake_fetch_snapshot_comment_cache,
    )

    asyncio.run(
        snapshot_routes._fetch_snapshot(
            "test/repo", [snapshot_routes._entry_for_repo("test", "repo")]
        )
    )

    snapshot = get_snapshot("test/repo", db_path)
    assert snapshot is not None
    assert snapshot["notifications"] == [
        {
            "id": "review-request:test/repo#10",
            "unread": False,
            "reason": "review_requested",
            "responsibility_source": "review-requested",
            "updated_at": "2025-01-05T12:00:00Z",
            "last_read_at": None,
            "subject": {
                "title": "Needs review",
                "url": "https://github.com/test/repo/pull/10",
                "type": "PullRequest",
                "number": 10,
                "state": "open",
                "state_reason": None,
            },
            "actors": [],
            "ui": {
                "saved": False,
                "done": False,
                "action_tokens": {},
                "bookmarked": False,
                "replies_muted": False,
                "read_comment_watermark_at": "2025-01-05T11:30:00Z",
            },
        }
    ]
    assert (
        captured_comment_cache_notifications[0]["ui"]["read_comment_watermark_at"]
        == "2025-01-05T11:30:00Z"
    )
    sync_state = get_sync_state("test/repo", db_path)
    assert sync_state["phase"] == "complete"
    assert sync_state["comments_total"] == 1
    assert sync_state["comments_fetched"] == 1
    assert sync_state["comments_failed"] == 0


def test_full_snapshot_sync_replaces_stale_stored_notifications(
    db_path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stale_notification = {
        "id": "stale-id",
        "updated_at": "2025-01-04T12:00:00Z",
        "subject": {"title": "Stale", "type": "Issue", "number": 1},
    }
    fresh_notification = {
        "id": "fresh-id",
        "unread": True,
        "reason": "review_requested",
        "updated_at": "2025-01-05T12:00:00Z",
        "last_read_at": None,
        "responsibility_source": "review-requested",
        "subject": {
            "title": "Fresh upstream review request",
            "url": "https://github.com/test/repo/pull/2",
            "type": "PullRequest",
            "number": 2,
            "state": "open",
            "state_reason": None,
        },
        "actors": [],
        "ui": {"saved": False, "done": False, "action_tokens": {}},
    }
    save_snapshot(
        "test/repo",
        [stale_notification],
        comment_cache={
            "version": 1,
            "threads": {
                "stale-id": {
                    "comments": [{"id": 1, "body": "stale"}],
                    "allComments": True,
                    "fetchedAt": "2025-01-04T12:00:01Z",
                }
            },
        },
        db_path=db_path,
    )

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

    async def fake_review_requests(
        owner: str, repo: str, query: str | None = None
    ) -> list[dict]:
        assert owner == "test"
        assert repo == "repo"
        return [fresh_notification]

    async def fake_fetch_snapshot_comment_cache(
        owner: str | None,
        repo: str | None,
        notifications: list[dict],
        *,
        on_progress=None,
    ) -> dict:
        assert owner is None
        assert repo is None
        assert [notification["id"] for notification in notifications] == ["fresh-id"]
        if on_progress is not None:
            on_progress(("fresh-id", {"comments": []}))
        return {
            "version": 1,
            "threads": {
                "fresh-id": {
                    "comments": [],
                    "allComments": True,
                    "fetchedAt": "2025-01-05T12:00:01Z",
                }
            },
        }

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(
        snapshot_routes,
        "fetch_review_request_notifications",
        fake_review_requests,
    )
    monkeypatch.setattr(
        snapshot_routes,
        "_fetch_snapshot_comment_cache",
        fake_fetch_snapshot_comment_cache,
    )

    asyncio.run(
        snapshot_routes._fetch_snapshot(
            "test/repo", [snapshot_routes._entry_for_repo("test", "repo")]
        )
    )

    snapshot = get_snapshot("test/repo", db_path)
    assert snapshot is not None
    assert [notification["id"] for notification in snapshot["notifications"]] == [
        "fresh-id"
    ]
    assert snapshot["comment_cache"]["threads"].keys() == {"fresh-id"}


def test_snapshot_sync_starts_review_request_search_during_notification_fetch(
    db_path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

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
        events.append("notifications-start")
        await asyncio.sleep(0)
        events.append("notifications-finish")
        return FetchResult(
            html="<html></html>",
            url="https://github.com/notifications?query=repo:test/repo",
            status="ok",
        )

    async def fake_review_requests(
        owner: str, repo: str, query: str | None = None
    ) -> list[dict]:
        assert owner == "test"
        assert repo == "repo"
        events.append("reviews-start")
        return []

    async def fake_fetch_snapshot_comment_cache(
        owner: str | None,
        repo: str | None,
        notifications: list[dict],
        *,
        on_progress=None,
    ) -> dict:
        assert owner == "test"
        assert repo == "repo"
        assert notifications == []
        return {"version": 1, "threads": {}}

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(
        snapshot_routes,
        "fetch_review_request_notifications",
        fake_review_requests,
    )
    monkeypatch.setattr(
        snapshot_routes,
        "_fetch_snapshot_comment_cache",
        fake_fetch_snapshot_comment_cache,
    )

    asyncio.run(
        snapshot_routes._fetch_snapshot(
            "test/repo", [snapshot_routes._entry_for_repo("test", "repo")]
        )
    )

    assert events.index("reviews-start") < events.index("notifications-finish")


def test_snapshot_comment_cache_uses_bulk_comment_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notifications = [
        {
            "id": "issue-1",
            "unread": True,
            "updated_at": "2025-01-05T12:00:00Z",
            "last_read_at": "2025-01-05T11:00:00Z",
            "subject": {
                "type": "Issue",
                "number": 1,
            },
        },
        {
            "id": "pr-2",
            "unread": False,
            "updated_at": "2025-01-05T10:00:00Z",
            "subject": {
                "type": "PullRequest",
                "number": 2,
                "anchor": "discussion_r1",
            },
        },
    ]
    captured_items = []
    fake_client = object()

    async def fake_fetch_bulk_comment_item(
        client,
        token: str,
        item: dict,
        *,
        request_id: str | None = None,
    ):
        assert client is fake_client
        assert token == "token"
        assert request_id is None
        captured_items.append(item)
        return item["key"], {
            "comments": [{"id": item["number"], "body": f"comment {item['number']}"}],
            "allComments": bool(item.get("anchor") or not item.get("last_read_at")),
        }

    monkeypatch.setattr(snapshot_routes, "get_token", lambda: "token")
    monkeypatch.setattr(github_proxy, "get_client", lambda: fake_client)
    monkeypatch.setattr(
        github_proxy,
        "_fetch_bulk_comment_item",
        fake_fetch_bulk_comment_item,
    )

    cache = asyncio.run(
        snapshot_routes._fetch_snapshot_comment_cache("test", "repo", notifications)
    )

    assert captured_items == [
        {
            "key": "issue-1",
            "owner": "test",
            "repo": "repo",
            "number": 1,
            "is_pr": False,
            "subject_state": None,
            "anchor": None,
            "last_read_at": "2025-01-05T11:00:00Z",
        },
        {
            "key": "pr-2",
            "owner": "test",
            "repo": "repo",
            "number": 2,
            "is_pr": True,
            "subject_state": None,
            "anchor": "discussion_r1",
            "last_read_at": None,
        },
    ]
    assert cache is not None
    assert cache["version"] == 1
    assert cache["threads"]["issue-1"]["comments"] == [{"id": 1, "body": "comment 1"}]
    assert cache["threads"]["issue-1"]["stateEvents"] == []
    assert cache["threads"]["issue-1"]["lastReadAt"] == "2025-01-05T11:00:00Z"
    assert cache["threads"]["issue-1"]["allComments"] is False
    assert cache["threads"]["pr-2"]["anchor"] == "discussion_r1"
    assert cache["threads"]["pr-2"]["allComments"] is True
    assert cache["threads"]["pr-2"]["fetchedAt"]


def test_snapshot_sync_marks_auth_needed_on_session_expiry(
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
        return FetchResult(
            html="<html><title>Sign in to GitHub</title></html>",
            url="https://github.com/notifications?query=repo:test/repo",
            status="session_expired",
            error="GitHub redirected notifications request to login.",
        )

    monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)

    asyncio.run(
        snapshot_routes._fetch_snapshot(
            "test/repo", [snapshot_routes._entry_for_repo("test", "repo")]
        )
    )

    state = snapshot_routes.get_sync_state("test/repo")
    assert state["status"] == "error"
    assert "redirected notifications request to login" in state["error"]
    assert os.environ["GHINBOX_NEEDS_AUTH"] == "1"


def test_snapshot_sync_errors_when_pagination_exceeds_cap(
    db_path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cursor walk that never reports has_next=False must fail the sync
    instead of fetching pages forever and burning the GitHub rate limit."""
    calls: list[str | None] = []

    class FakeFetcher:
        def fetch_repo_notifications(
            self,
            owner: str,
            repo: str,
            before: str | None = None,
            after: str | None = None,
        ) -> FetchResult:
            raise AssertionError("run_fetcher_call should invoke this through the shim")

    async def fake_run_fetcher_call(fetcher_call, **kwargs) -> FetchResult:
        calls.append(kwargs["after"])
        return FetchResult(
            html="<html></html>",
            url="https://github.com/notifications?query=repo:test/repo",
            status="ok",
        )

    async def fake_review_requests(
        owner: str | None, repo: str | None, query: str | None = None
    ) -> list[dict]:
        return []

    def fake_parse_notifications_html(
        *,
        html: str,
        owner: str,
        repo: str,
        source_url: str,
    ):
        return SimpleNamespace(
            notifications=[],
            authenticity_token=None,
            source_url=source_url,
            generated_at=datetime(2025, 1, 5, 12, 0, tzinfo=timezone.utc),
            pagination=SimpleNamespace(
                has_next=True,
                after_cursor=f"cursor-{len(calls)}",
            ),
        )

    monkeypatch.setattr(snapshot_routes, "MAX_SNAPSHOT_FETCH_PAGES", 2)
    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(
        snapshot_routes,
        "fetch_review_request_notifications",
        fake_review_requests,
    )
    monkeypatch.setattr(
        snapshot_routes,
        "parse_notifications_html",
        fake_parse_notifications_html,
    )

    asyncio.run(
        snapshot_routes._fetch_snapshot(
            "test/repo", [snapshot_routes._entry_for_repo("test", "repo")]
        )
    )

    assert calls == [None, "cursor-1"]
    sync_state = get_sync_state("test/repo", db_path)
    assert sync_state["status"] == "error"
    assert "exceeded 2" in sync_state["error"]


def test_profile_snapshot_syncs_multiple_query_entries(
    db_path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A profile of two org: queries fetches each, scopes review-request search
    to each query, merges into one snapshot keyed by the profile."""

    class FakeFetcher:
        def fetch_repo_notifications(self, *args, **kwargs) -> FetchResult:
            raise AssertionError("query entries should not hit repo fetch")

        def fetch_notifications_query(self, *args, **kwargs) -> FetchResult:
            raise AssertionError("run_fetcher_call should invoke this through the shim")

    seen_queries: list[str] = []

    async def fake_run_fetcher_call(func, /, **kwargs) -> FetchResult:
        # Only query entries are used in this profile.
        seen_queries.append(kwargs["query"])
        return FetchResult(
            html="<html></html>",
            url=f"https://github.com/notifications?query={kwargs['query']}",
            status="ok",
        )

    review_queries: list[str | None] = []

    async def fake_review_requests(
        owner: str | None, repo: str | None, query: str | None = None
    ) -> list[dict]:
        review_queries.append(query)
        number = 1 if query == "org:pytorch" else 2
        return [
            {
                "id": f"review-request:{query}#{number}",
                "unread": False,
                "reason": "review_requested",
                "responsibility_source": "review-requested",
                "updated_at": "2025-01-05T12:00:00Z",
                "last_read_at": None,
                "subject": {
                    "title": "Needs review",
                    "url": "https://github.com/x/y/pull/1",
                    "type": "PullRequest",
                    "number": number,
                    "state": "open",
                    "state_reason": None,
                },
                "actors": [],
                "ui": {"saved": False, "done": False, "action_tokens": {}},
            }
        ]

    async def fake_fetch_snapshot_comment_cache(
        owner: str | None,
        repo: str | None,
        notifications: list[dict],
        *,
        on_progress=None,
    ) -> dict:
        assert owner is None
        assert repo is None
        return {"version": 1, "threads": {}}

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: FakeFetcher())
    monkeypatch.setattr(snapshot_routes, "run_fetcher_call", fake_run_fetcher_call)
    monkeypatch.setattr(
        snapshot_routes, "fetch_review_request_notifications", fake_review_requests
    )
    monkeypatch.setattr(
        snapshot_routes,
        "_fetch_snapshot_comment_cache",
        fake_fetch_snapshot_comment_cache,
    )

    entries = [
        snapshot_routes.SnapshotEntry(kind="query", query="org:pytorch"),
        snapshot_routes.SnapshotEntry(kind="query", query="org:meta-pytorch"),
    ]
    asyncio.run(snapshot_routes._fetch_snapshot("profile:test-profile", entries))

    assert seen_queries == ["org:pytorch", "org:meta-pytorch"]
    assert review_queries == ["org:pytorch", "org:meta-pytorch"]

    snapshot = get_snapshot("profile:test-profile", db_path)
    assert snapshot is not None
    ids = {n["id"] for n in snapshot["notifications"]}
    assert ids == {
        "review-request:org:pytorch#1",
        "review-request:org:meta-pytorch#2",
    }
    state = get_sync_state("profile:test-profile", db_path)
    assert state["status"] == "success"
    assert state["notifications_count"] == 2
