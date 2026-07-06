"""Local-only notification state routes."""

from typing import Callable

from fastapi import APIRouter
from pydantic import BaseModel

from ghinbox.api.repo_keys import repo_key
from ghinbox.api.snapshot_store import (
    set_notification_bookmark,
    set_notification_read_comment_watermark,
    set_notification_replies_muted,
)

router = APIRouter(prefix="/notifications/html", tags=["notifications"])


class NotificationBookmarkRequest(BaseModel):
    """Request body for local bookmark state."""

    bookmarked: bool


class NotificationRepliesMutedRequest(BaseModel):
    """Request body for local Replies suppression state."""

    replies_muted: bool


class NotificationReadCommentWatermarkRequest(BaseModel):
    """Request body for local read-comment watermark state."""

    read_comment_watermark_at: str | None = None


def _local_state_response(
    owner: str,
    repo: str,
    notification_id: str,
    field: str,
    value: bool | str | None,
    *,
    setter: Callable[..., dict],
) -> dict:
    full_repo_name = repo_key(owner, repo)
    result = setter(full_repo_name, notification_id, value)
    notification_id = result["notification_id"]
    value = result[field]
    return {
        "status": "ok",
        "repo": full_repo_name,
        "notification_id": notification_id,
        field: value,
    }


@router.put(
    "/repo/{owner}/{repo}/bookmarks/{notification_id}",
    summary="Set local bookmark state",
)
async def set_bookmark(
    owner: str,
    repo: str,
    notification_id: str,
    request: NotificationBookmarkRequest,
) -> dict:
    return _local_state_response(
        owner,
        repo,
        notification_id,
        "bookmarked",
        request.bookmarked,
        setter=set_notification_bookmark,
    )


@router.put(
    "/repo/{owner}/{repo}/replies-muted/{notification_id}",
    summary="Set local Replies suppression state",
)
async def set_replies_muted(
    owner: str,
    repo: str,
    notification_id: str,
    request: NotificationRepliesMutedRequest,
) -> dict:
    return _local_state_response(
        owner,
        repo,
        notification_id,
        "replies_muted",
        request.replies_muted,
        setter=set_notification_replies_muted,
    )


@router.put(
    "/repo/{owner}/{repo}/read-comment-watermarks/{notification_id}",
    summary="Set local read-comment watermark",
)
async def set_read_comment_watermark(
    owner: str,
    repo: str,
    notification_id: str,
    request: NotificationReadCommentWatermarkRequest,
) -> dict:
    return _local_state_response(
        owner,
        repo,
        notification_id,
        "read_comment_watermark_at",
        request.read_comment_watermark_at,
        setter=set_notification_read_comment_watermark,
    )
