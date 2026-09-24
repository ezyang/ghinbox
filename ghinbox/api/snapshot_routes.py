"""Server-owned notification snapshots and background sync jobs."""

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ghinbox.api.fetcher import get_fetcher, run_fetcher_call
from ghinbox.api.github_proxy import (
    fetch_bulk_comment_results,
    fetch_review_request_notifications,
    get_token,
)
from ghinbox.api.rate_governor import get_rate_governor
from ghinbox.api.notification_shapes import (
    utc_now_iso,
    build_comment_cache_entry as _build_comment_cache_entry,
    is_comment_cache_entry_reusable,
    notification_to_bulk_comment_item as _notification_to_bulk_comment_item,
)
from ghinbox.api.repo_keys import repo_key
from ghinbox.api.snapshot_store import (
    apply_local_state,
    get_snapshot,
    get_snapshot_profile,
    get_sync_state,
    list_snapshot_repos,
    save_snapshot,
    save_snapshot_profile,
    set_sync_state,
)
from ghinbox.api.routes import mark_github_session_expired
from ghinbox.parser.notifications import SessionExpiredError, parse_notifications_html

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])

# Hard ceiling on notification pages fetched per profile entry. A cursor walk
# that never terminates (e.g. a pagination parsing regression) must fail the
# sync rather than burn the GitHub rate limit.
MAX_SNAPSHOT_FETCH_PAGES = 50

# Background sync wakes up this often to look for snapshots that are due.
PERIODIC_TICK_SECONDS = 60
# After a failed sync, wait this many intervals before retrying the key.
PERIODIC_ERROR_BACKOFF_INTERVALS = 4
# Extra core-pool quota (beyond the background floor) that must remain before
# a periodic sync starts. A sync that only refetches changed threads is cheap,
# but a cold comment cache can cost ~3 calls per notification.
PERIODIC_CORE_RESERVE = 500

logger = logging.getLogger(__name__)

_running_tasks: dict[str, asyncio.Task] = {}
_periodic_task: asyncio.Task | None = None
_post_sync_hooks: list[Callable[[str], Awaitable[None]]] = []


class StartSyncRequest(BaseModel):
    mode: Literal["full"] = "full"


class SnapshotEntry(BaseModel):
    """One source within a profile snapshot.

    A profile is an ordered list of these. ``kind="repo"`` fetches the repo's
    notification inbox (and scopes review-request search to that repo);
    ``kind="query"`` fetches an arbitrary GitHub notifications query (e.g.
    ``org:pytorch``) and scopes review-request search to that same query.
    """

    kind: Literal["repo", "query"] = "repo"
    owner: str | None = None
    repo: str | None = None
    query: str | None = None


class ProfileSyncRequest(BaseModel):
    mode: Literal["full"] = "full"
    entries: list[SnapshotEntry]


def _entry_for_repo(owner: str, repo: str) -> SnapshotEntry:
    return SnapshotEntry(kind="repo", owner=owner, repo=repo)


def _profile_key(name: str) -> str:
    """Snapshot store key for a named profile.

    Prefixed to avoid ever colliding with an ``owner/repo`` key.
    """
    return f"profile:{name}"


def _deduplicate_notifications_by_id(notifications: list[dict]) -> list[dict]:
    """Keep the first row for each GitHub notification ID.

    Profile queries are not guaranteed to be disjoint. In particular, GitHub
    can return an org notification for both an ``org:`` query and the profile's
    negative-org catch-all query. Rows without an ID are retained so malformed
    upstream data remains visible rather than being collapsed together.
    """
    deduplicated: list[dict] = []
    seen_ids: set[str] = set()
    for notification in notifications:
        notification_id = str(notification.get("id") or "")
        if notification_id and notification_id in seen_ids:
            continue
        if notification_id:
            seen_ids.add(notification_id)
        deduplicated.append(notification)
    return deduplicated


