"""Background worker that keeps a rolling LLM digest of each profile's Feed.

After every successful profile snapshot sync the worker:

1. classifies the snapshot with the webapp's own queue logic (via Node),
2. treats Feed items whose ``(id, updated_at)`` has no triage note as the
   ingest queue and triages them in batches,
3. drops notes for items that left the Feed (marked done, rerouted), except
   items it auto-marked done itself within the digest window,
4. recomposes the digest when the set of noted items changed, and
5. marks digested Feed items done on GitHub (auto-done), so the GitHub inbox
   only keeps what needs the user: items surfaced in "Look at these" (sticky
   until the user handles them) and direct replies from humans.

Auto-done is the only GitHub call made here; otherwise the cost is LLM calls,
bounded per run. New activity on an auto-done item brings it back to the inbox
and through the pipeline again.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shlex
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from ghinbox.api.fetcher import ActionResult
from ghinbox.api.notification_shapes import utc_now_iso
from ghinbox.api.snapshot_store import get_snapshot
from ghinbox.auth_common import load_username
from ghinbox.digest import prompts
from ghinbox.digest.feed import (
    DEFAULT_CURRENT_USER,
    build_report_items,
    classify_feed,
    find_reply_nature_in_feed,
    item_summary,
    mention_signal,
    routes_outside_pytorch_to_replies,
)
from ghinbox.digest.store import (
    get_digest_state,
    get_item_notes,
    prune_item_notes,
    save_item_notes,
    update_digest_state,
)

logger = logging.getLogger(__name__)

# Muse via pi. `--no-tools --no-extensions` is load-bearing: the prompt carries
# untrusted GitHub content, so the model must not be able to act on anything it
# reads. (`muse exec` cannot run tool-less, which is why this uses pi.)
DEFAULT_LLM_COMMAND = (
    "pi -p --no-tools --no-extensions --no-skills --no-prompt-templates "
    "--no-context-files --no-session --no-approve "
    "--model meta/muse-spark-1.3-internal --thinking low"
)
LLM_TIMEOUT_SECONDS = 600
PROMPT_FILE_PLACEHOLDER = "{prompt_file}"
TRIAGE_BATCH_SIZE = 40
MAX_TRIAGE_BATCHES_PER_RUN = 8
# Background passes are paced; the digest panel's Refresh bypasses this.
DEFAULT_MIN_INTERVAL_MINUTES = 60
# Auto-done items keep feeding the digest (the vibe) for this long.
DEFAULT_WINDOW_HOURS = 24

LlmRunner = Callable[[str], Awaitable[str]]
# Marks notification ids done on GitHub; None means auto-done is unavailable.
Archiver = Callable[[list[str]], Awaitable[ActionResult | None]]


class DigestError(RuntimeError):
    pass


def digest_profiles() -> set[str]:
    """Profiles kept digested in the background (``GHINBOX_DIGEST_PROFILES``)."""
    if os.environ.get("GHINBOX_DIGEST_ENABLED", "1") == "0":
        return set()
    raw = os.environ.get("GHINBOX_DIGEST_PROFILES", "pytorch")
    return {name.strip() for name in raw.split(",") if name.strip()}


def digest_min_interval_seconds() -> float:
    """Minimum gap between background passes (``GHINBOX_DIGEST_MIN_INTERVAL_MINUTES``)."""
    raw = os.environ.get("GHINBOX_DIGEST_MIN_INTERVAL_MINUTES")
    try:
        minutes = float(raw) if raw else DEFAULT_MIN_INTERVAL_MINUTES
    except ValueError:
        minutes = DEFAULT_MIN_INTERVAL_MINUTES
    return max(0.0, minutes * 60)


def is_background_digest_due(
    state: dict[str, Any], *, now: datetime, min_interval_seconds: float
) -> bool:
    """Whether a post-sync pass may run, given when the last pass finished."""
    finished_at = state.get("finished_at")
    if not finished_at or min_interval_seconds <= 0:
        return True
    try:
        finished = datetime.fromisoformat(str(finished_at))
    except ValueError:
        return True
    if finished.tzinfo is None:
        finished = finished.replace(tzinfo=timezone.utc)
    return (now - finished).total_seconds() >= min_interval_seconds


def digest_window_seconds() -> float:
    """How long auto-done items stay in the digest (``GHINBOX_DIGEST_WINDOW_HOURS``)."""
    raw = os.environ.get("GHINBOX_DIGEST_WINDOW_HOURS")
    try:
        hours = float(raw) if raw else DEFAULT_WINDOW_HOURS
    except ValueError:
        hours = DEFAULT_WINDOW_HOURS
    return max(0.0, hours * 3600)


def auto_done_enabled() -> bool:
    return os.environ.get("GHINBOX_DIGEST_AUTO_DONE", "1") != "0"


async def archive_on_github(notification_ids: list[str]) -> ActionResult | None:
    from ghinbox.api.archive_api import archive_notifications_in_background

    return await archive_notifications_in_background(notification_ids)


def select_auto_done_ids(
    entries: list[tuple[dict[str, Any], dict[str, Any]]],
    look_at_ids: set[str],
) -> list[str]:
    """Digested Feed items to mark done on GitHub.

    ``entries`` pairs current Feed items with their (current) triage notes.
    Keep anything the digest asks the user to open, anything it ever surfaced
    (so an item cannot fall off "Look at these" and vanish unseen), direct
    replies from humans, and items already auto-done (a stale sync can list
    them again; re-archiving would loop).
    """
    return [
        item["id"]
        for item, note in entries
        if item["id"] not in look_at_ids
        and not note.get("surfaced")
        and not note.get("archived_at")
        and mention_signal(item.get("reply_signals") or []) != "direct"
    ]


def _is_within_window(timestamp: Any, cutoff: datetime) -> bool:
    try:
        moment = datetime.fromisoformat(str(timestamp))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment >= cutoff


def digest_current_user() -> str:
    explicit = os.environ.get("GHINBOX_DIGEST_USER")
    if explicit:
        return explicit
    account = os.environ.get("GHINBOX_ACCOUNT")
    if account:
        username = load_username(account)
        if username:
            return username
    return DEFAULT_CURRENT_USER


async def run_llm(prompt: str) -> str:
    """Run the configured tool-less LLM CLI on ``prompt``.

    The prompt goes on stdin, or into a file whose path replaces a
    ``{prompt_file}`` argument for CLIs that cannot read stdin.
    """
    command = shlex.split(
        os.environ.get("GHINBOX_DIGEST_LLM_COMMAND") or DEFAULT_LLM_COMMAND
    )
    # A private scratch dir keeps the CLI away from this repo's agent
    # instructions and from anything a workspace-rooted tool could read.
    with tempfile.TemporaryDirectory(prefix="ghinbox-digest-") as workdir:
        stdin_data: bytes | None = prompt.encode()
        if PROMPT_FILE_PLACEHOLDER in command:
            prompt_path = os.path.join(workdir, "prompt.txt")
            with open(prompt_path, "w", encoding="utf-8") as handle:
                handle.write(prompt)
            command = [
                prompt_path if arg == PROMPT_FILE_PLACEHOLDER else arg
                for arg in command
            ]
            stdin_data = None
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE
                if stdin_data is not None
                else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
        except OSError as error:
            raise DigestError(f"Could not start digest LLM command: {error}") from error
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(stdin_data), timeout=LLM_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError as error:
            process.kill()
            await process.wait()
            raise DigestError("Digest LLM command timed out") from error
    if process.returncode != 0:
        detail = (stderr or stdout).decode(errors="replace").strip()[-500:]
        raise DigestError(f"Digest LLM command exited {process.returncode}: {detail}")
    return stdout.decode(errors="replace")


@dataclass
class FeedContext:
    items: list[dict[str, Any]]
    summaries: dict[str, dict[str, Any]] = field(default_factory=dict)


def _thread_author(thread: dict[str, Any]) -> str | None:
    if thread.get("authorLogin"):
        return str(thread["authorLogin"])
    for comment in thread.get("comments") or []:
        if isinstance(comment, dict) and comment.get("isIssue"):
            return (comment.get("user") or {}).get("login")
    return None


def build_feed_context(
    profile: str,
    snapshot: dict[str, Any],
    current_user: str,
) -> FeedContext:
    notifications = snapshot.get("notifications") or []
    threads = (snapshot.get("comment_cache") or {}).get("threads") or {}
    feed = classify_feed(
        notifications,
        threads,
        current_user,
        route_outside_pytorch_to_replies=routes_outside_pytorch_to_replies(profile),
    )
    reply_nature = find_reply_nature_in_feed(feed, threads, current_user)
    items = build_report_items(feed, threads, {n["id"] for n in reply_nature})
    by_id = {str(n.get("id")): n for n in feed}
    for item in items:
        notification = by_id.get(item["id"], {})
        item["repo"] = (notification.get("repository") or {}).get("full_name")
        item["author"] = _thread_author(threads.get(item["id"]) or {})
    return FeedContext(
        items=items,
        summaries={nid: item_summary(n) for nid, n in by_id.items()},
    )


def _digest_counts(
    entries: list[tuple[dict[str, Any], dict[str, Any]]],
) -> dict[str, int]:
    signals = [note.get("signal") for _, note in entries]
    return {
        "feed_count": len(entries),
        "direct_count": signals.count("direct"),
        "broadcast_count": signals.count("broadcast"),
        "auto_done_count": sum(bool(note.get("archived_at")) for _, note in entries),
    }


def _signature(entries: list[tuple[dict[str, Any], dict[str, Any]]]) -> str:
    digest = hashlib.sha256()
    for item, _ in sorted(entries, key=lambda entry: entry[0]["id"]):
        digest.update(f"{item['id']}@{item.get('updated_at')}\n".encode())
    return digest.hexdigest()


async def update_digest(
    profile: str,
    *,
    llm: LlmRunner = run_llm,
    archiver: Archiver | None = None,
    current_user: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run one ingest/triage/compose/auto-done pass.

    ``archiver`` marks items done on GitHub; None disables auto-done.
    """
    user = current_user or digest_current_user()
    now = now or datetime.now(timezone.utc)
    snapshot = get_snapshot(f"profile:{profile}")
    if not snapshot:
        return update_digest_state(profile, status="idle", pending_count=0)
    update_digest_state(profile, status="running", started_at=utc_now_iso())

    context = await asyncio.to_thread(build_feed_context, profile, snapshot, user)
    feed_ids = {item["id"] for item in context.items}
    cutoff = now - timedelta(seconds=digest_window_seconds())
    notes = get_item_notes(profile)
    # Auto-done items left the Feed on purpose; they keep informing the digest
    # until they age out of the window.
    archived_ids = {
        nid
        for nid, note in notes.items()
        if nid not in feed_ids
        and note.get("item")
        and _is_within_window(note.get("archived_at"), cutoff)
    }
    prune_item_notes(profile, feed_ids | archived_ids)
    notes = {nid: note for nid, note in notes.items() if nid in feed_ids | archived_ids}
    pending = [
        item
        for item in context.items
        if notes.get(item["id"], {}).get("updated_at") != item.get("updated_at")
    ]
    batches = [
        pending[start : start + TRIAGE_BATCH_SIZE]
        for start in range(0, len(pending), TRIAGE_BATCH_SIZE)
    ][:MAX_TRIAGE_BATCHES_PER_RUN]
    for batch in batches:
        response = await llm(prompts.build_triage_prompt(batch, user))
        batch_notes = prompts.parse_triage_response(
            prompts.extract_json_object(response), batch
        )
        for nid, note in batch_notes.items():
            # Once surfaced, an item stays exempt from auto-done until the
            # user handles it, even across new activity.
            if notes.get(nid, {}).get("surfaced"):
                note["surfaced"] = True
        save_item_notes(profile, batch_notes)
        notes.update(batch_notes)

    feed_entries = [
        (item, notes[item["id"]])
        for item in context.items
        if notes.get(item["id"], {}).get("updated_at") == item.get("updated_at")
    ]
    for item, note in feed_entries:
        note["signal"] = mention_signal(item.get("reply_signals") or [])
    archived_entries = [
        (
            {**notes[nid]["item"], "updated_at": notes[nid].get("updated_at")},
            notes[nid],
        )
        for nid in sorted(archived_ids)
    ]
    entries = feed_entries + archived_entries
    pending_count = len(context.items) - len(feed_entries)
    counts = _digest_counts(entries)
    signature = _signature(entries)
    state = get_digest_state(profile)
    fields: dict[str, Any] = {}
    if signature != state.get("input_signature"):
        if entries:
            response = await llm(prompts.build_compose_prompt(entries, user, counts))
            digest = prompts.parse_compose_response(
                prompts.extract_json_object(response),
                {item["id"] for item, _ in entries},
                {item["id"] for item, _ in feed_entries},
            )
        else:
            digest = {"look_at": [], "vibe": []}
        fields.update(
            digest=digest,
            input_signature=signature,
            composed_at=utc_now_iso(),
            composed_item_count=len(entries),
        )
    digest = fields.get("digest") or state.get("digest") or {}
    look_at_ids = {entry.get("id") for entry in digest.get("look_at") or []}

    surfaced = {
        nid: {**notes[nid], "surfaced": True}
        for nid in look_at_ids
        if nid in notes and not notes[nid].get("surfaced")
    }
    save_item_notes(profile, surfaced)
    notes.update(surfaced)

    if archiver is not None:
        current = [(item, notes[item["id"]]) for item, _ in feed_entries]
        fields["auto_done"] = await _auto_done(
            profile, archiver, current, look_at_ids, context, now
        )
        counts = _digest_counts(
            [(item, notes.get(item["id"], note)) for item, note in entries]
        )
    return update_digest_state(
        profile,
        status="idle",
        error=None,
        finished_at=utc_now_iso(),
        pending_count=pending_count,
        counts=counts,
        snapshot_synced_at=snapshot.get("synced_at"),
        **fields,
    )


