"""Tests for server-owned notification snapshots."""

import os
import tempfile

import pytest

from ghinbox.api.snapshot_store import (
    apply_local_state,
    get_notification_bookmark,
    get_notification_read_comment_watermark,
    get_notification_replies_muted,
    get_snapshot,
    get_sync_state,
    init_snapshot_db,
    remove_notifications_from_snapshots,
    save_snapshot,
    set_notification_bookmark,
    set_notification_read_comment_watermark,
    set_notification_replies_muted,
    set_sync_state,
)


@pytest.fixture
def db_path():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    init_snapshot_db(path)
    yield path
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass


def test_snapshot_round_trip(db_path) -> None:
    notifications = [
        {
            "id": "notif-1",
            "updated_at": "2024-12-27T10:00:00Z",
            "subject": {"title": "First", "type": "Issue"},
        }
    ]
    comment_cache = {
        "version": 1,
        "threads": {
            "notif-1": {
                "comments": [{"id": 1, "body": "cached"}],
                "allComments": True,
                "fetchedAt": "2024-12-27T10:00:02+00:00",
            }
        },
    }

    save_snapshot(
        "owner/repo",
        notifications,
        comment_cache=comment_cache,
        authenticity_token="token",
        source_url="https://github.com/notifications",
        generated_at="2024-12-27T10:00:01+00:00",
        db_path=db_path,
    )

    snapshot = get_snapshot("owner/repo", db_path)

    assert snapshot is not None
    assert snapshot["notifications"] == notifications
    assert snapshot["comment_cache"] == comment_cache
    assert snapshot["authenticity_token"] == "token"
    assert snapshot["source_url"] == "https://github.com/notifications"
    assert snapshot["generated_at"] == "2024-12-27T10:00:01+00:00"
    assert snapshot["synced_at"]


def test_bookmark_state_overlays_snapshot(db_path) -> None:
    notifications = [
        {
            "id": "notif-1",
            "updated_at": "2024-12-27T10:00:00Z",
            "subject": {"title": "First", "type": "Issue"},
            "ui": {"saved": False, "done": False, "bookmarked": False},
        },
        {
            "id": "notif-2",
            "updated_at": "2024-12-27T11:00:00Z",
            "subject": {"title": "Second", "type": "Issue"},
            "ui": {"saved": False, "done": False, "bookmarked": False},
        },
    ]

    set_notification_bookmark("owner/repo", "notif-1", True, db_path=db_path)
    save_snapshot("owner/repo", notifications, db_path=db_path)

    snapshot = get_snapshot("owner/repo", db_path)

    assert snapshot is not None
    assert snapshot["notifications"][0]["ui"]["bookmarked"] is True
    assert snapshot["notifications"][1]["ui"]["bookmarked"] is False
    assert get_notification_bookmark("owner/repo", "notif-1", db_path=db_path) is True


def test_snapshot_can_replace_notifications_while_preserving_comment_cache(
    db_path,
) -> None:
    notifications = [
        {
            "id": "notif-1",
            "updated_at": "2024-12-27T10:00:00Z",
            "subject": {"title": "First", "type": "Issue"},
        }
    ]
    comment_cache = {
        "version": 1,
        "threads": {
            "notif-1": {
                "comments": [{"id": 1, "body": "cached"}],
                "allComments": True,
                "fetchedAt": "2024-12-27T10:00:02+00:00",
            }
        },
    }
    replacement = [
        {
            "id": "notif-2",
            "updated_at": "2024-12-28T10:00:00Z",
            "subject": {"title": "Second", "type": "Issue"},
        }
    ]

    save_snapshot(
        "owner/repo",
        notifications,
        comment_cache=comment_cache,
        db_path=db_path,
    )
    save_snapshot(
        "owner/repo",
        replacement,
        preserve_comment_cache=True,
        db_path=db_path,
    )

    snapshot = get_snapshot("owner/repo", db_path)

    assert snapshot is not None
    assert snapshot["notifications"] == replacement
    assert snapshot["comment_cache"] == comment_cache


def test_bookmark_overlay_survives_replacement_sync(db_path) -> None:
    set_notification_bookmark("owner/repo", "notif-1", True, db_path=db_path)
    replacement = [
        {
            "id": "notif-1",
            "updated_at": "2024-12-28T10:00:00Z",
            "subject": {"title": "First updated", "type": "Issue"},
            "ui": {"saved": False, "done": False, "bookmarked": False},
        }
    ]

    save_snapshot("owner/repo", replacement, db_path=db_path)

    assert (
        apply_local_state("owner/repo", replacement, db_path)[0]["ui"]["bookmarked"]
        is True
    )