def _merge_review_request_notifications(
    notifications: list[dict],
    review_requests: list[dict],
) -> list[dict]:
    if not review_requests:
        return notifications
    merged = [dict(notification) for notification in notifications]
    index_by_id = {
        str(notification.get("id")): index
        for index, notification in enumerate(merged)
        if notification.get("id")
    }
    for request_notification in review_requests:
        request_id = str(request_notification.get("id") or "")
        existing_index = index_by_id.get(request_id)
        if existing_index is None:
            index_by_id[request_id] = len(merged)
            merged.append(request_notification)
            continue
        existing = merged[existing_index]
        merged[existing_index] = {
            **existing,
            **request_notification,
            "ui": existing.get("ui") or request_notification.get("ui"),
            "responsibility_source": "review-requested",
        }
    return merged


def _partition_comment_items(
    owner: str | None,
    repo: str | None,
    notifications: list[dict],
    previous_cache: dict | None,
    now: datetime | None = None,
) -> tuple[dict[str, dict], list[dict]]:
    """Split notifications into reusable cached threads and items to fetch."""
    previous_threads = (previous_cache or {}).get("threads")
    if not isinstance(previous_threads, dict):
        previous_threads = {}
    current_time = now or datetime.now(timezone.utc)
    reused: dict[str, dict] = {}
    to_fetch: list[dict] = []
    for notification in notifications:
        item = _notification_to_bulk_comment_item(notification, owner, repo)
        if item is None:
            continue
        cached = previous_threads.get(item["key"])
        if is_comment_cache_entry_reusable(cached, notification, current_time):
            assert isinstance(cached, dict)
            reused[item["key"]] = {**cached, "unread": notification.get("unread")}
        else:
            to_fetch.append(item)
    return reused, to_fetch


async def _fetch_snapshot_comment_cache(
    owner: str | None,
    repo: str | None,
    notifications: list[dict],
    *,
    previous_cache: dict | None = None,
    on_progress=None,
) -> dict | None:
    token = get_token()
    if not token:
        return None
    token_value = token
    threads, items = _partition_comment_items(
        owner, repo, notifications, previous_cache
    )
    if not items:
        return {"version": 1, "threads": threads}

    results = await fetch_bulk_comment_results(
        token_value,
        items,
        on_progress=on_progress,
    )
    notifications_by_key = {
        str(notification.get("id") or ""): notification
        for notification in notifications
    }
    fetched_at = utc_now_iso()
    for key, result in results:
        notification = notifications_by_key.get(key)
        if not notification:
            continue
        threads[key] = _build_comment_cache_entry(notification, result, fetched_at)
    return {"version": 1, "threads": threads}


async def _cancel_background_task(task: asyncio.Task[Any] | None) -> None:
    if task is None:
        return
    if not task.done():
        task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


async def _fetch_one_entry_notifications(
    fetcher: Any,
    entry: SnapshotEntry,
    on_page: Any,
    base_total: int,
) -> tuple[list[dict], str | None, str | None, str | None]:
    """Walk all notification pages for a single profile entry.

    ``on_page(cumulative_total)`` is called after each page so the caller can
    update aggregate sync state; ``base_total`` is the count already collected
    from earlier entries. Returns (notifications, authenticity_token,
    source_url, generated_at) for this entry.
    """
    notifications: list[dict] = []
    authenticity_token: str | None = None
    source_url: str | None = None
    generated_at: str | None = None
    after: str | None = None
    entry_pages = 0
    while True:
        if entry_pages >= MAX_SNAPSHOT_FETCH_PAGES:
            raise RuntimeError(
                f"Snapshot sync exceeded {MAX_SNAPSHOT_FETCH_PAGES} "
                "notification pages for one entry"
            )
        entry_pages += 1
        if entry.kind == "repo":
            result = await run_fetcher_call(
                fetcher.fetch_repo_notifications,
                owner=entry.owner,
                repo=entry.repo,
                after=after,
            )
        else:
            result = await run_fetcher_call(
                fetcher.fetch_notifications_query,
                query=entry.query,
                after=after,
            )
        if result.status == "session_expired":
            raise SessionExpiredError(
                result.error or "GitHub session has expired. Please re-authenticate."
            )
        if result.status == "error":
            raise RuntimeError(result.error or "Failed to fetch from GitHub")

        parsed = parse_notifications_html(
            html=result.html,
            owner=entry.owner or "",
            repo=entry.repo or "",
            source_url=result.url,
        )
        notifications.extend(
            notification.model_dump(mode="json")
            for notification in parsed.notifications
        )
        if parsed.authenticity_token and not authenticity_token:
            authenticity_token = parsed.authenticity_token
        if source_url is None:
            source_url = parsed.source_url
        generated_at = parsed.generated_at.isoformat()

        on_page(base_total + len(notifications))

        if not parsed.pagination.has_next:
            break
        after = parsed.pagination.after_cursor
        if not after:
            break
    return notifications, authenticity_token, source_url, generated_at


