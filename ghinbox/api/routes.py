"""
FastAPI route handlers for the HTML notifications API.
"""

import time
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi import Request
from pydantic import BaseModel

from ghinbox.api.fetcher import get_fetcher, run_fetcher_call
from ghinbox.api.models import NotificationsResponse
from ghinbox.api.observability import emit_notification_action_audit
from ghinbox.api.snapshot_store import (
    apply_local_state,
    get_notification_bookmark,
    get_notification_read_comment_watermark,
    get_notification_replies_muted,
    set_notification_bookmark,
    set_notification_read_comment_watermark,
    set_notification_replies_muted,
)
from ghinbox.parser.notifications import SessionExpiredError, parse_notifications_html

router = APIRouter(prefix="/notifications/html", tags=["notifications"])
MAX_GITHUB_NOTIFICATION_ACTION_IDS = 25


class NotificationActionRequest(BaseModel):
    """Request body for notification actions."""

    action: Literal["archive", "unarchive", "subscribe", "unsubscribe"]
    notification_ids: list[str]
    authenticity_token: str


class NotificationActionResponse(BaseModel):
    """Response from a notification action."""

    status: Literal["ok", "error"]
    error: str | None = None


class NotificationBookmarkRequest(BaseModel):
    """Request body for local bookmark state."""

    bookmarked: bool


class NotificationBookmarkResponse(BaseModel):
    """Response from a local bookmark update."""

    status: Literal["ok"]
    repo: str
    notification_id: str
    bookmarked: bool


class NotificationRepliesMutedRequest(BaseModel):
    """Request body for local Replies suppression state."""

    replies_muted: bool


class NotificationRepliesMutedResponse(BaseModel):
    """Response from a local Replies suppression update."""

    status: Literal["ok"]
    repo: str
    notification_id: str
    replies_muted: bool


class NotificationReadCommentWatermarkRequest(BaseModel):
    """Request body for local read-comment watermark state."""

    read_comment_watermark_at: str | None = None


class NotificationReadCommentWatermarkResponse(BaseModel):
    """Response from a local read-comment watermark update."""

    status: Literal["ok"]
    repo: str
    notification_id: str
    read_comment_watermark_at: str | None


def mark_github_session_expired() -> None:
    """Force the web login flow after GitHub browser-session expiry."""
    os.environ["GHINBOX_NEEDS_AUTH"] = "1"


def _chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def _apply_bookmarks(
    response: NotificationsResponse, repo_key: str
) -> NotificationsResponse:
    payload = response.model_dump(mode="json")
    payload["notifications"] = apply_local_state(repo_key, payload["notifications"])
    return NotificationsResponse.model_validate(payload)


def _query_repo_name(query: str) -> str:
    compact = re.sub(r"\s+", "-", query.strip().lower())
    compact = re.sub(r"[^a-z0-9_.:-]+", "-", compact).strip("-")
    return compact[:80] or "all"


@router.get(
    "/query",
    response_model=NotificationsResponse,
    summary="Get notifications from a GitHub notifications query",
    description="""
    Parse GitHub notifications HTML for an arbitrary notifications query.

    This endpoint reflects:
    https://github.com/notifications?query={query}
    """,
)
async def get_query_notifications(
    query: Annotated[
        str,
        Query(description="GitHub notifications query text"),
    ],
    before: Annotated[
        str | None,
        Query(description="Opaque cursor from GitHub 'Prev' link (verbatim)"),
    ] = None,
    after: Annotated[
        str | None,
        Query(description="Opaque cursor from GitHub 'Next' link (verbatim)"),
    ] = None,
) -> NotificationsResponse:
    """
    Get notifications for a saved profile query from HTML.
    """
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    source_url = f"https://github.com/notifications?query={query}"
    if before:
        source_url += f"&before={before}"
    if after:
        source_url += f"&after={after}"

    fetcher = get_fetcher()
    if fetcher is None:
        return NotificationsResponse(
            source_url=source_url,
            generated_at=datetime.now(),
            repository={
                "owner": "query",
                "name": _query_repo_name(query),
                "full_name": f"query/{_query_repo_name(query)}",
            },
            notifications=[],
            pagination={
                "before_cursor": None,
                "after_cursor": None,
                "has_previous": False,
                "has_next": False,
            },
        )

    result = await run_fetcher_call(
        fetcher.fetch_notifications_query,
        query=query,
        before=before,
        after=after,
    )
    if result.status == "session_expired":
        mark_github_session_expired()
        raise HTTPException(
            status_code=401,
            detail={
                "error": "session_expired",
                "message": result.error
                or "GitHub session has expired. Please re-authenticate.",
            },
        )
    if result.status == "error":
        print(f"[notifications] Fetch error for query {query!r}: {result.error}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch from GitHub: {result.error}",
        )

    try:
        parsed = parse_notifications_html(
            html=result.html,
            owner="query",
            repo=_query_repo_name(query),
            source_url=result.url,
        )
        return _apply_bookmarks(parsed, f"query:{query}")
    except SessionExpiredError as e:
        mark_github_session_expired()
        raise HTTPException(
            status_code=401,
            detail={
                "error": "session_expired",
                "message": str(e),
            },
        )


