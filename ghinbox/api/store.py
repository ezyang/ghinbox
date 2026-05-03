"""
SQLite persistence for notification state.

Two-part state per repo:
1. Notifications blob — the full notification array, overwritten on each sync.
2. Done set — notification IDs marked done between syncs. Append-only, pruned
   when a sync replaces the blob.
"""

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timezone


def _default_db_path() -> str:
    explicit = os.environ.get("GHINBOX_DB_PATH")
    if explicit:
        return explicit
    if os.environ.get("GHINBOX_TEST_MODE") == "1":
        # In test mode, use a temp directory so tests don't pollute real data
        return os.path.join(tempfile.gettempdir(), "ghinbox_test.db")
    return os.path.join("auth_state", "ghinbox.db")


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    path = db_path or _default_db_path()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db(db_path: str | None = None) -> None:
    """Create tables if they don't exist."""
    path = db_path or _default_db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = _connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS notifications (
                repo TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS done (
                repo TEXT NOT NULL,
                notification_id TEXT NOT NULL,
                done_at TEXT NOT NULL,
                PRIMARY KEY (repo, notification_id)
            );
            CREATE TABLE IF NOT EXISTS comment_cache (
                repo TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
    finally:
        conn.close()


def get_notifications(
    repo: str, db_path: str | None = None
) -> tuple[list[dict], set[str]]:
    """Return (notifications_list, done_id_set) for a repo."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT data FROM notifications WHERE repo = ?", (repo,)
        ).fetchone()
        notifications = json.loads(row[0]) if row else []

        done_rows = conn.execute(
            "SELECT notification_id FROM done WHERE repo = ?", (repo,)
        ).fetchall()
        done_ids = {r[0] for r in done_rows}

        return notifications, done_ids
    finally:
        conn.close()


def save_notifications(
    repo: str,
    notifications: list[dict],
    db_path: str | None = None,
    clear_done: bool = False,
) -> None:
    """Upsert the notifications blob for a repo.

    If clear_done is True (full sync), delete all done entries for this repo.
    Otherwise (incremental sync), prune done entries whose IDs are not present
    in the new blob (they've been processed by GitHub).
    """
    now = datetime.now(timezone.utc).isoformat()
    data = json.dumps(notifications)
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(
                """INSERT INTO notifications (repo, data, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(repo) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""",
                (repo, data, now),
            )
            if clear_done:
                conn.execute("DELETE FROM done WHERE repo = ?", (repo,))
            else:
                # Prune done entries not present in the new blob
                blob_ids = {str(n.get("id", "")) for n in notifications}
                if blob_ids:
                    existing = conn.execute(
                        "SELECT notification_id FROM done WHERE repo = ?",
                        (repo,),
                    ).fetchall()
                    to_remove = [r[0] for r in existing if r[0] not in blob_ids]
                    if to_remove:
                        conn.executemany(
                            "DELETE FROM done WHERE repo = ? AND notification_id = ?",
                            [(repo, nid) for nid in to_remove],
                        )
    finally:
        conn.close()


def mark_done(
    repo: str,
    notification_ids: list[str],
    db_path: str | None = None,
) -> None:
    """Add IDs to the done set and remove them from the blob."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _connect(db_path)
    try:
        with conn:
            # Add to done set
            conn.executemany(
                """INSERT OR IGNORE INTO done (repo, notification_id, done_at)
                   VALUES (?, ?, ?)""",
                [(repo, nid, now) for nid in notification_ids],
            )
            # Remove from blob
            row = conn.execute(
                "SELECT data FROM notifications WHERE repo = ?", (repo,)
            ).fetchone()
            if row:
                notifications = json.loads(row[0])
                id_set = set(notification_ids)
                filtered = [
                    n for n in notifications if str(n.get("id", "")) not in id_set
                ]
                if len(filtered) != len(notifications):
                    conn.execute(
                        "UPDATE notifications SET data = ?, updated_at = ? WHERE repo = ?",
                        (json.dumps(filtered), now, repo),
                    )
    finally:
        conn.close()


def get_comment_cache(repo: str, db_path: str | None = None) -> dict:
    """Return the comment cache for a repo, or an empty cache."""
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT data FROM comment_cache WHERE repo = ?", (repo,)
        ).fetchone()
        return json.loads(row[0]) if row else {"version": 1, "threads": {}}
    finally:
        conn.close()


def save_comment_cache_thread(
    repo: str, thread_key: str, thread_data: dict, db_path: str | None = None
) -> None:
    """Upsert a single thread entry in the comment cache blob for a repo."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _connect(db_path)
    try:
        with conn:
            row = conn.execute(
                "SELECT data FROM comment_cache WHERE repo = ?", (repo,)
            ).fetchone()
            cache = json.loads(row[0]) if row else {"version": 1, "threads": {}}
            cache["threads"][thread_key] = thread_data
            data = json.dumps(cache)
            conn.execute(
                """INSERT INTO comment_cache (repo, data, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(repo) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""",
                (repo, data, now),
            )
    finally:
        conn.close()


def clear_comment_cache(repo: str, db_path: str | None = None) -> None:
    """Delete the comment cache for a repo."""
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute("DELETE FROM comment_cache WHERE repo = ?", (repo,))
    finally:
        conn.close()


def clear_repo(repo: str, db_path: str | None = None) -> None:
    """Delete all data for a repo (notifications blob, done set, and comment cache)."""
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute("DELETE FROM notifications WHERE repo = ?", (repo,))
            conn.execute("DELETE FROM done WHERE repo = ?", (repo,))
            conn.execute("DELETE FROM comment_cache WHERE repo = ?", (repo,))
    finally:
        conn.close()


def clear_all(db_path: str | None = None) -> None:
    """Delete all data from all tables."""
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute("DELETE FROM notifications")
            conn.execute("DELETE FROM done")
            conn.execute("DELETE FROM comment_cache")
    finally:
        conn.close()


def unmark_done(
    repo: str,
    notification_ids: list[str],
    notifications_to_restore: list[dict],
    db_path: str | None = None,
) -> None:
    """Remove IDs from the done set and re-insert notifications into the blob."""
    now = datetime.now(timezone.utc).isoformat()
    conn = _connect(db_path)
    try:
        with conn:
            # Remove from done set
            conn.executemany(
                "DELETE FROM done WHERE repo = ? AND notification_id = ?",
                [(repo, nid) for nid in notification_ids],
            )
            # Re-insert into blob
            row = conn.execute(
                "SELECT data FROM notifications WHERE repo = ?", (repo,)
            ).fetchone()
            if row:
                notifications = json.loads(row[0])
                existing_ids = {str(n.get("id", "")) for n in notifications}
                for n in notifications_to_restore:
                    if str(n.get("id", "")) not in existing_ids:
                        notifications.append(n)
                        existing_ids.add(str(n.get("id", "")))
                conn.execute(
                    "UPDATE notifications SET data = ?, updated_at = ? WHERE repo = ?",
                    (json.dumps(notifications), now, repo),
                )
            elif notifications_to_restore:
                conn.execute(
                    """INSERT INTO notifications (repo, data, updated_at)
                       VALUES (?, ?, ?)""",
                    (repo, json.dumps(notifications_to_restore), now),
                )
    finally:
        conn.close()
