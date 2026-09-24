"""Tests for periodic background snapshot sync and incremental comment reuse."""

import asyncio
import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from ghinbox.api import github_proxy, snapshot_routes
from ghinbox.api.notification_shapes import is_comment_cache_entry_reusable
from ghinbox.api.rate_governor import (
    RateGovernor,
    RateGovernorConfig,
    RateLimitPoolState,
)
from ghinbox.api.snapshot_store import (
    get_snapshot_profile,
    init_snapshot_db,
    save_snapshot,
    save_snapshot_profile,
    set_sync_state,
)

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


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


@pytest.fixture(autouse=True)
def clean_running_tasks():
    snapshot_routes._running_tasks.clear()
    yield
    snapshot_routes._running_tasks.clear()
    snapshot_routes.clear_post_sync_hooks()


def _notification(nid: str, updated_at: str, **extra) -> dict:
    return {
        "id": nid,
        "unread": True,
        "updated_at": updated_at,
        "repository": {"full_name": "pytorch/pytorch"},
        "subject": {"type": "Issue", "number": int(nid.split("-")[-1])},
        **extra,
    }


def _thread(updated_at: str, fetched_at: datetime, **extra) -> dict:
    return {
        "notificationUpdatedAt": updated_at,
        "anchor": None,
        "lastReadAt": None,
        "comments": [{"id": 1, "body": "cached"}],
        "allComments": True,
        "fetchedAt": fetched_at.isoformat(),
        **extra,
    }


@pytest.mark.parametrize(
    ("entry", "notification", "expected"),
    [
        (_thread("t1", NOW - timedelta(hours=1)), _notification("n-1", "t1"), True),
        # New activity bumps updated_at.
        (_thread("t1", NOW - timedelta(hours=1)), _notification("n-1", "t2"), False),
        # Errored fetches always retry.
        (
            _thread("t1", NOW - timedelta(hours=1), error="boom"),
            _notification("n-1", "t1"),
            False,
        ),
        # Too old to hand to the client as fresh.
        (_thread("t1", NOW - timedelta(hours=7)), _notification("n-1", "t1"), False),
        # User read the thread on GitHub: the fetch window moved.
        (
            _thread("t1", NOW - timedelta(hours=1)),
            _notification("n-1", "t1", last_read_at="t0"),
            False,
        ),
        (None, _notification("n-1", "t1"), False),
    ],
)
def test_comment_cache_entry_reuse(entry, notification, expected) -> None:
    assert is_comment_cache_entry_reusable(entry, notification, NOW) is expected


def test_comment_cache_only_fetches_changed_threads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fresh = datetime.now(timezone.utc) - timedelta(minutes=5)
    notifications = [
        _notification("n-1", "t1", unread=False),
        _notification("n-2", "t2-new"),
    ]
    previous_cache = {
        "version": 1,
        "threads": {
            "n-1": _thread("t1", fresh),
            "n-2": _thread("t2-old", fresh),
        },
    }
    fetched_keys: list[str] = []

    async def fake_fetch_bulk_comment_item(client, token, item, *, request_id=None):
        fetched_keys.append(item["key"])
        return item["key"], {"comments": [{"id": 2, "body": "fresh"}]}

    monkeypatch.setattr(snapshot_routes, "get_token", lambda: "token")
    monkeypatch.setattr(github_proxy, "get_client", lambda: object())
    monkeypatch.setattr(
        github_proxy, "_fetch_bulk_comment_item", fake_fetch_bulk_comment_item
    )

    cache = asyncio.run(
        snapshot_routes._fetch_snapshot_comment_cache(
            None, None, notifications, previous_cache=previous_cache
        )
    )

    assert fetched_keys == ["n-2"]
    assert cache is not None
    assert cache["threads"]["n-1"]["comments"] == [{"id": 1, "body": "cached"}]
    assert cache["threads"]["n-1"]["unread"] is False
    assert cache["threads"]["n-2"]["comments"] == [{"id": 2, "body": "fresh"}]
    assert cache["threads"]["n-2"]["notificationUpdatedAt"] == "t2-new"