@router.get(
    "/repo/{owner}/{repo}",
    response_model=NotificationsResponse,
    summary="Get notifications from HTML",
    description="""
    Parse GitHub notifications HTML and return structured data.

    This endpoint reflects the page:
    https://github.com/notifications?query=repo:{owner}/{repo}

    Pagination uses opaque cursors from GitHub's "Prev" and "Next" links.
    """,
)
async def get_repo_notifications(
    owner: str,
    repo: str,
    before: Annotated[
        str | None,
        Query(description="Opaque cursor from GitHub 'Prev' link (verbatim)"),
    ] = None,
    after: Annotated[
        str | None,
        Query(description="Opaque cursor from GitHub 'Next' link (verbatim)"),
    ] = None,
    fixture: Annotated[
        str | None,
        Query(
            description="Path to HTML fixture file (for testing). "
            "If not provided, returns empty response."
        ),
    ] = None,
) -> NotificationsResponse:
    """
    Get notifications for a repository from HTML.

    If a fixture path is provided, reads from that file.
    If the server was started with --account, fetches live from GitHub.
    Otherwise returns an empty response.
    """
    html: str | None = None
    source_url = f"https://github.com/notifications?query=repo:{owner}/{repo}"

    # Add pagination params to source URL if provided
    if before:
        source_url += f"&before={before}"
    if after:
        source_url += f"&after={after}"

    # Option 1: Read from fixture file
    if fixture:
        fixture_path = Path(fixture)
        if not fixture_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Fixture file not found: {fixture}",
            )
        html = fixture_path.read_text()

    # Option 2: Fetch live from GitHub (run in thread pool to avoid blocking)
    elif get_fetcher() is not None:
        fetcher = get_fetcher()
        assert fetcher is not None
        result = await run_fetcher_call(
            fetcher.fetch_repo_notifications,
            owner=owner,
            repo=repo,
            before=before,
            after=after,
        )
        if result.status == "session_expired":
            mark_github_session_expired()
            raise HTTPException(
                status_code=401,
                detail={
                    "error": "session_expired",
                    "message": result.error
                    or "GitHub session has expired. Please re-authenticate.",
                },
            )
        if result.status == "error":
            print(f"[notifications] Fetch error for {owner}/{repo}: {result.error}")
            raise HTTPException(
                status_code=502,
                detail=f"Failed to fetch from GitHub: {result.error}",
            )
        html = result.html
        source_url = result.url

    # Option 3: No fetcher, return empty response
    if html is None:
        return NotificationsResponse(
            source_url=source_url,
            generated_at=datetime.now(),
            repository={
                "owner": owner,
                "name": repo,
                "full_name": f"{owner}/{repo}",
            },
            notifications=[],
            pagination={
                "before_cursor": None,
                "after_cursor": None,
                "has_previous": False,
                "has_next": False,
            },
        )

    try:
        parsed = parse_notifications_html(
            html=html,
            owner=owner,
            repo=repo,
            source_url=source_url,
        )
        return _apply_bookmarks(parsed, f"{owner}/{repo}")
    except SessionExpiredError as e:
        mark_github_session_expired()
        raise HTTPException(
            status_code=401,
            detail={
                "error": "session_expired",
                "message": str(e),
            },
        )


