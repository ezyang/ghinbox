"""SQLite storage for server-owned notification snapshots."""

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Literal

SyncStatus = Literal["idle", "running", "success", "error"]
_BOOL_LOCAL_STATE_FIELDS = {"bookmarked", "replies_muted"}
_TEXT_LOCAL_STATE_FIELDS = {"read_comment_watermark_at"}
_LOCAL_STATE_FIELDS = _BOOL_LOCAL_STATE_FIELDS | _TEXT_LOCAL_STATE_FIELDS


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_db_path() -> str:
    explicit = os.environ.get("GHINBOX_SNAPSHOT_DB_PATH")
    if explicit:
        return explicit
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
                    comment_cache TEXT,
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
                    read_comment_watermark_at TEXT,
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
            if "read_comment_watermark_at" not in columns:
                conn.execute(
                    """
                    ALTER TABLE notification_local_state
                    ADD COLUMN read_comment_watermark_at TEXT
                    """
                )
            snapshot_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(notification_snapshots)")
            }
            if "comment_cache" not in snapshot_columns:
                conn.execute(
                    """
                    ALTER TABLE notification_snapshots
                    ADD COLUMN comment_cache TEXT
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
            SELECT notification_id, bookmarked, replies_muted, read_comment_watermark_at
            FROM notification_local_state
            WHERE repo = ?
            """,
            (repo,),
        ).fetchall()
        bookmarked = {row["notification_id"] for row in rows if bool(row["bookmarked"])}
        replies_muted = {
            row["notification_id"] for row in rows if bool(row["replies_muted"])
        }
        read_comment_watermarks = {
            row["notification_id"]: row["read_comment_watermark_at"]
            for row in rows
            if row["read_comment_watermark_at"]
        }
    finally:
        conn.close()

    if not bookmarked and not replies_muted and not read_comment_watermarks:
        return notifications

    result = []
    for notification in notifications:
        item = dict(notification)
        ui = dict(item.get("ui") or {})
        notification_id = str(item.get("id"))
        ui["bookmarked"] = notification_id in bookmarked
        ui["replies_muted"] = notification_id in replies_muted
        if notification_id in read_comment_watermarks:
            ui["read_comment_watermark_at"] = read_comment_watermarks[notification_id]
        item["ui"] = ui
        result.append(item)
    return result


def get_snapshot(repo: str, db_path: str | None = None) -> dict | None:
    """Return the stored snapshot for a repo, if present."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT data, comment_cache, authenticity_token, source_url, generated_at, synced_at
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
            "comment_cache": (
                json.loads(row["comment_cache"]) if row["comment_cache"] else None
            ),
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
    comment_cache: dict | None = None,
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
                    repo, data, comment_cache, authenticity_token, source_url, generated_at, synced_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo) DO UPDATE SET
                    data = excluded.data,
                    comment_cache = excluded.comment_cache,
                    authenticity_token = excluded.authenticity_token,
                    source_url = excluded.source_url,
                    generated_at = excluded.generated_at,
                    synced_at = excluded.synced_at
                """,
                (
                    repo,
                    json.dumps(notifications),
                    json.dumps(comment_cache) if comment_cache is not None else None,
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
    return bool(_get_local_state_value(repo, notification_id, "bookmarked", db_path))


def set_notification_bookmark(
    repo: str,
    notification_id: str,
    bookmarked: bool,
    db_path: str | None = None,
) -> dict:
    """Persist a local bookmark flag for a notification."""
    return _set_local_state_value(
        repo, notification_id, "bookmarked", bookmarked, db_path
    )


def get_notification_replies_muted(
    repo: str,
    notification_id: str,
    db_path: str | None = None,
) -> bool:
    """Return whether generic participation replies are muted locally."""
    return bool(_get_local_state_value(repo, notification_id, "replies_muted", db_path))


def set_notification_replies_muted(
    repo: str,
    notification_id: str,
    replies_muted: bool,
    db_path: str | None = None,
) -> dict:
    """Persist local suppression of generic participation replies."""
    return _set_local_state_value(
        repo,
        notification_id,
        "replies_muted",
        replies_muted,
        db_path,
    )


def get_notification_read_comment_watermark(
    repo: str,
    notification_id: str,
    db_path: str | None = None,
) -> str | None:
    """Return the local read-comment watermark for a notification."""
    value = _get_local_state_value(
        repo,
        notification_id,
        "read_comment_watermark_at",
        db_path,
    )
    return str(value) if value else None


def set_notification_read_comment_watermark(
    repo: str,
    notification_id: str,
    read_comment_watermark_at: str | None = None,
    db_path: str | None = None,
) -> dict:
    """Persist the timestamp after which comments should be shown."""
    watermark = read_comment_watermark_at or _now()
    return _set_local_state_value(
        repo,
        notification_id,
        "read_comment_watermark_at",
        watermark,
        db_path,
    )


def _get_local_state_value(
    repo: str,
    notification_id: str,
    field: str,
    db_path: str | None = None,
) -> bool | str | None:
    if field not in _LOCAL_STATE_FIELDS:
        raise ValueError(f"Unsupported local state field: {field}")
    conn = _connect(db_path)
    try:
        row = conn.execute(
            f"""
            SELECT {field}
            FROM notification_local_state
            WHERE repo = ? AND notification_id = ?
            """,
            (repo, notification_id),
        ).fetchone()
        if row is None or row[field] is None:
            return False if field in _BOOL_LOCAL_STATE_FIELDS else None
        if field in _BOOL_LOCAL_STATE_FIELDS:
            return bool(row[field])
        return str(row[field])
    finally:
        conn.close()


def _set_local_state_value(
    repo: str,
    notification_id: str,
    field: str,
    value: bool | str | None,
    db_path: str | None = None,
) -> dict:
    if field not in _LOCAL_STATE_FIELDS:
        raise ValueError(f"Unsupported local state field: {field}")
    stored_value: int | str | None
    returned_value: bool | str | None
    if field in _BOOL_LOCAL_STATE_FIELDS:
        returned_value = bool(value)
        stored_value = 1 if returned_value else 0
    else:
        returned_value = str(value) if value is not None else None
        stored_value = returned_value
    now = _now()
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                f"""
                INSERT INTO notification_local_state (
                    repo, notification_id, {field}, updated_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(repo, notification_id) DO UPDATE SET
                    {field} = excluded.{field},
                    updated_at = excluded.updated_at
                """,
                (repo, notification_id, stored_value, now),
            )
    finally:
        conn.close()
    return {
        "repo": repo,
        "notification_id": notification_id,
        field: returned_value,
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
