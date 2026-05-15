"""SQLite storage for server-owned notification snapshots."""

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from typing import Literal

SyncStatus = Literal["idle", "running", "success", "error"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_db_path() -> str:
    explicit = os.environ.get("GHINBOX_SNAPSHOT_DB_PATH")
    if explicit:
        return explicit
    if os.environ.get("GHINBOX_TEST_MODE") == "1":
        return os.path.join(tempfile.gettempdir(), "ghinbox_snapshot_test.db")
    return os.path.join("auth_state", "ghinbox_snapshots.db")


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or _default_db_path())
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn


def init_snapshot_db(db_path: str | None = None) -> None:
    """Create snapshot tables if needed."""
    path = db_path or _default_db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = _connect(path)
    try:
        with conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS notification_snapshots (
                    repo TEXT PRIMARY KEY,
                    data TEXT NOT NULL,
                    authenticity_token TEXT,
                    source_url TEXT,
                    generated_at TEXT NOT NULL,
                    synced_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS snapshot_sync_state (
                    repo TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    error TEXT,
                    pages_fetched INTEGER NOT NULL DEFAULT 0,
                    notifications_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS notification_local_state (
                    repo TEXT NOT NULL,
                    notification_id TEXT NOT NULL,
                    bookmarked INTEGER NOT NULL DEFAULT 0,
                    replies_muted INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (repo, notification_id)
                );
                """
            )
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(notification_local_state)")
            }
            if "replies_muted" not in columns:
                conn.execute(
                    """
                    ALTER TABLE notification_local_state
                    ADD COLUMN replies_muted INTEGER NOT NULL DEFAULT 0
                    """
                )
    finally:
        conn.close()


def apply_local_state(
    repo: str,
    notifications: list[dict],
    db_path: str | None = None,
) -> list[dict]:
    """Overlay server-owned local state onto notification payloads."""
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT notification_id, bookmarked, replies_muted
            FROM notification_local_state
            WHERE repo = ?
            """,
            (repo,),
        ).fetchall()
        bookmarked = {row["notification_id"] for row in rows if bool(row["bookmarked"])}
        replies_muted = {
            row["notification_id"] for row in rows if bool(row["replies_muted"])
        }
    finally:
        conn.close()

    if not bookmarked and not replies_muted:
        return notifications

    result = []
    for notification in notifications:
        item = dict(notification)
        ui = dict(item.get("ui") or {})
        ui["bookmarked"] = str(item.get("id")) in bookmarked
        ui["replies_muted"] = str(item.get("id")) in replies_muted
        item["ui"] = ui
        result.append(item)
    return result


def get_snapshot(repo: str, db_path: str | None = None) -> dict | None:
    """Return the stored snapshot for a repo, if present."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT data, authenticity_token, source_url, generated_at, synced_at
            FROM notification_snapshots
            WHERE repo = ?
            """,
            (repo,),
        ).fetchone()
        if row is None:
            return None
        notifications = apply_local_state(repo, json.loads(row["data"]), db_path)
        return {
            "notifications": notifications,
            "authenticity_token": row["authenticity_token"],
            "source_url": row["source_url"],
            "generated_at": row["generated_at"],
            "synced_at": row["synced_at"],
        }
    finally:
        conn.close()


def save_snapshot(
    repo: str,
    notifications: list[dict],
    *,
    authenticity_token: str | None = None,
    source_url: str | None = None,
    generated_at: str | None = None,
    db_path: str | None = None,
) -> None:
    """Replace the stored snapshot for a repo."""
    now = _now()
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO notification_snapshots (
                    repo, data, authenticity_token, source_url, generated_at, synced_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo) DO UPDATE SET
                    data = excluded.data,
                    authenticity_token = excluded.authenticity_token,
                    source_url = excluded.source_url,
                    generated_at = excluded.generated_at,
                    synced_at = excluded.synced_at
                """,
                (
                    repo,
                    json.dumps(notifications),
                    authenticity_token,
                    source_url,
                    generated_at or now,
                    now,
                ),
            )
    finally:
        conn.close()


def get_notification_bookmark(
    repo: str,
    notification_id: str,
    db_path: str | None = None,
) -> bool:
    """Return whether a notification is bookmarked locally."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT bookmarked
            FROM notification_local_state
            WHERE repo = ? AND notification_id = ?
            """,
            (repo, notification_id),
        ).fetchone()
        return bool(row["bookmarked"]) if row else False
    finally:
        conn.close()


def set_notification_bookmark(
    repo: str,
    notification_id: str,
    bookmarked: bool,
    db_path: str | None = None,
) -> dict:
    """Persist a local bookmark flag for a notification."""
    now = _now()
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO notification_local_state (
                    repo, notification_id, bookmarked, updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(repo, notification_id) DO UPDATE SET
                    bookmarked = excluded.bookmarked,
                    updated_at = excluded.updated_at
                """,
                (repo, notification_id, 1 if bookmarked else 0, now),
            )
    finally:
        conn.close()
    return {
        "repo": repo,
        "notification_id": notification_id,
        "bookmarked": bookmarked,
        "updated_at": now,
    }


