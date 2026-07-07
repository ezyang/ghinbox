"""SQLite storage for server-owned notification snapshots."""

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Literal

from ghinbox.api.notification_shapes import get_notification_repo
from ghinbox.api.repo_keys import repo_key

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
            sync_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(snapshot_sync_state)")
            }
            for column_name, definition in (
                ("phase", "TEXT NOT NULL DEFAULT 'idle'"),
                ("comments_total", "INTEGER NOT NULL DEFAULT 0"),
                ("comments_fetched", "INTEGER NOT NULL DEFAULT 0"),
                ("comments_failed", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if column_name not in sync_columns:
                    conn.execute(
                        f"""
                        ALTER TABLE snapshot_sync_state
                        ADD COLUMN {column_name} {definition}
                        """
                    )
    finally:
        conn.close()


def _notification_repo_key(notification: dict[str, Any]) -> str | None:
    repo_info = get_notification_repo(notification)
    if repo_info is None:
        return None
    return repo_key(repo_info["owner"], repo_info["repo"])


def _load_local_state(
    keys: list[str],
    db_path: str | None = None,
) -> dict[str, dict[str, dict[str, bool | str | None]]]:
    unique_keys = list(dict.fromkeys(key for key in keys if key))
    if not unique_keys:
        return {}

    placeholders = ", ".join("?" for _ in unique_keys)
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            f"""
            SELECT repo, notification_id, bookmarked, replies_muted, read_comment_watermark_at
            FROM notification_local_state
            WHERE repo IN ({placeholders})
            """,
            unique_keys,
        ).fetchall()
    finally:
        conn.close()

    state_by_key: dict[str, dict[str, dict[str, bool | str | None]]] = {}
    for row in rows:
        state_by_key.setdefault(row["repo"], {})[str(row["notification_id"])] = {
            "bookmarked": bool(row["bookmarked"]),
            "replies_muted": bool(row["replies_muted"]),
            "read_comment_watermark_at": row["read_comment_watermark_at"],
        }
    return state_by_key


def _apply_local_state_values(
    ui: dict[str, Any],
    state: dict[str, bool | str | None] | None,
) -> None:
    if state is None:
        return
    ui["bookmarked"] = bool(state["bookmarked"])
    ui["replies_muted"] = bool(state["replies_muted"])
    watermark = state.get("read_comment_watermark_at")
    if watermark:
        ui["read_comment_watermark_at"] = watermark


def apply_local_state(
    snapshot_key: str,
    notifications: list[dict],
    db_path: str | None = None,
) -> list[dict]:
    """Overlay server-owned local state onto notification payloads.

    Local state written through the repo-keyed endpoints must also surface in
    profile snapshots, whose notifications span many repos. State stored under
    each notification's own ``owner/repo`` key wins over state stored under
    the snapshot's own key.
    """
    repo_keys_by_notification_id: dict[str, str] = {}
    local_state_keys = [snapshot_key]

    if snapshot_key.startswith("profile:"):
        for notification in notifications:
            notification_id = str(notification.get("id") or "")
            if not notification_id:
                continue
            notification_repo_key = _notification_repo_key(notification)
            if notification_repo_key is None:
                continue
            repo_keys_by_notification_id[notification_id] = notification_repo_key
            local_state_keys.append(notification_repo_key)

    state_by_key = _load_local_state(local_state_keys, db_path)
    if not state_by_key:
        return notifications

    result = []
    changed = False
    for notification in notifications:
        notification_id = str(notification.get("id") or "")
        snapshot_state = state_by_key.get(snapshot_key, {}).get(notification_id)
        repo_state = state_by_key.get(
            repo_keys_by_notification_id.get(notification_id, ""),
            {},
        ).get(notification_id)
        if snapshot_state is None and repo_state is None:
            result.append(notification)
            continue

        item = dict(notification)
        ui = dict(item.get("ui") or {})
        _apply_local_state_values(ui, snapshot_state)
        _apply_local_state_values(ui, repo_state)
        item["ui"] = ui
        result.append(item)
        changed = True

    return result if changed else notifications


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
    preserve_comment_cache: bool = False,
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
            comment_cache_update = (
                "comment_cache = notification_snapshots.comment_cache"
                if preserve_comment_cache
                else "comment_cache = excluded.comment_cache"
            )
            conn.execute(
                f"""
                INSERT INTO notification_snapshots (
                    repo, data, comment_cache, authenticity_token, source_url, generated_at, synced_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo) DO UPDATE SET
                    data = excluded.data,
                    {comment_cache_update},
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


def remove_notifications_from_snapshots(
    notification_ids: list[str],
    db_path: str | None = None,
) -> int:
    """Drop the given notification IDs from every stored snapshot's data.

    Notification IDs are globally unique GitHub IDs, so an archive action can be
    reconciled against the local cache without knowing which repo it came from.
    This lets an already-open browser tab reflect an out-of-band mark-done via a
    lightweight "Server Refresh" instead of a full GitHub sync. Returns the total
    number of notifications removed across all repos.
    """
    ids = {str(i) for i in notification_ids if i}
    if not ids:
        return 0
    removed = 0
    conn = _connect(db_path)
    try:
        with conn:
            rows = conn.execute(
                "SELECT repo, data FROM notification_snapshots"
            ).fetchall()
            for row in rows:
                notifications = json.loads(row["data"])
                kept = [n for n in notifications if str(n.get("id")) not in ids]
                if len(kept) == len(notifications):
                    continue
                removed += len(notifications) - len(kept)
                conn.execute(
                    "UPDATE notification_snapshots SET data = ? WHERE repo = ?",
                    (json.dumps(kept), row["repo"]),
                )
    finally:
        conn.close()
    return removed


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
            SELECT status, mode, phase, started_at, finished_at, error,
                   pages_fetched, notifications_count,
                   comments_total, comments_fetched, comments_failed
            FROM snapshot_sync_state
            WHERE repo = ?
            """,
            (repo,),
        ).fetchone()
        if row is None:
            return {
                "status": "idle",
                "mode": "full",
                "phase": "idle",
                "started_at": None,
                "finished_at": None,
                "error": None,
                "pages_fetched": 0,
                "notifications_count": 0,
                "comments_total": 0,
                "comments_fetched": 0,
                "comments_failed": 0,
            }
        return dict(row)
    finally:
        conn.close()


def set_sync_state(
    repo: str,
    *,
    status: SyncStatus,
    mode: str = "full",
    phase: str | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    error: str | None = None,
    pages_fetched: int = 0,
    notifications_count: int = 0,
    comments_total: int = 0,
    comments_fetched: int = 0,
    comments_failed: int = 0,
    db_path: str | None = None,
) -> dict:
    """Upsert and return sync state."""
    if phase is None:
        phase = "complete" if status == "success" else status
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO snapshot_sync_state (
                    repo, status, mode, phase, started_at, finished_at, error,
                    pages_fetched, notifications_count,
                    comments_total, comments_fetched, comments_failed
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo) DO UPDATE SET
                    status = excluded.status,
                    mode = excluded.mode,
                    phase = excluded.phase,
                    started_at = excluded.started_at,
                    finished_at = excluded.finished_at,
                    error = excluded.error,
                    pages_fetched = excluded.pages_fetched,
                    notifications_count = excluded.notifications_count,
                    comments_total = excluded.comments_total,
                    comments_fetched = excluded.comments_fetched,
                    comments_failed = excluded.comments_failed
                """,
                (
                    repo,
                    status,
                    mode,
                    phase,
                    started_at,
                    finished_at,
                    error,
                    pages_fetched,
                    notifications_count,
                    comments_total,
                    comments_fetched,
                    comments_failed,
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