async def _fetch_snapshot(snapshot_key: str, entries: list[SnapshotEntry]) -> None:
    started_at = utc_now_iso()
    all_notifications: list[dict] = []
    authenticity_token: str | None = None
    source_url: str | None = None
    generated_at: str | None = None
    pages_fetched = 0
    phase = "notifications"
    comments_total = 0
    comments_fetched = 0
    comments_failed = 0
    review_requests_task: asyncio.Task[list[dict]] | None = None

    set_sync_state(
        snapshot_key,
        status="running",
        mode="full",
        phase=phase,
        started_at=started_at,
        pages_fetched=0,
        notifications_count=0,
    )

    try:
        fetcher = get_fetcher()
        if fetcher is None:
            raise RuntimeError(
                "No GitHub fetcher configured. Start server with --account."
            )

        async def _fetch_all_review_requests() -> list[dict]:
            merged: list[dict] = []
            for entry in entries:
                merged.extend(
                    await fetch_review_request_notifications(
                        entry.owner,
                        entry.repo,
                        query=None if entry.kind == "repo" else entry.query,
                    )
                )
            return merged

        previous_snapshot = get_snapshot(snapshot_key)
        previous_comment_cache = (
            previous_snapshot.get("comment_cache") if previous_snapshot else None
        )
        review_requests_task = asyncio.create_task(_fetch_all_review_requests())

        def _on_page(current_total: int) -> None:
            nonlocal pages_fetched
            pages_fetched += 1
            set_sync_state(
                snapshot_key,
                status="running",
                mode="full",
                phase=phase,
                started_at=started_at,
                pages_fetched=pages_fetched,
                notifications_count=current_total,
            )

        for entry in entries:
            base_total = len(all_notifications)
            (
                entry_notifications,
                entry_token,
                entry_source_url,
                entry_generated_at,
            ) = await _fetch_one_entry_notifications(
                fetcher, entry, _on_page, base_total
            )
            all_notifications.extend(entry_notifications)
            if entry_token and not authenticity_token:
                authenticity_token = entry_token
            if source_url is None:
                source_url = entry_source_url
            if entry_generated_at:
                generated_at = entry_generated_at

        phase = "reviews"
        set_sync_state(
            snapshot_key,
            status="running",
            mode="full",
            phase=phase,
            started_at=started_at,
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
        )
        review_requests = await review_requests_task
        review_requests_task = None
        all_notifications = _deduplicate_notifications_by_id(all_notifications)
        merged_notifications: list[dict] = _merge_review_request_notifications(
            all_notifications,
            review_requests,
        )
        all_notifications = merged_notifications
        all_notifications.sort(
            key=lambda notification: notification.get("updated_at", ""),
            reverse=True,
        )
        final_count = len(all_notifications)
        save_snapshot(
            snapshot_key,
            all_notifications,
            preserve_comment_cache=True,
            authenticity_token=authenticity_token,
            source_url=source_url,
            generated_at=generated_at,
        )
        notifications_for_comment_cache = apply_local_state(
            snapshot_key, all_notifications
        )
        _, comment_items_to_fetch = _partition_comment_items(
            None, None, notifications_for_comment_cache, previous_comment_cache
        )
        comments_total = len(comment_items_to_fetch)
        phase = "comments" if comments_total else "complete"
        set_sync_state(
            snapshot_key,
            status="running",
            mode="full",
            phase=phase,
            started_at=started_at,
            pages_fetched=pages_fetched,
            notifications_count=final_count,
            comments_total=comments_total,
            comments_fetched=comments_fetched,
            comments_failed=comments_failed,
        )

        def on_comment_progress(result: tuple[str, dict]) -> None:
            nonlocal comments_fetched, comments_failed
            comments_fetched += 1
            _, payload = result
            if payload.get("error"):
                comments_failed += 1
            set_sync_state(
                snapshot_key,
                status="running",
                mode="full",
                phase="comments",
                started_at=started_at,
                pages_fetched=pages_fetched,
                notifications_count=final_count,
                comments_total=comments_total,
                comments_fetched=comments_fetched,
                comments_failed=comments_failed,
            )

        comment_cache = await _fetch_snapshot_comment_cache(
            None,
            None,
            notifications_for_comment_cache,
            previous_cache=previous_comment_cache,
            on_progress=on_comment_progress,
        )
        save_snapshot(
            snapshot_key,
            all_notifications,
            comment_cache=comment_cache,
            authenticity_token=authenticity_token,
            source_url=source_url,
            generated_at=generated_at,
        )
        set_sync_state(
            snapshot_key,
            status="success",
            mode="full",
            phase="complete",
            started_at=started_at,
            finished_at=utc_now_iso(),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
            comments_total=comments_total,
            comments_fetched=comments_fetched,
            comments_failed=comments_failed,
        )
        await _run_post_sync_hooks(snapshot_key)
    except SessionExpiredError as error:
        await _cancel_background_task(review_requests_task)
        set_sync_state(
            snapshot_key,
            status="error",
            mode="full",
            phase=phase,
            started_at=started_at,
            finished_at=utc_now_iso(),
            error=str(error),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
            comments_total=comments_total,
            comments_fetched=comments_fetched,
            comments_failed=comments_failed,
        )
        mark_github_session_expired()
    except Exception as error:
        await _cancel_background_task(review_requests_task)
        set_sync_state(
            snapshot_key,
            status="error",
            mode="full",
            phase=phase,
            started_at=started_at,
            finished_at=utc_now_iso(),
            error=str(error),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
            comments_total=comments_total,
            comments_fetched=comments_fetched,
            comments_failed=comments_failed,
        )
    finally:
        _running_tasks.pop(snapshot_key, None)


