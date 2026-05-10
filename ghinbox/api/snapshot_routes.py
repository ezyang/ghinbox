"""Server-owned notification snapshots and background sync jobs."""

import asyncio
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ghinbox.api.fetcher import get_fetcher, run_fetcher_call
from ghinbox.api.github_proxy import GITHUB_API_BASE, get_client, get_token
from ghinbox.api.snapshot_store import (
    clear_snapshot_store,
    get_snapshot,
    get_sync_state,
    list_snapshot_repos,
    save_snapshot,
    set_sync_state,
)
from ghinbox.parser.notifications import SessionExpiredError, parse_notifications_html

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])

REVIEW_REQUEST_SEARCH_PER_PAGE = 100

_running_tasks: dict[str, asyncio.Task] = {}
_periodic_task: asyncio.Task | None = None


class StartSyncRequest(BaseModel):
    mode: Literal["full"] = "full"


def _repo_key(owner: str, repo: str) -> str:
    return f"{owner}/{repo}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_review_request_search_query(owner: str, repo: str) -> str:
    return " ".join(
        [
            f"repo:{owner}/{repo}",
            "is:pr",
            "is:open",
            "user-review-requested:@me",
            "-review:approved",
        ]
    )


def _search_item_to_review_request_notification(
    owner: str,
    repo: str,
    item: dict,
) -> dict | None:
    number = item.get("number")
    if not number or item.get("pull_request") is None:
        return None
    user = item.get("user") or {}
    state = "draft" if item.get("draft") else "open"
    updated_at = item.get("updated_at") or item.get("created_at") or _now()
    return {
        "id": f"review-request:{owner}/{repo}#{number}",
        "unread": False,
        "reason": "review_requested",
        "responsibility_source": "review-requested",
        "updated_at": updated_at,
        "last_read_at": item.get("updated_at") or item.get("created_at"),
        "subject": {
            "title": item.get("title") or f"Pull request #{number}",
            "url": item.get("html_url")
            or f"https://github.com/{owner}/{repo}/pull/{number}",
            "type": "PullRequest",
            "number": number,
            "state": state,
            "state_reason": None,
        },
        "actors": (
            [
                {
                    "login": user["login"],
                    "avatar_url": user.get("avatar_url") or "",
                }
            ]
            if user.get("login")
            else []
        ),
        "ui": {
            "saved": False,
            "done": False,
            "action_tokens": {},
        },
    }


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


async def _fetch_review_request_notifications(owner: str, repo: str) -> list[dict]:
    token = get_token()
    if not token:
        return []

    query = _build_review_request_search_query(owner, repo)
    url = (
        f"{GITHUB_API_BASE}/search/issues?"
        f"{urlencode({'q': query, 'per_page': REVIEW_REQUEST_SEARCH_PER_PAGE})}"
    )
    response = await get_client().get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Review request search failed ({response.status_code}): {response.text}"
        )
    payload = response.json()
    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return []
    notifications = []
    for item in items:
        if not isinstance(item, dict):
            continue
        notification = _search_item_to_review_request_notification(owner, repo, item)
        if notification is not None:
            notifications.append(notification)
    return notifications


async def _fetch_snapshot(owner: str, repo: str) -> None:
    repo_key = _repo_key(owner, repo)
    started_at = _now()
    all_notifications: list[dict] = []
    authenticity_token: str | None = None
    source_url: str | None = None
    generated_at: str | None = None
    pages_fetched = 0

    set_sync_state(
        repo_key,
        status="running",
        mode="full",
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

        after: str | None = None
        while True:
            result = await run_fetcher_call(
                fetcher.fetch_repo_notifications,
                owner=owner,
                repo=repo,
                after=after,
            )
            if result.status == "error":
                raise RuntimeError(result.error or "Failed to fetch from GitHub")

            parsed = parse_notifications_html(
                html=result.html,
                owner=owner,
                repo=repo,
                source_url=result.url,
            )
            pages_fetched += 1
            all_notifications.extend(
                notification.model_dump(mode="json")
                for notification in parsed.notifications
            )
            if parsed.authenticity_token and not authenticity_token:
                authenticity_token = parsed.authenticity_token
            if source_url is None:
                source_url = parsed.source_url
            generated_at = parsed.generated_at.isoformat()

            set_sync_state(
                repo_key,
                status="running",
                mode="full",
                started_at=started_at,
                pages_fetched=pages_fetched,
                notifications_count=len(all_notifications),
            )

            if not parsed.pagination.has_next:
                break
            after = parsed.pagination.after_cursor
            if not after:
                break

        review_requests = await _fetch_review_request_notifications(owner, repo)
        all_notifications = _merge_review_request_notifications(
            all_notifications,
            review_requests,
        )
        all_notifications.sort(
            key=lambda notification: notification.get("updated_at", ""),
            reverse=True,
        )
        save_snapshot(
            repo_key,
            all_notifications,
            authenticity_token=authenticity_token,
            source_url=source_url,
            generated_at=generated_at,
        )
        set_sync_state(
            repo_key,
            status="success",
            mode="full",
            started_at=started_at,
            finished_at=_now(),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
        )
    except SessionExpiredError as error:
        set_sync_state(
            repo_key,
            status="error",
            mode="full",
            started_at=started_at,
            finished_at=_now(),
            error=str(error),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
        )
    except Exception as error:
        set_sync_state(
            repo_key,
            status="error",
            mode="full",
            started_at=started_at,
            finished_at=_now(),
            error=str(error),
            pages_fetched=pages_fetched,
            notifications_count=len(all_notifications),
        )
    finally:
        _running_tasks.pop(repo_key, None)


def _start_sync_task(owner: str, repo: str) -> None:
    repo_key = _repo_key(owner, repo)
    task = _running_tasks.get(repo_key)
    if task and not task.done():
        return
    _running_tasks[repo_key] = asyncio.create_task(_fetch_snapshot(owner, repo))


async def _periodic_snapshot_sync(interval_seconds: int) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        if get_fetcher() is None:
            continue
        for repo_key in list_snapshot_repos():
            owner, sep, repo = repo_key.partition("/")
            if not sep or not owner or not repo:
                continue
            _start_sync_task(owner, repo)


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


@router.get("/{owner}/{repo}")
async def get_notification_snapshot(owner: str, repo: str) -> dict:
    repo_key = _repo_key(owner, repo)
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": repo_key,
        },
        "snapshot": get_snapshot(repo_key),
        "sync": get_sync_state(repo_key),
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
    repo_key = _repo_key(owner, repo)
    _start_sync_task(owner, repo)
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": repo_key,
        },
        "sync": get_sync_state(repo_key),
    }


@router.get("/{owner}/{repo}/sync")
async def get_notification_snapshot_sync(owner: str, repo: str) -> dict:
    repo_key = _repo_key(owner, repo)
    return {
        "repository": {
            "owner": owner,
            "name": repo,
            "full_name": repo_key,
        },
        "sync": get_sync_state(repo_key),
        "snapshot": get_snapshot(repo_key),
    }


@router.delete("/all")
async def delete_all_snapshots() -> dict:
    """Clear snapshot data. Only available in test mode."""
    import os

    if os.environ.get("GHINBOX_TEST_MODE") != "1":
        raise HTTPException(status_code=403, detail="Only available in test mode")
    clear_snapshot_store()
    return {"status": "ok"}
