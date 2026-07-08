"""
FastAPI route handlers for the HTML notifications API.
"""

import os
import re
import time
from pathlib import Path
from typing import Annotated, Any, Callable, Literal, NoReturn

from fastapi import APIRouter, HTTPException, Query
from fastapi import Request
from pydantic import BaseModel

from ghinbox.api.archive_api import (
    MAX_GITHUB_NOTIFICATION_ACTION_IDS,
    _chunks,
    _prune_snapshot_for_action,
    _submit_archive_with_github_api,
)
from ghinbox.api.fetcher import FetchResult, get_fetcher, run_fetcher_call
from ghinbox.api.models import NotificationsResponse
from ghinbox.api.observability import emit_notification_action_audit
from ghinbox.api.repo_keys import repo_key
from ghinbox.api.snapshot_store import apply_local_state
from ghinbox.parser.notifications import SessionExpiredError, parse_notifications_html

router = APIRouter(prefix="/notifications/html", tags=["notifications"])
SESSION_EXPIRED_MESSAGE = "GitHub session has expired. Please re-authenticate."
FETCHER_MISSING_MESSAGE = (
    "No GitHub fetcher configured. Start server with --account to fetch notifications."
)
FETCHER_AUTH_REFRESH_MESSAGE = (
    "Stored browser session is expired. Log in again to refresh notifications."
)


class NotificationActionRequest(BaseModel):
    """Request body for notification actions."""

    action: Literal["archive", "unarchive", "subscribe", "unsubscribe"]
    notification_ids: list[str]
    authenticity_token: str


class NotificationActionResponse(BaseModel):
    """Response from a notification action."""

    status: Literal["ok", "error"]
    error: str | None = None


def mark_github_session_expired() -> None:
    """Force the web login flow after GitHub browser-session expiry."""
    os.environ["GHINBOX_NEEDS_AUTH"] = "1"


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


def _raise_session_expired(message: str) -> NoReturn:
    mark_github_session_expired()
    raise HTTPException(
        status_code=401,
        detail={
            "error": "session_expired",
            "message": message,
        },
    )


def _raise_missing_fetcher_for_notifications() -> NoReturn:
    if os.environ.get("GHINBOX_NEEDS_AUTH") == "1":
        _raise_session_expired(FETCHER_AUTH_REFRESH_MESSAGE)
    raise HTTPException(
        status_code=503,
        detail=FETCHER_MISSING_MESSAGE,
    )


async def _fetch_live_notifications(
    fetcher_call: Callable[..., FetchResult],
    error_context: str,
    **kwargs: Any,
) -> FetchResult:
    result = await run_fetcher_call(fetcher_call, **kwargs)
    if result.status == "session_expired":
        _raise_session_expired(result.error or SESSION_EXPIRED_MESSAGE)
    if result.status == "error":
        print(f"[notifications] Fetch error for {error_context}: {result.error}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch from GitHub: {result.error}",
        )
    return result


def _parse_notifications_response(
    *,
    html: str,
    owner: str,
    repo: str,
    source_url: str,
    local_state_key: str,
) -> NotificationsResponse:
    try:
        parsed = parse_notifications_html(
            html=html,
            owner=owner,
            repo=repo,
            source_url=source_url,
        )
        return _apply_bookmarks(parsed, local_state_key)
    except SessionExpiredError as e:
        _raise_session_expired(str(e))


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

    query_repo_name = _query_repo_name(query)
    fetcher = get_fetcher()
    if fetcher is None:
        _raise_missing_fetcher_for_notifications()
    assert fetcher is not None

    result = await _fetch_live_notifications(
        fetcher.fetch_notifications_query,
        f"query {query!r}",
        query=query,
        before=before,
        after=after,
    )
    return _parse_notifications_response(
        html=result.html,
        owner="query",
        repo=query_repo_name,
        source_url=result.url,
        local_state_key=f"query:{query}",
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
        Query(description="Path to HTML fixture file. Only available in test mode."),
    ] = None,
) -> NotificationsResponse:
    """
    Get notifications for a repository from HTML.

    If a fixture path is provided in test mode, reads from that file.
    If the server was started with --account, fetches live from GitHub.
    Otherwise reports why live fetching is unavailable.
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
        if os.environ.get("GHINBOX_TEST_MODE") != "1":
            raise HTTPException(
                status_code=403,
                detail="fixture query parameter is only available in test mode",
            )
        fixture_path = Path(fixture)
        if not fixture_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Fixture file not found: {fixture}",
            )
        html = fixture_path.read_text()

    # Option 2: Fetch live from GitHub (run in thread pool to avoid blocking)
    else:
        fetcher = get_fetcher()
        if fetcher is None:
            _raise_missing_fetcher_for_notifications()
        assert fetcher is not None
        result = await _fetch_live_notifications(
            fetcher.fetch_repo_notifications,
            f"{owner}/{repo}",
            owner=owner,
            repo=repo,
            before=before,
            after=after,
        )
        html = result.html
        source_url = result.url

    assert html is not None
    return _parse_notifications_response(
        html=html,
        owner=owner,
        repo=repo,
        source_url=source_url,
        local_state_key=repo_key(owner, repo),
    )


@router.post(
    "/action",
    response_model=NotificationActionResponse,
    summary="Submit a notification action",
    description="""
    Submit a notification action (archive, unarchive, subscribe, unsubscribe) to GitHub.

    Archive uses the GitHub REST notifications API when a token-backed thread
    ID is available. Other actions fall back to Playwright form submission,
    which requires a valid authenticity_token from the page.

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

    Requires either a token-backed archive request or an active fetcher
    (server started with --account).
    """
    started = time.perf_counter()
    status = "error"
    error: str | None = None
    github_status_code: int | None = None
    request_id_value = http_request.scope.get("ghinbox_request_id")
    request_id = request_id_value if isinstance(request_id_value, str) else None

    try:
        if request.action == "archive":
            api_result = await _submit_archive_with_github_api(
                request.notification_ids,
                request_id=request_id,
            )
            if api_result is not None:
                status = api_result.status
                error = api_result.error
                github_status_code = api_result.github_status_code
                if status == "ok":
                    _prune_snapshot_for_action(request.action, request.notification_ids)
                return NotificationActionResponse(
                    status=status,
                    error=error,
                )

        fetcher = get_fetcher()
        if fetcher is None:
            if os.environ.get("GHINBOX_NEEDS_AUTH") == "1":
                error = (
                    "Stored browser session is expired. Log in again to enable "
                    "notification actions."
                )
                raise HTTPException(
                    status_code=401,
                    detail={
                        "error": "session_expired",
                        "message": error,
                    },
                )
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
            if result.status == "session_expired":
                _raise_session_expired(error or SESSION_EXPIRED_MESSAGE)
            if result.status != "ok":
                break

        if status == "ok":
            _prune_snapshot_for_action(request.action, request.notification_ids)

        return NotificationActionResponse(
            status=status,
            error=error,
        )
    finally:
        emit_notification_action_audit(
            request_id=request_id,
            action=request.action,
            notification_ids=request.notification_ids,
            token_present=bool(request.authenticity_token),
            status=status,
            error=error,
            github_status_code=github_status_code,
            duration_ms=(time.perf_counter() - started) * 1000,
        )