def _start_sync_task(snapshot_key: str, entries: list[SnapshotEntry]) -> None:
    task = _running_tasks.get(snapshot_key)
    if task and not task.done():
        return
    _running_tasks[snapshot_key] = asyncio.create_task(
        _fetch_snapshot(snapshot_key, entries)
    )


def register_post_sync_hook(hook: Callable[[str], Awaitable[None]]) -> None:
    """Run ``hook(snapshot_key)`` after every successful snapshot sync."""
    if hook not in _post_sync_hooks:
        _post_sync_hooks.append(hook)


def clear_post_sync_hooks() -> None:
    _post_sync_hooks.clear()


async def _run_post_sync_hooks(snapshot_key: str) -> None:
    for hook in list(_post_sync_hooks):
        try:
            await hook(snapshot_key)
        except Exception:
            logger.exception("Post-sync hook failed for %s", snapshot_key)


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_periodic_sync_due(
    sync_state: dict,
    interval_seconds: int,
    now: datetime,
) -> bool:
    """Whether a snapshot's last sync is old enough to refresh in the background.

    Failed syncs back off for several intervals so a persistent error (expired
    session, GitHub outage) does not retry every tick.
    """
    if sync_state.get("status") == "running":
        return False
    last = _parse_timestamp(sync_state.get("finished_at")) or _parse_timestamp(
        sync_state.get("started_at")
    )
    if last is None:
        return True
    wait_seconds = interval_seconds
    if sync_state.get("status") == "error":
        wait_seconds *= PERIODIC_ERROR_BACKOFF_INTERVALS
    return (now - last).total_seconds() >= wait_seconds


