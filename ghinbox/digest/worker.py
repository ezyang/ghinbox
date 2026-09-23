"""Background worker that keeps a rolling LLM digest of each profile's Feed.

After every successful profile snapshot sync the worker:

1. classifies the snapshot with the webapp's own queue logic (via Node),
2. treats Feed items whose ``(id, updated_at)`` has no triage note as the
   ingest queue and triages them in batches,
3. drops notes for items that left the Feed (marked done, rerouted), and
4. recomposes the digest when the set of noted items changed.

No GitHub calls happen here; the only cost is LLM calls, bounded per run.
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
from datetime import datetime, timezone
from typing import Any

from ghinbox.api.notification_shapes import utc_now_iso
from ghinbox.api.snapshot_store import get_snapshot
from ghinbox.auth_common import load_username
from ghinbox.digest import prompts
from ghinbox.digest.feed import (
    DEFAULT_CURRENT_USER,
    build_report_items,
    classify_feed,
    find_reply_nature_in_feed,
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

LlmRunner = Callable[[str], Awaitable[str]]


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
    counts: dict[str, int] = field(default_factory=dict)


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
    direct = broadcast = 0
    for item in items:
        notification = by_id.get(item["id"], {})
        item["repo"] = (notification.get("repository") or {}).get("full_name")
        item["author"] = _thread_author(threads.get(item["id"]) or {})
        signals = item.get("reply_signals") or []
        if any(s.startswith(("@-mentioned", "replied to")) for s in signals):
            direct += 1
        elif any(s.startswith("cc'd (broadcast)") for s in signals):
            broadcast += 1
    return FeedContext(
        items=items,
        counts={
            "feed_count": len(items),
            "direct_count": direct,
            "broadcast_count": broadcast,
        },
    )


def _signature(entries: list[tuple[dict[str, Any], dict[str, Any]]]) -> str:
    digest = hashlib.sha256()
    for item, _ in sorted(entries, key=lambda entry: entry[0]["id"]):
        digest.update(f"{item['id']}@{item.get('updated_at')}\n".encode())
    return digest.hexdigest()


async def update_digest(
    profile: str,
    *,
    llm: LlmRunner = run_llm,
    current_user: str | None = None,
) -> dict[str, Any]:
    """Run one ingest/triage/compose pass; return the remaining queue size."""
    user = current_user or digest_current_user()
    snapshot = get_snapshot(f"profile:{profile}")
    if not snapshot:
        return update_digest_state(profile, status="idle", pending_count=0)
    update_digest_state(profile, status="running", started_at=utc_now_iso())

    context = await asyncio.to_thread(build_feed_context, profile, snapshot, user)
    feed_ids = {item["id"] for item in context.items}
    prune_item_notes(profile, feed_ids)

    notes = get_item_notes(profile)
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
        save_item_notes(profile, batch_notes)
        notes.update(batch_notes)

    entries = [
        (item, notes[item["id"]])
        for item in context.items
        if notes.get(item["id"], {}).get("updated_at") == item.get("updated_at")
    ]
    pending_count = len(context.items) - len(entries)
    signature = _signature(entries)
    state = get_digest_state(profile)
    fields: dict[str, Any] = {}
    if signature != state.get("input_signature"):
        if entries:
            response = await llm(
                prompts.build_compose_prompt(entries, user, context.counts)
            )
            digest = prompts.parse_compose_response(
                prompts.extract_json_object(response),
                {item["id"] for item, _ in entries},
            )
        else:
            digest = {"look_at": [], "vibe": []}
        fields.update(
            digest=digest,
            input_signature=signature,
            composed_at=utc_now_iso(),
            composed_item_count=len(entries),
        )
    return update_digest_state(
        profile,
        status="idle",
        error=None,
        finished_at=utc_now_iso(),
        pending_count=pending_count,
        counts=context.counts,
        snapshot_synced_at=snapshot.get("synced_at"),
        **fields,
    )


_running: dict[str, asyncio.Task] = {}
_rerun_requested: set[str] = set()


async def _run_until_drained(profile: str, llm: LlmRunner) -> None:
    try:
        while True:
            _rerun_requested.discard(profile)
            try:
                state = await update_digest(profile, llm=llm)
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


def schedule_digest_update(profile: str, *, llm: LlmRunner | None = None) -> bool:
    """Start (or queue another pass of) the digest worker for ``profile``."""
    task = _running.get(profile)
    if task and not task.done():
        _rerun_requested.add(profile)
        return False
    _running[profile] = asyncio.create_task(_run_until_drained(profile, llm or run_llm))
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
