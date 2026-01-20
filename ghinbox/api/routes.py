"""
FastAPI route handlers for the HTML notifications API.
"""

import time
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ghinbox.api.fetcher import get_fetcher, run_fetcher_call
from ghinbox.api.models import NotificationsResponse
from ghinbox.parser.notifications import parse_notifications_html

router = APIRouter(prefix="/notifications/html", tags=["notifications"])


class NotificationActionRequest(BaseModel):
    """Request body for notification actions."""

    action: Literal["archive", "unarchive", "subscribe", "unsubscribe"]
    notification_ids: list[str]
    authenticity_token: str


class NotificationActionResponse(BaseModel):
    """Response from a notification action."""

    status: Literal["ok", "error"]
    error: str | None = None


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

    return parse_notifications_html(
        html=html,
        owner=owner,
        repo=repo,
        source_url=source_url,
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
) -> NotificationActionResponse:
    """
    Submit a notification action to GitHub.

    Requires an active fetcher (server started with --account).
    """
    fetcher = get_fetcher()
    if fetcher is None:
        raise HTTPException(
            status_code=503,
            detail="No fetcher configured. Start server with --account to enable actions.",
        )

    result = await run_fetcher_call(
        fetcher.submit_notification_action,
        action=request.action,
        notification_ids=request.notification_ids,
        authenticity_token=request.authenticity_token,
    )

    return NotificationActionResponse(
        status=result.status,
        error=result.error,
    )