@router.get(
    "/repo/{owner}/{repo}/timing",
    summary="Profile request timing",
    description="Fetch notifications and return detailed timing breakdown.",
)
async def timing_profile(
    owner: str,
    repo: str,
) -> dict:
    """Return timing breakdown for a fetch + parse cycle."""
    fetcher = get_fetcher()
    if fetcher is None:
        return {"error": "No fetcher configured"}

    timing: dict[str, object] = {}

    # Measure fetch (in thread pool)
    t0 = time.perf_counter()
    result = await run_fetcher_call(
        fetcher.fetch_repo_notifications,
        owner=owner,
        repo=repo,
    )
    timing["fetch_total_ms"] = int((time.perf_counter() - t0) * 1000)
    timing["fetch_breakdown"] = result.timing

    # Measure parsing
    t0 = time.perf_counter()
    parsed = parse_notifications_html(
        html=result.html,
        owner=owner,
        repo=repo,
        source_url=result.url,
    )
    timing["parse_ms"] = int((time.perf_counter() - t0) * 1000)

    timing["total_ms"] = timing["fetch_total_ms"] + timing["parse_ms"]
    timing["notification_count"] = len(parsed.notifications)
    timing["html_length"] = len(result.html)

    return timing


@router.get(
    "/parse",
    response_model=NotificationsResponse,
    summary="Parse HTML from fixture file",
    description="Parse an HTML fixture file directly and return structured data.",
)
async def parse_fixture(
    fixture: Annotated[str, Query(description="Path to HTML fixture file")],
    owner: Annotated[
        str, Query(description="Repository owner (for response metadata)")
    ] = "unknown",
    repo: Annotated[
        str, Query(description="Repository name (for response metadata)")
    ] = "unknown",
) -> NotificationsResponse:
    """
    Parse an HTML fixture file and return notifications data.

    This is useful for testing the parser with arbitrary HTML files.
    """
    fixture_path = Path(fixture)
    if not fixture_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Fixture file not found: {fixture}",
        )

    html = fixture_path.read_text()
    return parse_notifications_html(
        html=html,
        owner=owner,
        repo=repo,
    )


@router.post(
    "/action",
    response_model=NotificationActionResponse,
    summary="Submit a notification action",
    description="""
    Submit a notification action (archive, unarchive, subscribe, unsubscribe) to GitHub.

    This uses Playwright to submit an HTML form to GitHub's notification
    endpoints, which requires a valid authenticity_token from the page.

    Actions:
    - archive: Mark a notification as done ("Mark as Done")
    - unarchive: Move a notification back to inbox (undo "Mark as Done")
    - subscribe: Re-subscribe to a thread (undo "Unsubscribe")
    - unsubscribe: Unsubscribe from a thread
    """,
)
async def submit_action(
    request: NotificationActionRequest,
    http_request: Request,
) -> NotificationActionResponse:
    """
    Submit a notification action to GitHub.

    Requires an active fetcher (server started with --account).
    """
    started = time.perf_counter()
    status = "error"
    error: str | None = None
    github_status_code: int | None = None

    try:
        fetcher = get_fetcher()
        if fetcher is None:
            error = (
                "No fetcher configured. Start server with --account to enable actions."
            )
            raise HTTPException(
                status_code=503,
                detail=error,
            )

        notification_id_chunks = _chunks(
            request.notification_ids,
            MAX_GITHUB_NOTIFICATION_ACTION_IDS,
        ) or [[]]
        for notification_id_chunk in notification_id_chunks:
            result = await run_fetcher_call(
                fetcher.submit_notification_action,
                action=request.action,
                notification_ids=notification_id_chunk,
                authenticity_token=request.authenticity_token,
            )
            status = result.status
            error = result.error
            github_status_code = result.github_status_code
            if result.status != "ok":
                break

        return NotificationActionResponse(
            status=status,
            error=error,
        )
    finally:
        emit_notification_action_audit(
            request_id=http_request.scope.get("ghinbox_request_id"),
            action=request.action,
            notification_ids=request.notification_ids,
            token_present=bool(request.authenticity_token),
            status=status,
            error=error,
            github_status_code=github_status_code,
            duration_ms=(time.perf_counter() - started) * 1000,
        )