def _periodic_sync_targets() -> list[tuple[str, list[SnapshotEntry]]]:
    targets: list[tuple[str, list[SnapshotEntry]]] = []
    for snapshot_key in list_snapshot_repos():
        if snapshot_key.startswith("profile:"):
            stored_entries = get_snapshot_profile(snapshot_key)
            if not stored_entries:
                # Synced before profile entries were persisted; the next
                # client-triggered sync records them.
                continue
            try:
                entries = [SnapshotEntry.model_validate(e) for e in stored_entries]
            except ValueError:
                continue
            targets.append((snapshot_key, entries))
            continue
        owner, sep, repo = snapshot_key.partition("/")
        if not sep or not owner or not repo:
            continue
        targets.append((snapshot_key, [_entry_for_repo(owner, repo)]))
    return targets


def periodic_sync_skip_reason() -> str | None:
    """Why background sync should not start right now, if anything."""
    if get_fetcher() is None:
        return "no fetcher"
    if os.environ.get("GHINBOX_NEEDS_AUTH") == "1":
        return "GitHub session needs re-authentication"
    if not get_rate_governor().has_background_headroom(
        "core", reserve=PERIODIC_CORE_RESERVE
    ):
        return "GitHub core rate limit headroom is low"
    return None


def run_due_periodic_sync(
    interval_seconds: int,
    now: datetime | None = None,
) -> str | None:
    """Start at most one due background sync; return its snapshot key.

    One sync per tick spreads load across profiles rather than bursting every
    snapshot at once, and nothing starts while any sync is already running.
    """
    if any(not task.done() for task in _running_tasks.values()):
        return None
    skip_reason = periodic_sync_skip_reason()
    if skip_reason is not None:
        logger.info("Skipping periodic snapshot sync: %s", skip_reason)
        return None
    current_time = now or datetime.now(timezone.utc)
    for snapshot_key, entries in _periodic_sync_targets():
        if is_periodic_sync_due(
            get_sync_state(snapshot_key), interval_seconds, current_time
        ):
            _start_sync_task(snapshot_key, entries)
            return snapshot_key
    return None


async def _periodic_snapshot_sync(interval_seconds: int) -> None:
    tick = min(PERIODIC_TICK_SECONDS, interval_seconds)
    while True:
        await asyncio.sleep(tick)
        try:
            run_due_periodic_sync(interval_seconds)
        except Exception:
            logger.exception("Periodic snapshot sync tick failed")


def start_periodic_snapshot_sync(interval_seconds: int) -> asyncio.Task | None:
    """Keep every stored snapshot (repo and profile) fresh in the background."""
    global _periodic_task
    if interval_seconds <= 0:
        return None
    if _periodic_task and not _periodic_task.done():
        return _periodic_task
    _periodic_task = asyncio.create_task(_periodic_snapshot_sync(interval_seconds))
    return _periodic_task


def stop_periodic_snapshot_sync() -> None:
    """Stop the periodic sync task, if running."""
    global _periodic_task
    if _periodic_task and not _periodic_task.done():
        _periodic_task.cancel()
    _periodic_task = None


def _compact_entry(entry: dict) -> dict:
    return {key: value for key, value in entry.items() if value is not None}