def test_remove_notifications_prunes_across_repos(db_path) -> None:
    save_snapshot(
        "owner/repo-a",
        [
            {"id": "a1", "subject": {"title": "A1"}},
            {"id": "a2", "subject": {"title": "A2"}},
        ],
        db_path=db_path,
    )
    save_snapshot(
        "owner/repo-b",
        [{"id": "b1", "subject": {"title": "B1"}}],
        db_path=db_path,
    )

    removed = remove_notifications_from_snapshots(["a1", "b1"], db_path=db_path)

    assert removed == 2
    snapshot_a = get_snapshot("owner/repo-a", db_path)
    snapshot_b = get_snapshot("owner/repo-b", db_path)
    assert snapshot_a is not None and snapshot_b is not None
    assert [n["id"] for n in snapshot_a["notifications"]] == ["a2"]
    assert snapshot_b["notifications"] == []


def test_remove_notifications_prunes_comment_cache_and_sync_state(db_path) -> None:
    save_snapshot(
        "owner/repo",
        [
            {
                "id": "remove-id",
                "subject": {
                    "title": "Remove",
                    "type": "Issue",
                    "number": 1,
                    "url": "https://github.com/owner/repo/issues/1",
                },
            },
            {
                "id": "review-request:owner/repo#2",
                "repository": {
                    "owner": "owner",
                    "name": "repo",
                    "full_name": "owner/repo",
                },
                "subject": {
                    "title": "Remove review",
                    "type": "PullRequest",
                    "number": 2,
                    "url": "https://github.com/owner/repo/pull/2",
                },
            },
            {
                "id": "keep-id",
                "subject": {
                    "title": "Keep",
                    "type": "Issue",
                    "number": 3,
                    "url": "https://github.com/owner/repo/issues/3",
                },
            },
        ],
        comment_cache={
            "version": 1,
            "threads": {
                "remove-id": {
                    "comments": [{"id": 1, "body": "stale"}],
                    "allComments": True,
                    "fetchedAt": "2025-01-05T12:00:00Z",
                    "error": "upstream failed",
                },
                "review-request:owner/repo#2": {
                    "comments": [{"id": 2, "body": "stale review"}],
                    "allComments": True,
                    "fetchedAt": "2025-01-05T12:00:00Z",
                },
                "keep-id": {
                    "comments": [{"id": 3, "body": "fresh"}],
                    "allComments": True,
                    "fetchedAt": "2025-01-05T12:00:00Z",
                },
            },
        },
        db_path=db_path,
    )
    set_sync_state(
        "owner/repo",
        status="success",
        phase="complete",
        pages_fetched=4,
        notifications_count=3,
        comments_total=3,
        comments_fetched=3,
        comments_failed=1,
        db_path=db_path,
    )

    removed = remove_notifications_from_snapshots(
        ["remove-id", "review-request:owner/repo#2"],
        db_path=db_path,
    )

    assert removed == 2
    snapshot = get_snapshot("owner/repo", db_path)
    assert snapshot is not None
    assert [notification["id"] for notification in snapshot["notifications"]] == [
        "keep-id"
    ]
    assert set(snapshot["comment_cache"]["threads"]) == {"keep-id"}
    sync_state = get_sync_state("owner/repo", db_path)
    assert sync_state["notifications_count"] == 1
    assert sync_state["comments_total"] == 1
    assert sync_state["comments_fetched"] == 1
    assert sync_state["comments_failed"] == 0


def test_remove_notifications_ignores_unknown_ids(db_path) -> None:
    save_snapshot(
        "owner/repo",
        [{"id": "keep", "subject": {"title": "Keep"}}],
        db_path=db_path,
    )

    assert remove_notifications_from_snapshots([], db_path=db_path) == 0
    assert remove_notifications_from_snapshots(["missing"], db_path=db_path) == 0
    snapshot = get_snapshot("owner/repo", db_path)
    assert snapshot is not None
    assert [n["id"] for n in snapshot["notifications"]] == ["keep"]


