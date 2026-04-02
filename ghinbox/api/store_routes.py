"""
FastAPI router for server-side notification persistence.
"""

from fastapi import APIRouter
from pydantic import BaseModel

import os

from ghinbox.api.store import (
    clear_all,
    clear_comment_cache,
    clear_repo,
    get_comment_cache,
    get_notifications,
    mark_done,
    save_comment_cache_thread,
    save_notifications,
    unmark_done,
)

router = APIRouter(prefix="/api/store", tags=["store"])


class SaveNotificationsRequest(BaseModel):
    notifications: list[dict]
    clear_done: bool = False


class MarkDoneRequest(BaseModel):
    notification_ids: list[str]


class UnmarkDoneRequest(BaseModel):
    notification_ids: list[str]
    notifications: list[dict]


class SaveCommentThreadRequest(BaseModel):
    data: dict


@router.get("/notifications/{owner}/{repo}")
async def get_stored_notifications(owner: str, repo: str):
    repo_key = f"{owner}/{repo}"
    notifications, done_ids = get_notifications(repo_key)
    return {
        "notifications": notifications,
        "done_ids": list(done_ids),
    }


@router.put("/notifications/{owner}/{repo}")
async def save_stored_notifications(
    owner: str, repo: str, body: SaveNotificationsRequest
):
    repo_key = f"{owner}/{repo}"
    save_notifications(repo_key, body.notifications, clear_done=body.clear_done)
    return {"status": "ok"}


@router.post("/done/{owner}/{repo}")
async def mark_notifications_done(owner: str, repo: str, body: MarkDoneRequest):
    repo_key = f"{owner}/{repo}"
    mark_done(repo_key, body.notification_ids)
    return {"status": "ok"}


@router.delete("/done/{owner}/{repo}")
async def unmark_notifications_done(owner: str, repo: str, body: UnmarkDoneRequest):
    repo_key = f"{owner}/{repo}"
    unmark_done(repo_key, body.notification_ids, body.notifications)
    return {"status": "ok"}


@router.get("/comments/{owner}/{repo}")
async def get_stored_comments(owner: str, repo: str):
    repo_key = f"{owner}/{repo}"
    cache = get_comment_cache(repo_key)
    return {"cache": cache}


@router.put("/comments/{owner}/{repo}/threads/{thread_key}")
async def save_stored_comment_thread(
    owner: str, repo: str, thread_key: str, body: SaveCommentThreadRequest
):
    repo_key = f"{owner}/{repo}"
    save_comment_cache_thread(repo_key, thread_key, body.data)
    return {"status": "ok"}


@router.delete("/comments/{owner}/{repo}")
async def delete_stored_comments(owner: str, repo: str):
    repo_key = f"{owner}/{repo}"
    clear_comment_cache(repo_key)
    return {"status": "ok"}


@router.delete("/notifications/{owner}/{repo}")
async def delete_stored_notifications(owner: str, repo: str):
    repo_key = f"{owner}/{repo}"
    clear_repo(repo_key)
    return {"status": "ok"}


@router.delete("/all")
async def delete_all_stored_data():
    """Clear all server-side store data. Only available in test mode."""
    from fastapi import HTTPException

    if os.environ.get("GHINBOX_TEST_MODE") != "1":
        raise HTTPException(status_code=403, detail="Only available in test mode")
    clear_all()
    return {"status": "ok"}