def get_notification_replies_muted(
    repo: str,
    notification_id: str,
    db_path: str | None = None,
) -> bool:
    """Return whether generic participation replies are muted locally."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT replies_muted
            FROM notification_local_state
            WHERE repo = ? AND notification_id = ?
            """,
            (repo, notification_id),
        ).fetchone()
        return bool(row["replies_muted"]) if row else False
    finally:
        conn.close()


def set_notification_replies_muted(
    repo: str,
    notification_id: str,
    replies_muted: bool,
    db_path: str | None = None,
) -> dict:
    """Persist local suppression of generic participation replies."""
    now = _now()
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO notification_local_state (
                    repo, notification_id, replies_muted, updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(repo, notification_id) DO UPDATE SET
                    replies_muted = excluded.replies_muted,
                    updated_at = excluded.updated_at
                """,
                (repo, notification_id, 1 if replies_muted else 0, now),
            )
    finally:
        conn.close()
    return {
        "repo": repo,
        "notification_id": notification_id,
        "replies_muted": replies_muted,
        "updated_at": now,
    }


def list_snapshot_repos(db_path: str | None = None) -> list[str]:
    """Return repos that have a stored snapshot."""
    conn = _connect(db_path)
    try:
        rows = conn.execute("SELECT repo FROM notification_snapshots").fetchall()
        return [row["repo"] for row in rows]
    finally:
        conn.close()


def get_sync_state(repo: str, db_path: str | None = None) -> dict:
    """Return persisted sync state for a repo."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT status, mode, started_at, finished_at, error,
                   pages_fetched, notifications_count
            FROM snapshot_sync_state
            WHERE repo = ?
            """,
            (repo,),
        ).fetchone()
        if row is None:
            return {
                "status": "idle",
                "mode": "full",
                "started_at": None,
                "finished_at": None,
                "error": None,
                "pages_fetched": 0,
                "notifications_count": 0,
            }
        return dict(row)
    finally:
        conn.close()


def set_sync_state(
    repo: str,
    *,
    status: SyncStatus,
    mode: str = "full",
    started_at: str | None = None,
    finished_at: str | None = None,
    error: str | None = None,
    pages_fetched: int = 0,
    notifications_count: int = 0,
    db_path: str | None = None,
) -> dict:
    """Upsert and return sync state."""
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO snapshot_sync_state (
                    repo, status, mode, started_at, finished_at, error,
                    pages_fetched, notifications_count
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo) DO UPDATE SET
                    status = excluded.status,
                    mode = excluded.mode,
                    started_at = excluded.started_at,
                    finished_at = excluded.finished_at,
                    error = excluded.error,
                    pages_fetched = excluded.pages_fetched,
                    notifications_count = excluded.notifications_count
                """,
                (
                    repo,
                    status,
                    mode,
                    started_at,
                    finished_at,
                    error,
                    pages_fetched,
                    notifications_count,
                ),
            )
    finally:
        conn.close()
    return get_sync_state(repo, db_path)


def clear_snapshot_store(db_path: str | None = None) -> None:
    """Clear all snapshot data. Intended for tests."""
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute("DELETE FROM notification_snapshots")
            conn.execute("DELETE FROM snapshot_sync_state")
            conn.execute("DELETE FROM notification_local_state")
    finally:
        conn.close()
