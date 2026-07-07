"""Server-owned notification snapshots and background sync jobs."""

import asyncio
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
from ghinbox.api.notification_shapes import (
    build_comment_cache_entry as _build_comment_cache_entry,
    notification_to_bulk_comment_item as _notification_to_bulk_comment_item,
)
from ghinbox.api.repo_keys import repo_key
from ghinbox.api.snapshot_store import (
    apply_local_state,
    get_snapshot,
    get_sync_state,
    list_snapshot_repos,
    save_snapshot,
    set_sync_state,
)
from ghinbox.api.routes import mark_github_session_expired
from ghinbox.parser.notifications import SessionExpiredError, parse_notifications_html

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])

_running_tasks: dict[str, asyncio.Task] = {}
_periodic_task: asyncio.Task | None = None


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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


async def _fetch_snapshot_comment_cache(
    owner: str | None,
    repo: str | None,
    notifications: list[dict],
    *,
    on_progress=None,
) -> dict | None:
    token = get_token()
    if not token:
        return None
    token_value = token
    items = [
        item
        for notification in notifications
        if (item := _notification_to_bulk_comment_item(notification, owner, repo))
        is not None
    ]
    if not items:
        return {"version": 1, "threads": {}}

    results = await fetch_bulk_comment_results(
        token_value,
        items,
        on_progress=on_progress,
    )
    notifications_by_key = {
        str(notification.get("id") or ""): notification
        for notification in notifications
    }
    fetched_at = _now()
    threads = {}
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
    while True:
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
    started_at = _now()
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
        comments_total = sum(
            1
            for notification in notifications_for_comment_cache
            if _notification_to_bulk_comment_item(notification) is not None
        )
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
            finished_at=_now(),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
            comments_total=comments_total,
            comments_fetched=comments_fetched,
            comments_failed=comments_failed,
        )
    except SessionExpiredError as error:
        await _cancel_background_task(review_requests_task)
        set_sync_state(
            snapshot_key,
            status="error",
            mode="full",
            phase=phase,
            started_at=started_at,
            finished_at=_now(),
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
            finished_at=_now(),
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


async def _periodic_snapshot_sync(interval_seconds: int) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        if get_fetcher() is None:
            continue
        for snapshot_repo_key in list_snapshot_repos():
            # Profile snapshots need their entry list to re-sync, which is not
            # persisted; they self-heal on the next client/digest-triggered
            # sync instead. Periodic sync only covers owner/repo snapshots.
            if snapshot_repo_key.startswith("profile:"):
                continue
            owner, sep, repo = snapshot_repo_key.partition("/")
            if not sep or not owner or not repo:
                continue
            _start_sync_task(snapshot_repo_key, [_entry_for_repo(owner, repo)])


def start_periodic_snapshot_sync(interval_seconds: int) -> asyncio.Task | None:
    """Start periodic sync for repos with existing snapshots."""
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


@router.get("/profile/{name}")
async def get_profile_snapshot(name: str) -> dict:
    snapshot_key = _profile_key(name)
    return {
        "profile": {"name": name, "key": snapshot_key},
        "snapshot": get_snapshot(snapshot_key),
        "sync": get_sync_state(snapshot_key),
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
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": full_repo_name,
        },
        "snapshot": get_snapshot(full_repo_name),
        "sync": get_sync_state(full_repo_name),
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