def test_profile_snapshot_local_state_overlays_profile_and_repo_keys(db_path) -> None:
    """Local state written via repo-keyed endpoints surfaces in profile
    snapshots, and repo-keyed state wins over profile-keyed state."""
    profile_key = "profile:pytorch"
    notifications = [
        {
            "id": "notif-1",
            "repository": {
                "owner": "owner",
                "name": "repo",
                "full_name": "owner/repo",
            },
            "subject": {"title": "First", "type": "Issue"},
            "ui": {"saved": False, "done": False, "bookmarked": False},
        },
        {
            "id": "notif-2",
            "repository": {
                "owner": "owner",
                "name": "repo",
                "full_name": "owner/repo",
            },
            "subject": {"title": "Second", "type": "Issue"},
            "ui": {"saved": False, "done": False, "bookmarked": False},
        },
    ]
    set_notification_bookmark(profile_key, "notif-1", True, db_path=db_path)
    set_notification_read_comment_watermark(
        profile_key,
        "notif-1",
        "2025-01-05T10:00:00Z",
        db_path=db_path,
    )
    set_notification_read_comment_watermark(
        profile_key,
        "notif-2",
        "2025-01-05T10:30:00Z",
        db_path=db_path,
    )
    set_notification_bookmark("owner/repo", "notif-1", False, db_path=db_path)
    set_notification_read_comment_watermark(
        "owner/repo",
        "notif-1",
        "2025-01-05T11:00:00Z",
        db_path=db_path,
    )
    set_notification_bookmark("owner/repo", "notif-2", True, db_path=db_path)
    save_snapshot(profile_key, notifications, db_path=db_path)

    snapshot = get_snapshot(profile_key, db_path)

    assert snapshot is not None
    first, second = snapshot["notifications"]
    assert first["ui"]["bookmarked"] is False
    assert first["ui"]["read_comment_watermark_at"] == "2025-01-05T11:00:00Z"
    assert second["ui"]["bookmarked"] is True
    assert second["ui"]["read_comment_watermark_at"] == "2025-01-05T10:30:00Z"


def test_local_notification_state_round_trip(db_path) -> None:
    assert get_notification_bookmark("owner/repo", "notif-1", db_path=db_path) is False
    assert (
        get_notification_replies_muted("owner/repo", "notif-1", db_path=db_path)
        is False
    )
    assert (
        get_notification_read_comment_watermark(
            "owner/repo",
            "notif-1",
            db_path=db_path,
        )
        is None
    )

    bookmark = set_notification_bookmark(
        "owner/repo",
        "notif-1",
        True,
        db_path=db_path,
    )
    muted = set_notification_replies_muted(
        "owner/repo",
        "notif-1",
        True,
        db_path=db_path,
    )
    watermark = set_notification_read_comment_watermark(
        "owner/repo",
        "notif-1",
        "2025-01-05T11:30:00Z",
        db_path=db_path,
    )

    assert bookmark["bookmarked"] is True
    assert muted["replies_muted"] is True
    assert watermark["read_comment_watermark_at"] == "2025-01-05T11:30:00Z"
    assert get_notification_bookmark("owner/repo", "notif-1", db_path=db_path) is True
    assert (
        get_notification_replies_muted("owner/repo", "notif-1", db_path=db_path) is True
    )
    assert (
        get_notification_read_comment_watermark(
            "owner/repo",
            "notif-1",
            db_path=db_path,
        )
        == "2025-01-05T11:30:00Z"
    )


def test_missing_sync_state_is_idle(db_path) -> None:
    state = get_sync_state("owner/repo", db_path)

    assert state["status"] == "idle"
    assert state["phase"] == "idle"
    assert state["pages_fetched"] == 0
    assert state["notifications_count"] == 0
    assert state["comments_total"] == 0


def test_sync_state_round_trip(db_path) -> None:
    state = set_sync_state(
        "owner/repo",
        status="running",
        started_at="2024-12-27T10:00:00+00:00",
        pages_fetched=2,
        notifications_count=50,
        db_path=db_path,
    )

    assert state["status"] == "running"
    assert state["started_at"] == "2024-12-27T10:00:00+00:00"
    assert state["pages_fetched"] == 2
    assert state["notifications_count"] == 50

    state = set_sync_state(
        "owner/repo",
        status="success",
        started_at="2024-12-27T10:00:00+00:00",
        finished_at="2024-12-27T10:01:00+00:00",
        pages_fetched=3,
        notifications_count=75,
        db_path=db_path,
    )

    assert state["status"] == "success"
    assert state["finished_at"] == "2024-12-27T10:01:00+00:00"
    assert state["pages_fetched"] == 3
    assert state["notifications_count"] == 75
