"""Tests for the SQLite notification store."""

import os
import tempfile

import pytest

from ghinbox.api.store import (
    clear_comment_cache,
    get_comment_cache,
    get_notifications,
    init_db,
    mark_done,
    save_comment_cache_thread,
    save_notifications,
    unmark_done,
)


@pytest.fixture
def db_path():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    init_db(path)
    yield path
    os.unlink(path)


def _make_notif(id_val, title="test"):
    return {"id": str(id_val), "subject": {"title": title}}


class TestGetNotifications:
    def test_empty_repo(self, db_path):
        notifications, done_ids = get_notifications("owner/repo", db_path)
        assert notifications == []
        assert done_ids == set()

    def test_returns_saved_data(self, db_path):
        notifs = [_make_notif(1), _make_notif(2)]
        save_notifications("owner/repo", notifs, db_path)
        result, done_ids = get_notifications("owner/repo", db_path)
        assert len(result) == 2
        assert result[0]["id"] == "1"
        assert done_ids == set()


class TestSaveNotifications:
    def test_upsert(self, db_path):
        save_notifications("owner/repo", [_make_notif(1)], db_path)
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        result, _ = get_notifications("owner/repo", db_path)
        assert len(result) == 2

    def test_clear_done(self, db_path):
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        mark_done("owner/repo", ["1"], db_path)
        _, done = get_notifications("owner/repo", db_path)
        assert "1" in done

        # Full sync with clear_done
        save_notifications(
            "owner/repo", [_make_notif(2), _make_notif(3)], db_path, clear_done=True
        )
        _, done = get_notifications("owner/repo", db_path)
        assert done == set()

    def test_prune_done_not_in_blob(self, db_path):
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        mark_done("owner/repo", ["1", "2"], db_path)
        _, done = get_notifications("owner/repo", db_path)
        assert done == {"1", "2"}

        # Incremental sync: notif 1 gone from GitHub, notif 2 still present
        save_notifications("owner/repo", [_make_notif(2), _make_notif(3)], db_path)
        _, done = get_notifications("owner/repo", db_path)
        # notif 1 pruned (not in blob), notif 2 kept (still in blob)
        assert done == {"2"}

    def test_different_repos_isolated(self, db_path):
        save_notifications("owner/repo1", [_make_notif(1)], db_path)
        save_notifications("owner/repo2", [_make_notif(2)], db_path)
        r1, _ = get_notifications("owner/repo1", db_path)
        r2, _ = get_notifications("owner/repo2", db_path)
        assert len(r1) == 1
        assert r1[0]["id"] == "1"
        assert len(r2) == 1
        assert r2[0]["id"] == "2"


class TestMarkDone:
    def test_adds_to_done_set(self, db_path):
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        mark_done("owner/repo", ["1"], db_path)
        _, done = get_notifications("owner/repo", db_path)
        assert done == {"1"}

    def test_removes_from_blob(self, db_path):
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        mark_done("owner/repo", ["1"], db_path)
        notifs, _ = get_notifications("owner/repo", db_path)
        assert len(notifs) == 1
        assert notifs[0]["id"] == "2"

    def test_idempotent(self, db_path):
        save_notifications("owner/repo", [_make_notif(1)], db_path)
        mark_done("owner/repo", ["1"], db_path)
        mark_done("owner/repo", ["1"], db_path)  # No error
        _, done = get_notifications("owner/repo", db_path)
        assert done == {"1"}

    def test_no_blob_still_adds_to_done(self, db_path):
        mark_done("owner/repo", ["1"], db_path)
        _, done = get_notifications("owner/repo", db_path)
        assert done == {"1"}


class TestUnmarkDone:
    def test_removes_from_done_set(self, db_path):
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        mark_done("owner/repo", ["1"], db_path)
        unmark_done("owner/repo", ["1"], [_make_notif(1)], db_path)
        _, done = get_notifications("owner/repo", db_path)
        assert done == set()

    def test_restores_to_blob(self, db_path):
        save_notifications("owner/repo", [_make_notif(1), _make_notif(2)], db_path)
        mark_done("owner/repo", ["1"], db_path)
        unmark_done("owner/repo", ["1"], [_make_notif(1)], db_path)
        notifs, _ = get_notifications("owner/repo", db_path)
        ids = [n["id"] for n in notifs]
        assert "1" in ids
        assert "2" in ids

    def test_no_duplicate_restore(self, db_path):
        save_notifications("owner/repo", [_make_notif(1)], db_path)
        # Notif 1 already in blob, restoring should not duplicate
        unmark_done("owner/repo", ["1"], [_make_notif(1)], db_path)
        notifs, _ = get_notifications("owner/repo", db_path)
        assert len(notifs) == 1

    def test_restore_with_no_existing_blob(self, db_path):
        unmark_done("owner/repo", ["1"], [_make_notif(1)], db_path)
        notifs, _ = get_notifications("owner/repo", db_path)
        assert len(notifs) == 1
        assert notifs[0]["id"] == "1"


class TestCommentCache:
    def test_empty_repo(self, db_path):
        cache = get_comment_cache("owner/repo", db_path)
        assert cache == {"version": 1, "threads": {}}

    def test_save_thread_and_load(self, db_path):
        thread_data = {"comments": [{"body": "hello"}], "fetchedAt": "2025-01-01"}
        save_comment_cache_thread("owner/repo", "notif-1", thread_data, db_path)
        result = get_comment_cache("owner/repo", db_path)
        assert result["version"] == 1
        assert "notif-1" in result["threads"]
        assert result["threads"]["notif-1"]["comments"][0]["body"] == "hello"

    def test_thread_upsert_preserves_others(self, db_path):
        save_comment_cache_thread("owner/repo", "notif-1", {"comments": []}, db_path)
        save_comment_cache_thread("owner/repo", "notif-2", {"comments": []}, db_path)
        result = get_comment_cache("owner/repo", db_path)
        assert "notif-1" in result["threads"]
        assert "notif-2" in result["threads"]

    def test_thread_upsert_overwrites_same_key(self, db_path):
        save_comment_cache_thread(
            "owner/repo", "notif-1", {"comments": [{"body": "old"}]}, db_path
        )
        save_comment_cache_thread(
            "owner/repo", "notif-1", {"comments": [{"body": "new"}]}, db_path
        )
        result = get_comment_cache("owner/repo", db_path)
        assert result["threads"]["notif-1"]["comments"][0]["body"] == "new"

    def test_different_repos_isolated(self, db_path):
        save_comment_cache_thread("owner/repo1", "a", {}, db_path)
        save_comment_cache_thread("owner/repo2", "b", {}, db_path)
        r1 = get_comment_cache("owner/repo1", db_path)
        r2 = get_comment_cache("owner/repo2", db_path)
        assert "a" in r1["threads"]
        assert "b" in r2["threads"]

    def test_clear_comment_cache(self, db_path):
        save_comment_cache_thread("owner/repo", "notif-1", {"comments": []}, db_path)
        clear_comment_cache("owner/repo", db_path)
        result = get_comment_cache("owner/repo", db_path)
        assert result == {"version": 1, "threads": {}}