async def _auto_done(
    profile: str,
    archiver: Archiver,
    entries: list[tuple[dict[str, Any], dict[str, Any]]],
    look_at_ids: set[str],
    context: FeedContext,
    now: datetime,
) -> dict[str, Any]:
    """Mark digested Feed items done; remember them so the digest keeps them."""
    ids = select_auto_done_ids(entries, look_at_ids)
    report: dict[str, Any] = {"at": utc_now_iso(), "attempted": len(ids), "done": 0}
    if not ids:
        return report
    try:
        result = await archiver(ids)
    except Exception as error:
        logger.exception("Digest auto-done failed for %s", profile)
        return {**report, "error": str(error) or error.__class__.__name__}
    if result is None:
        return {**report, "error": "No GitHub token configured"}
    done = [nid for nid in result.successful_notification_ids or [] if nid in ids]
    notes_by_id = {item["id"]: note for item, note in entries}
    archived_at = now.isoformat()
    archived = {
        nid: {
            **notes_by_id[nid],
            "archived_at": archived_at,
            "item": context.summaries.get(nid) or {"id": nid},
        }
        for nid in done
    }
    save_item_notes(profile, archived)
    for nid, note in archived.items():
        notes_by_id[nid].update(note)
    report["done"] = len(done)
    if result.status != "ok":
        report["error"] = result.error or result.status
    return report