def _server_sync_info(watched_entries: list[dict] | None) -> dict:
    """What the server keeps fresh in the background for a snapshot read.

    The client starts a server sync when nothing is watched (fresh install, or
    a profile synced before its entries were persisted) or when the watched
    entries no longer match the profile.
    """
    return {
        "available": get_fetcher() is not None,
        "watched_entries": (
            [_compact_entry(entry) for entry in watched_entries]
            if watched_entries is not None
            else None
        ),
    }


@router.get("/profile/{name}")
async def get_profile_snapshot(name: str) -> dict:
    snapshot_key = _profile_key(name)
    snapshot = get_snapshot(snapshot_key)
    return {
        "profile": {"name": name, "key": snapshot_key},
        "snapshot": snapshot,
        "sync": get_sync_state(snapshot_key),
        "server_sync": _server_sync_info(
            get_snapshot_profile(snapshot_key) if snapshot is not None else None
        ),
    }


@router.post("/profile/{name}/sync")
async def start_profile_snapshot_sync(name: str, body: ProfileSyncRequest) -> dict:
    if body.mode != "full":
        raise HTTPException(status_code=400, detail="Only full sync is supported")
    if not body.entries:
        raise HTTPException(status_code=400, detail="At least one entry is required")
    for entry in body.entries:
        if entry.kind == "repo" and not (entry.owner and entry.repo):
            raise HTTPException(
                status_code=400,
                detail="repo entries require owner and repo",
            )
        if entry.kind == "query" and not entry.query:
            raise HTTPException(
                status_code=400,
                detail="query entries require a query",
            )
    if get_fetcher() is None:
        raise HTTPException(
            status_code=503,
            detail="No GitHub fetcher configured. Start server with --account.",
        )
    snapshot_key = _profile_key(name)
    save_snapshot_profile(
        snapshot_key, [entry.model_dump(mode="json") for entry in body.entries]
    )
    _start_sync_task(snapshot_key, list(body.entries))
    return {
        "profile": {"name": name, "key": snapshot_key},
        "sync": get_sync_state(snapshot_key),
    }


@router.get("/profile/{name}/sync")
async def get_profile_snapshot_sync(name: str) -> dict:
    snapshot_key = _profile_key(name)
    return {
        "profile": {"name": name, "key": snapshot_key},
        "sync": get_sync_state(snapshot_key),
        "snapshot": get_snapshot(snapshot_key),
    }


@router.get("/{owner}/{repo}")
async def get_notification_snapshot(owner: str, repo: str) -> dict:
    full_repo_name = repo_key(owner, repo)
    snapshot = get_snapshot(full_repo_name)
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": full_repo_name,
        },
        "snapshot": snapshot,
        "sync": get_sync_state(full_repo_name),
        # Every stored repo snapshot is a periodic sync target.
        "server_sync": _server_sync_info(
            [_entry_for_repo(owner, repo).model_dump(mode="json")]
            if snapshot is not None
            else None
        ),
    }


@router.post("/{owner}/{repo}/sync")
async def start_notification_snapshot_sync(
    owner: str,
    repo: str,
    body: StartSyncRequest | None = None,
) -> dict:
    if body and body.mode != "full":
        raise HTTPException(status_code=400, detail="Only full sync is supported")
    if get_fetcher() is None:
        raise HTTPException(
            status_code=503,
            detail="No GitHub fetcher configured. Start server with --account.",
        )
    full_repo_name = repo_key(owner, repo)
    _start_sync_task(full_repo_name, [_entry_for_repo(owner, repo)])
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": full_repo_name,
        },
        "sync": get_sync_state(full_repo_name),
    }


@router.get("/{owner}/{repo}/sync")
async def get_notification_snapshot_sync(owner: str, repo: str) -> dict:
    full_repo_name = repo_key(owner, repo)
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": full_repo_name,
        },
        "sync": get_sync_state(full_repo_name),
        "snapshot": get_snapshot(full_repo_name),
    }
