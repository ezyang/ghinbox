"""SQLite cache for the background feed digest.

Mostly a disposable, rebuildable view (SOUL.md axiom 1): deleting these tables
costs the LLM calls needed to re-triage the current Feed, re-check Replies and
re-assess External review requests (plus the GitHub calls for their PR files
and author permissions). The one exception is
the digest queue: notes for items the worker already marked done on GitHub but
has not composed into a digest yet. Losing them only drops ambient items from
the next "Out of the ordinary" (see SOUL.md).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
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
                CREATE TABLE IF NOT EXISTS digest_reply_checks (
                    profile TEXT NOT NULL,
                    notification_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    why TEXT NOT NULL,
                    checked_at TEXT NOT NULL,
                    PRIMARY KEY (profile, notification_id)
                );
                CREATE TABLE IF NOT EXISTS digest_review_assessments (
                    profile TEXT NOT NULL,
                    pr_key TEXT NOT NULL,
                    assessment TEXT NOT NULL,
                    assessed_at TEXT NOT NULL,
                    PRIMARY KEY (profile, pr_key)
                );
                CREATE TABLE IF NOT EXISTS digest_author_permissions (
                    repo TEXT NOT NULL,
                    login TEXT NOT NULL,
                    permission TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    PRIMARY KEY (repo, login)
                );
                CREATE TABLE IF NOT EXISTS digest_state (
                    profile TEXT PRIMARY KEY,
                    state TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS digest_llm_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    duration_ms INTEGER NOT NULL,
                    item_count INTEGER NOT NULL,
                    prompt_chars INTEGER NOT NULL,
                    response_chars INTEGER NOT NULL,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    cache_read_tokens INTEGER,
                    cost_usd REAL,
                    error TEXT
                );
                CREATE INDEX IF NOT EXISTS digest_llm_calls_profile_started
                    ON digest_llm_calls (profile, started_at);
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


def get_reply_checks(profile: str, db_path: str | None = None) -> dict[str, dict]:
    """Return ``{notification_id: {"updated_at", "verdict", "why"}}``."""
    conn = connect_snapshot_db(db_path)
    try:
        rows = conn.execute(
            """
            SELECT notification_id, updated_at, verdict, why
            FROM digest_reply_checks WHERE profile = ?
            """,
            (profile,),
        ).fetchall()
    finally:
        conn.close()
    return {
        row["notification_id"]: {
            "updated_at": row["updated_at"],
            "verdict": row["verdict"],
            "why": row["why"],
        }
        for row in rows
    }


def save_reply_checks(
    profile: str,
    checks: dict[str, dict[str, Any]],
    keep_ids: set[str],
    db_path: str | None = None,
) -> None:
    """Upsert Replies verdicts and drop those for ids outside ``keep_ids``."""
    now = utc_now_iso()
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.executemany(
                """
                INSERT INTO digest_reply_checks (
                    profile, notification_id, updated_at, verdict, why, checked_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile, notification_id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    verdict = excluded.verdict,
                    why = excluded.why,
                    checked_at = excluded.checked_at
                """,
                [
                    (
                        profile,
                        notification_id,
                        str(check.get("updated_at") or ""),
                        check["verdict"],
                        check.get("why") or "",
                        now,
                    )
                    for notification_id, check in checks.items()
                ],
            )
            rows = conn.execute(
                "SELECT notification_id FROM digest_reply_checks WHERE profile = ?",
                (profile,),
            ).fetchall()
            conn.executemany(
                """
                DELETE FROM digest_reply_checks
                WHERE profile = ? AND notification_id = ?
                """,
                [
                    (profile, row["notification_id"])
                    for row in rows
                    if row["notification_id"] not in keep_ids
                ],
            )
    finally:
        conn.close()


def get_review_assessments(
    profile: str, db_path: str | None = None
) -> dict[str, dict[str, Any]]:
    """Return ``{pr_key: assessment}`` for External review requests."""
    conn = connect_snapshot_db(db_path)
    try:
        rows = conn.execute(
            """
            SELECT pr_key, assessment FROM digest_review_assessments
            WHERE profile = ?
            """,
            (profile,),
        ).fetchall()
    finally:
        conn.close()
    return {row["pr_key"]: json.loads(row["assessment"]) for row in rows}


def save_review_assessments(
    profile: str,
    assessments: dict[str, dict[str, Any]],
    keep_keys: set[str],
    db_path: str | None = None,
) -> None:
    """Upsert assessments by PR key and drop those outside ``keep_keys``."""
    now = utc_now_iso()
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.executemany(
                """
                INSERT INTO digest_review_assessments (
                    profile, pr_key, assessment, assessed_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(profile, pr_key) DO UPDATE SET
                    assessment = excluded.assessment,
                    assessed_at = excluded.assessed_at
                """,
                [
                    (profile, pr_key, json.dumps(assessment), now)
                    for pr_key, assessment in assessments.items()
                ],
            )
            rows = conn.execute(
                "SELECT pr_key FROM digest_review_assessments WHERE profile = ?",
                (profile,),
            ).fetchall()
            conn.executemany(
                """
                DELETE FROM digest_review_assessments
                WHERE profile = ? AND pr_key = ?
                """,
                [
                    (profile, row["pr_key"])
                    for row in rows
                    if row["pr_key"] not in keep_keys
                ],
            )
    finally:
        conn.close()


def get_author_permissions(
    max_age: timedelta,
    now: datetime | None = None,
    db_path: str | None = None,
) -> dict[str, dict[str, str]]:
    """Return ``{repo: {login: permission}}`` fetched within ``max_age``."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - max_age).astimezone(timezone.utc).isoformat()
    conn = connect_snapshot_db(db_path)
    try:
        rows = conn.execute(
            """
            SELECT repo, login, permission FROM digest_author_permissions
            WHERE fetched_at >= ?
            """,
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    permissions: dict[str, dict[str, str]] = {}
    for row in rows:
        permissions.setdefault(row["repo"], {})[row["login"]] = row["permission"]
    return permissions


def save_author_permission(
    repo: str,
    login: str,
    permission: str,
    now: datetime | None = None,
    db_path: str | None = None,
) -> None:
    """Cache one author's permission (keys lowercased, like the classifier's)."""
    fetched_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO digest_author_permissions (
                    repo, login, permission, fetched_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(repo, login) DO UPDATE SET
                    permission = excluded.permission,
                    fetched_at = excluded.fetched_at
                """,
                (repo.lower(), login.lower(), permission, fetched_at.isoformat()),
            )
    finally:
        conn.close()


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


# LLM call log rows older than this are dropped on insert.
LLM_CALL_RETENTION_DAYS = 30
USAGE_FIELDS = (
    "prompt_chars",
    "response_chars",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cost_usd",
    "duration_ms",
)


def record_llm_call(
    profile: str,
    *,
    kind: str,
    started_at: datetime,
    duration_ms: int,
    item_count: int,
    prompt_chars: int,
    response_chars: int,
    usage: dict[str, Any] | None = None,
    error: str | None = None,
    db_path: str | None = None,
) -> None:
    """Log one digest LLM call; ``usage`` holds token counts when the CLI reports them."""
    usage = usage or {}
    cutoff = started_at - timedelta(days=LLM_CALL_RETENTION_DAYS)
    conn = connect_snapshot_db(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO digest_llm_calls (
                    profile, kind, started_at, duration_ms, item_count,
                    prompt_chars, response_chars, input_tokens, output_tokens,
                    cache_read_tokens, cost_usd, error
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    profile,
                    kind,
                    started_at.astimezone(timezone.utc).isoformat(),
                    duration_ms,
                    item_count,
                    prompt_chars,
                    response_chars,
                    usage.get("input_tokens"),
                    usage.get("output_tokens"),
                    usage.get("cache_read_tokens"),
                    usage.get("cost_usd"),
                    error,
                ),
            )
            conn.execute(
                "DELETE FROM digest_llm_calls WHERE started_at < ?",
                (cutoff.astimezone(timezone.utc).isoformat(),),
            )
    finally:
        conn.close()


def get_llm_usage(
    profile: str,
    since: datetime,
    db_path: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Sum logged LLM calls since ``since``, per kind plus a ``total`` row."""
    conn = connect_snapshot_db(db_path)
    try:
        rows = conn.execute(
            f"""
            SELECT kind, COUNT(*) AS calls, SUM(error IS NOT NULL) AS errors,
                   SUM(item_count) AS items,
                   {", ".join(f"SUM({name}) AS {name}" for name in USAGE_FIELDS)}
            FROM digest_llm_calls
            WHERE profile = ? AND started_at >= ?
            GROUP BY kind
            """,
            (profile, since.astimezone(timezone.utc).isoformat()),
        ).fetchall()
    finally:
        conn.close()
    usage: dict[str, dict[str, Any]] = {}
    total: dict[str, Any] = {"calls": 0, "errors": 0, "items": 0}
    for row in rows:
        entry = {key: row[key] for key in row.keys() if key != "kind"}
        entry = {key: value or 0 for key, value in entry.items()}
        usage[row["kind"]] = entry
        for key, value in entry.items():
            total[key] = total.get(key, 0) + value
    usage["total"] = total
    return usage