_running: dict[str, asyncio.Task] = {}
_rerun_requested: set[str] = set()


async def _run_until_drained(
    profile: str, llm: LlmRunner, archiver: Archiver | None
) -> None:
    try:
        while True:
            _rerun_requested.discard(profile)
            try:
                state = await update_digest(profile, llm=llm, archiver=archiver)
            except Exception as error:
                logger.exception("Digest update failed for %s", profile)
                update_digest_state(
                    profile,
                    status="error",
                    error=str(error),
                    finished_at=utc_now_iso(),
                )
                return
            # Large backlogs drain across passes (bounded batches per pass);
            # a sync that landed mid-run also earns another pass.
            if not state.get("pending_count") and profile not in _rerun_requested:
                return
    finally:
        _running.pop(profile, None)


def schedule_digest_update(
    profile: str,
    *,
    llm: LlmRunner | None = None,
    archiver: Archiver | None = None,
) -> bool:
    """Start (or queue another pass of) the digest worker for ``profile``.

    Without an explicit ``archiver``, auto-done follows ``GHINBOX_DIGEST_AUTO_DONE``.
    """
    task = _running.get(profile)
    if task and not task.done():
        _rerun_requested.add(profile)
        return False
    if archiver is None and auto_done_enabled():
        archiver = archive_on_github
    _running[profile] = asyncio.create_task(
        _run_until_drained(profile, llm or run_llm, archiver)
    )
    return True


def is_digest_running(profile: str) -> bool:
    task = _running.get(profile)
    return bool(task and not task.done())


async def on_snapshot_synced(snapshot_key: str) -> None:
    """Post-sync hook: re-digest profiles configured for background digests."""
    prefix = "profile:"
    if not snapshot_key.startswith(prefix):
        return
    profile = snapshot_key[len(prefix) :]
    if profile not in digest_profiles():
        return
    if not is_background_digest_due(
        get_digest_state(profile),
        now=datetime.now(timezone.utc),
        min_interval_seconds=digest_min_interval_seconds(),
    ):
        return
    schedule_digest_update(profile)
