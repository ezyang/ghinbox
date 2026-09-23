"""SQLite cache for the background feed digest.

Everything here is a disposable, rebuildable view (SOUL.md axiom 1): deleting
these tables only costs the LLM calls needed to re-triage the current Feed.
"""

from __future__ import annotations

import json
import os
from typing import Any

from ghinbox.api.notification_shapes import utc_now_iso
from ghinbox.api.snapshot_store import connect_snapshot_db


def init_digest_db(db_path: str | None = None) -> None:
    path = db_path or os.environ.get("GHINBOX_SNAPSHOT_DB_PATH")
    if path:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS digest_item_notes (
                    profile TEXT NOT NULL,
                    notification_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    note TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (profile, notification_id)
                );
                CREATE TABLE IF NOT EXISTS digest_state (
                    profile TEXT PRIMARY KEY,
                    state TEXT NOT NULL
                );
                """
            )
    finally:
        conn.close()


def get_item_notes(profile: str, db_path: str | None = None) -> dict[str, dict]:
    """Return ``{notification_id: {"updated_at": ..., **note}}`` for a profile."""
    conn = connect_snapshot_db(db_path)
    try:
        rows = conn.execute(
            """
            SELECT notification_id, updated_at, note
            FROM digest_item_notes WHERE profile = ?
            """,
            (profile,),
        ).fetchall()
    finally:
        conn.close()
    return {
        row["notification_id"]: {
            **json.loads(row["note"]),
            "updated_at": row["updated_at"],
        }
        for row in rows
    }


def save_item_notes(
    profile: str,
    notes: dict[str, dict[str, Any]],
    db_path: str | None = None,
) -> None:
    """Upsert triage notes keyed by notification id (each carries updated_at)."""
    if not notes:
        return
    now = utc_now_iso()
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.executemany(
                """
                INSERT INTO digest_item_notes (
                    profile, notification_id, updated_at, note, created_at
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile, notification_id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    note = excluded.note,
                    created_at = excluded.created_at
                """,
                [
                    (
                        profile,
                        notification_id,
                        str(note.get("updated_at") or ""),
                        json.dumps(
                            {k: v for k, v in note.items() if k != "updated_at"}
                        ),
                        now,
                    )
                    for notification_id, note in notes.items()
                ],
            )
    finally:
        conn.close()


def prune_item_notes(
    profile: str,
    keep_ids: set[str],
    db_path: str | None = None,
) -> int:
    """Drop notes for notifications that left the Feed (done, rerouted)."""
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            rows = conn.execute(
                "SELECT notification_id FROM digest_item_notes WHERE profile = ?",
                (profile,),
            ).fetchall()
            stale = [
                (profile, row["notification_id"])
                for row in rows
                if row["notification_id"] not in keep_ids
            ]
            conn.executemany(
                """
                DELETE FROM digest_item_notes
                WHERE profile = ? AND notification_id = ?
                """,
                stale,
            )
    finally:
        conn.close()
    return len(stale)


def get_digest_state(profile: str, db_path: str | None = None) -> dict[str, Any]:
    conn = connect_snapshot_db(db_path)
    try:
        row = conn.execute(
            "SELECT state FROM digest_state WHERE profile = ?", (profile,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return {"status": "idle"}
    state = json.loads(row["state"])
    return state if isinstance(state, dict) else {"status": "idle"}


def update_digest_state(
    profile: str,
    db_path: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """Merge ``fields`` into the stored digest state and return it."""
    state = {**get_digest_state(profile, db_path), **fields}
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO digest_state (profile, state) VALUES (?, ?)
                ON CONFLICT(profile) DO UPDATE SET state = excluded.state
                """,
                (profile, json.dumps(state)),
            )
    finally:
        conn.close()
    return state