@pytest.mark.parametrize(
    ("sync_state", "expected"),
    [
        ({"status": "idle", "started_at": None, "finished_at": None}, True),
        ({"status": "running", "started_at": NOW.isoformat()}, False),
        (
            {
                "status": "success",
                "finished_at": (NOW - timedelta(minutes=5)).isoformat(),
            },
            False,
        ),
        (
            {
                "status": "success",
                "finished_at": (NOW - timedelta(minutes=16)).isoformat(),
            },
            True,
        ),
        # Errors back off for several intervals.
        (
            {
                "status": "error",
                "finished_at": (NOW - timedelta(minutes=16)).isoformat(),
            },
            False,
        ),
        (
            {
                "status": "error",
                "finished_at": (NOW - timedelta(minutes=61)).isoformat(),
            },
            True,
        ),
    ],
)
def test_is_periodic_sync_due(sync_state: dict, expected: bool) -> None:
    assert snapshot_routes.is_periodic_sync_due(sync_state, 15 * 60, NOW) is expected


def _record_started_syncs(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    started: list[tuple] = []
    monkeypatch.setattr(
        snapshot_routes,
        "_start_sync_task",
        lambda key, entries: started.append((key, entries)),
    )
    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: object())
    monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
    return started


def test_periodic_sync_refreshes_persisted_profile(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = _record_started_syncs(monkeypatch)
    save_snapshot("profile:pytorch", [], db_path=db_path)
    save_snapshot_profile(
        "profile:pytorch",
        [{"kind": "query", "owner": None, "repo": None, "query": "org:pytorch"}],
        db_path=db_path,
    )
    # A profile synced before entries were persisted cannot be refreshed.
    save_snapshot("profile:legacy", [], db_path=db_path)

    assert snapshot_routes.run_due_periodic_sync(15 * 60, NOW) == "profile:pytorch"
    assert len(started) == 1
    key, entries = started[0]
    assert key == "profile:pytorch"
    assert [(e.kind, e.query) for e in entries] == [("query", "org:pytorch")]

    set_sync_state(
        "profile:pytorch",
        status="success",
        finished_at=NOW.isoformat(),
        db_path=db_path,
    )
    assert snapshot_routes.run_due_periodic_sync(15 * 60, NOW) is None
    assert len(started) == 1


def test_periodic_sync_starts_one_repo_per_tick(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = _record_started_syncs(monkeypatch)
    save_snapshot("a/one", [], db_path=db_path)
    save_snapshot("b/two", [], db_path=db_path)

    assert snapshot_routes.run_due_periodic_sync(60, NOW) in {"a/one", "b/two"}
    assert len(started) == 1


def test_periodic_sync_skips_when_session_expired(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = _record_started_syncs(monkeypatch)
    save_snapshot("a/one", [], db_path=db_path)
    monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")

    assert snapshot_routes.run_due_periodic_sync(60, NOW) is None
    assert started == []


def test_periodic_sync_skips_when_rate_headroom_low(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = _record_started_syncs(monkeypatch)
    save_snapshot("a/one", [], db_path=db_path)

    class LowHeadroom:
        def has_background_headroom(self, pool, *, reserve=0, now=None):
            return False

    monkeypatch.setattr(snapshot_routes, "get_rate_governor", lambda: LowHeadroom())

    assert snapshot_routes.run_due_periodic_sync(60, NOW) is None
    assert started == []
    assert snapshot_routes.periodic_sync_skip_reason() == (
        "GitHub core rate limit headroom is low"
    )


def test_profile_sync_request_persists_entries(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = _record_started_syncs(monkeypatch)
    body = snapshot_routes.ProfileSyncRequest(
        entries=[
            snapshot_routes.SnapshotEntry(kind="query", query="org:pytorch"),
            snapshot_routes.SnapshotEntry(kind="repo", owner="a", repo="b"),
        ]
    )

    asyncio.run(snapshot_routes.start_profile_snapshot_sync("pytorch", body))

    assert started[0][0] == "profile:pytorch"
    assert get_snapshot_profile("profile:pytorch", db_path) == [
        {"kind": "query", "owner": None, "repo": None, "query": "org:pytorch"},
        {"kind": "repo", "owner": "a", "repo": "b", "query": None},
    ]


def test_successful_sync_runs_post_sync_hooks(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_fetch_one_entry_notifications(fetcher, entry, on_page, base_total):
        return [_notification("n-1", "t1")], None, None, None

    async def fake_review_requests(*args, **kwargs):
        return []

    async def fake_comment_cache(*args, **kwargs):
        return {"version": 1, "threads": {}}

    hooked: list[str] = []

    async def hook(snapshot_key: str) -> None:
        hooked.append(snapshot_key)

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: object())
    monkeypatch.setattr(
        snapshot_routes,
        "_fetch_one_entry_notifications",
        fake_fetch_one_entry_notifications,
    )
    monkeypatch.setattr(
        snapshot_routes, "fetch_review_request_notifications", fake_review_requests
    )
    monkeypatch.setattr(
        snapshot_routes, "_fetch_snapshot_comment_cache", fake_comment_cache
    )
    snapshot_routes.register_post_sync_hook(hook)

    asyncio.run(
        snapshot_routes._fetch_snapshot(
            "profile:p",
            [snapshot_routes.SnapshotEntry(kind="query", query="org:pytorch")],
        )
    )

    assert hooked == ["profile:p"]


def test_background_headroom_requires_reserve_above_floor() -> None:
    governor = RateGovernor(
        RateGovernorConfig(
            enabled=True,
            background_floor=500,
            interactive_floor=100,
            request_budget=300,
        )
    )
    # Unknown pool state: optimistic, like the per-call governor.
    assert governor.has_background_headroom("core", reserve=500, now=NOW)

    governor._pool_states["core"] = RateLimitPoolState(
        resource="core",
        remaining=900,
        limit=5000,
        reset_at=NOW + timedelta(minutes=30),
    )
    assert governor.has_background_headroom("core", reserve=300, now=NOW)
    assert not governor.has_background_headroom("core", reserve=500, now=NOW)
    # Quota resets restore headroom.
    assert governor.has_background_headroom(
        "core", reserve=500, now=NOW + timedelta(hours=1)
    )
    assert governor.snapshot()["recent_denials"] == []


def test_snapshot_reads_report_what_the_server_keeps_fresh(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A profile synced before entries were persisted is not watched, so the
    # client must re-register it; a fresh install has no snapshot at all.
    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: object())
    save_snapshot("profile:legacy", [], db_path=db_path)
    legacy = asyncio.run(snapshot_routes.get_profile_snapshot("legacy"))
    assert legacy["server_sync"] == {"available": True, "watched_entries": None}

    save_snapshot("profile:pytorch", [], db_path=db_path)
    save_snapshot_profile(
        "profile:pytorch",
        [{"kind": "query", "owner": None, "repo": None, "query": "org:pytorch"}],
        db_path=db_path,
    )
    watched = asyncio.run(snapshot_routes.get_profile_snapshot("pytorch"))
    assert watched["server_sync"] == {
        "available": True,
        "watched_entries": [{"kind": "query", "query": "org:pytorch"}],
    }

    missing = asyncio.run(snapshot_routes.get_notification_snapshot("a", "b"))
    assert missing["server_sync"] == {"available": True, "watched_entries": None}
    save_snapshot("a/b", [], db_path=db_path)
    repo = asyncio.run(snapshot_routes.get_notification_snapshot("a", "b"))
    assert repo["server_sync"] == {
        "available": True,
        "watched_entries": [{"kind": "repo", "owner": "a", "repo": "b"}],
    }

    monkeypatch.setattr(snapshot_routes, "get_fetcher", lambda: None)
    offline = asyncio.run(snapshot_routes.get_profile_snapshot("pytorch"))
    assert offline["server_sync"]["available"] is False