@router.get(
    "/repo/{owner}/{repo}/bookmarks/{notification_id}",
    response_model=NotificationBookmarkResponse,
    summary="Get local bookmark state",
)
async def get_bookmark(
    owner: str,
    repo: str,
    notification_id: str,
) -> NotificationBookmarkResponse:
    repo_key = f"{owner}/{repo}"
    return NotificationBookmarkResponse(
        status="ok",
        repo=repo_key,
        notification_id=notification_id,
        bookmarked=get_notification_bookmark(repo_key, notification_id),
    )


@router.put(
    "/repo/{owner}/{repo}/bookmarks/{notification_id}",
    response_model=NotificationBookmarkResponse,
    summary="Set local bookmark state",
)
async def set_bookmark(
    owner: str,
    repo: str,
    notification_id: str,
    request: NotificationBookmarkRequest,
) -> NotificationBookmarkResponse:
    repo_key = f"{owner}/{repo}"
    result = set_notification_bookmark(
        repo_key,
        notification_id,
        request.bookmarked,
    )
    return NotificationBookmarkResponse(
        status="ok",
        repo=repo_key,
        notification_id=result["notification_id"],
        bookmarked=result["bookmarked"],
    )


@router.get(
    "/repo/{owner}/{repo}/replies-muted/{notification_id}",
    response_model=NotificationRepliesMutedResponse,
    summary="Get local Replies suppression state",
)
async def get_replies_muted(
    owner: str,
    repo: str,
    notification_id: str,
) -> NotificationRepliesMutedResponse:
    repo_key = f"{owner}/{repo}"
    return NotificationRepliesMutedResponse(
        status="ok",
        repo=repo_key,
        notification_id=notification_id,
        replies_muted=get_notification_replies_muted(repo_key, notification_id),
    )


@router.put(
    "/repo/{owner}/{repo}/replies-muted/{notification_id}",
    response_model=NotificationRepliesMutedResponse,
    summary="Set local Replies suppression state",
)
async def set_replies_muted(
    owner: str,
    repo: str,
    notification_id: str,
    request: NotificationRepliesMutedRequest,
) -> NotificationRepliesMutedResponse:
    repo_key = f"{owner}/{repo}"
    result = set_notification_replies_muted(
        repo_key,
        notification_id,
        request.replies_muted,
    )
    return NotificationRepliesMutedResponse(
        status="ok",
        repo=repo_key,
        notification_id=result["notification_id"],
        replies_muted=result["replies_muted"],
    )


@router.get(
    "/repo/{owner}/{repo}/read-comment-watermarks/{notification_id}",
    response_model=NotificationReadCommentWatermarkResponse,
    summary="Get local read-comment watermark",
)
async def get_read_comment_watermark(
    owner: str,
    repo: str,
    notification_id: str,
) -> NotificationReadCommentWatermarkResponse:
    repo_key = f"{owner}/{repo}"
    return NotificationReadCommentWatermarkResponse(
        status="ok",
        repo=repo_key,
        notification_id=notification_id,
        read_comment_watermark_at=get_notification_read_comment_watermark(
            repo_key,
            notification_id,
        ),
    )


@router.put(
    "/repo/{owner}/{repo}/read-comment-watermarks/{notification_id}",
    response_model=NotificationReadCommentWatermarkResponse,
    summary="Set local read-comment watermark",
)
async def set_read_comment_watermark(
    owner: str,
    repo: str,
    notification_id: str,
    request: NotificationReadCommentWatermarkRequest,
) -> NotificationReadCommentWatermarkResponse:
    repo_key = f"{owner}/{repo}"
    result = set_notification_read_comment_watermark(
        repo_key,
        notification_id,
        request.read_comment_watermark_at,
    )
    return NotificationReadCommentWatermarkResponse(
        status="ok",
        repo=repo_key,
        notification_id=result["notification_id"],
        read_comment_watermark_at=result["read_comment_watermark_at"],
    )
