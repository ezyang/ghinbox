"""
FastAPI route handlers for the HTML notifications API.
"""

import base64
import binascii
import time
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, HTTPException, Query
from fastapi import Request
from pydantic import BaseModel

from ghinbox.api.fetcher import ActionResult, get_fetcher, run_fetcher_call
from ghinbox.api.github_proxy import GITHUB_API_BASE, get_client, get_token
from ghinbox.api.models import NotificationsResponse
from ghinbox.api.observability import (
    emit_github_api_call_audit,
    emit_notification_action_audit,
)
from ghinbox.api.snapshot_store import (
    apply_local_state,
    get_snapshot,
    list_snapshot_repos,
    set_notification_bookmark,
    set_notification_read_comment_watermark,
    set_notification_replies_muted,
)
from ghinbox.parser.notifications import SessionExpiredError, parse_notifications_html

router = APIRouter(prefix="/notifications/html", tags=["notifications"])
MAX_GITHUB_NOTIFICATION_ACTION_IDS = 25
MAX_REST_THREAD_LOOKUP_PAGES = 10
SubjectKey = tuple[str, str, str, int]


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


class NotificationRepliesMutedRequest(BaseModel):
    """Request body for local Replies suppression state."""

    replies_muted: bool


class NotificationReadCommentWatermarkRequest(BaseModel):
    """Request body for local read-comment watermark state."""

    read_comment_watermark_at: str | None = None


def mark_github_session_expired() -> None:
    """Force the web login flow after GitHub browser-session expiry."""
    os.environ["GHINBOX_NEEDS_AUTH"] = "1"


def _chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def _rest_thread_id_from_notification_id(notification_id: str) -> str | None:
    """Decode legacy GitHub HTML notification node IDs to REST thread IDs."""
    if notification_id.isdecimal():
        return notification_id
    if not notification_id.startswith("NT_"):
        return None

    encoded = notification_id[3:]
    padded = encoded + "=" * (-len(encoded) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (binascii.Error, UnicodeError, ValueError):
        return None

    match = re.search(rb"(\d+):\d+$", decoded)
    if match is None:
        return None
    return match.group(1).decode("ascii")


def _github_api_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _github_audit_url(url: str, params: dict[str, str]) -> str:
    if not params:
        return url
    return f"{url}?{urlencode(params)}"


def _subject_key_from_url(url: str) -> SubjectKey | None:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if parsed.netloc == "api.github.com":
        if len(parts) < 5 or parts[0] != "repos":
            return None
        owner, repo, kind, number = parts[1], parts[2], parts[3], parts[4]
    else:
        if len(parts) < 4:
            return None
        owner, repo, kind, number = parts[0], parts[1], parts[2], parts[3]

    canonical_kind = {
        "issue": "issues",
        "issues": "issues",
        "pull": "pulls",
        "pulls": "pulls",
        "discussion": "discussions",
        "discussions": "discussions",
    }.get(kind)
    if canonical_kind is None or not number.isdecimal():
        return None
    return owner, repo, canonical_kind, int(number)


def _next_link_url(link_header: str | None) -> str | None:
    if not link_header:
        return None
    for part in link_header.split(","):
        section = part.strip()
        if 'rel="next"' not in section or not section.startswith("<"):
            continue
        end_index = section.find(">")
        if end_index > 1:
            return section[1:end_index]
    return None


def _snapshot_subject_keys_by_notification_id(
    notification_ids: list[str],
) -> dict[str, SubjectKey]:
    remaining = set(notification_ids)
    subject_keys: dict[str, SubjectKey] = {}
    if not remaining:
        return subject_keys

    for repo in list_snapshot_repos():
        snapshot = get_snapshot(repo)
        if snapshot is None:
            continue
        for notification in snapshot.get("notifications") or []:
            if not isinstance(notification, dict):
                continue
            notification_id = str(notification.get("id") or "")
            if notification_id not in remaining:
                continue
            subject = notification.get("subject")
            if not isinstance(subject, dict):
                continue
            subject_url = str(subject.get("url") or "")
            subject_key = _subject_key_from_url(subject_url)
            if subject_key is None:
                continue
            subject_keys[notification_id] = subject_key
            remaining.remove(notification_id)
            if not remaining:
                return subject_keys

    return subject_keys


async def _rest_thread_ids_by_subject_key(
    token: str,
    subject_keys: set[SubjectKey],
    *,
    request_id: str | None = None,
) -> dict[SubjectKey, str] | None:
    if not subject_keys:
        return {}

    keys_by_repo: dict[tuple[str, str], set[SubjectKey]] = {}
    for key in subject_keys:
        owner, repo, _kind, _number = key
        keys_by_repo.setdefault((owner, repo), set()).add(key)

    client = get_client()
    headers = _github_api_headers(token)
    thread_ids: dict[SubjectKey, str] = {}

    for (owner, repo), repo_keys in keys_by_repo.items():
        url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/notifications"
        params = {"all": "true", "per_page": "100"}
        pages_fetched = 0

        while True:
            if pages_fetched >= MAX_REST_THREAD_LOOKUP_PAGES:
                return None
            audit_url = _github_audit_url(url, params)
            started = time.perf_counter()
            try:
                response = await client.get(
                    url,
                    headers=headers,
                    params=params,
                )
            except Exception as error:
                emit_github_api_call_audit(
                    request_id=request_id,
                    source="archive.thread_lookup",
                    method="GET",
                    url=audit_url,
                    status_code=None,
                    duration_ms=(time.perf_counter() - started) * 1000,
                    error=error.__class__.__name__,
                )
                raise
            emit_github_api_call_audit(
                request_id=request_id,
                source="archive.thread_lookup",
                method="GET",
                url=audit_url,
                status_code=response.status_code,
                duration_ms=(time.perf_counter() - started) * 1000,
                response_headers=getattr(response, "headers", None),
            )
            pages_fetched += 1
            if response.status_code >= 400:
                return None

            payload = response.json()
            if not isinstance(payload, list):
                return None

            for item in payload:
                if not isinstance(item, dict):
                    continue
                subject = item.get("subject")
                if not isinstance(subject, dict):
                    continue
                subject_url = subject.get("url")
                thread_id = item.get("id")
                if not isinstance(subject_url, str) or thread_id is None:
                    continue
                subject_key = _subject_key_from_url(subject_url)
                if subject_key is not None and subject_key in repo_keys:
                    thread_ids[subject_key] = str(thread_id)

            if repo_keys.issubset(thread_ids.keys()):
                break

            next_url = _next_link_url(response.headers.get("link"))
            if next_url is None:
                break
            url = next_url
            params = {}

    return thread_ids


async def _rest_thread_ids_from_notification_ids(
    token: str,
    notification_ids: list[str],
    *,
    request_id: str | None = None,
) -> list[str] | None:
    thread_ids_by_notification_id: dict[str, str] = {}
    unresolved: list[str] = []

    for notification_id in notification_ids:
        thread_id = _rest_thread_id_from_notification_id(notification_id)
        if thread_id is None:
            unresolved.append(notification_id)
        else:
            thread_ids_by_notification_id[notification_id] = thread_id

    if unresolved:
        subject_keys_by_notification_id = _snapshot_subject_keys_by_notification_id(
            unresolved,
        )
        if set(unresolved) - subject_keys_by_notification_id.keys():
            return None

        thread_ids_by_subject_key = await _rest_thread_ids_by_subject_key(
            token,
            set(subject_keys_by_notification_id.values()),
            request_id=request_id,
        )
        if thread_ids_by_subject_key is None:
            return None

        for notification_id, subject_key in subject_keys_by_notification_id.items():
            thread_id = thread_ids_by_subject_key.get(subject_key)
            if thread_id is None:
                return None
            thread_ids_by_notification_id[notification_id] = thread_id

    return [
        thread_ids_by_notification_id[notification_id]
        for notification_id in notification_ids
    ]


async def _submit_archive_with_github_api(
    notification_ids: list[str],
    *,
    request_id: str | None = None,
) -> ActionResult | None:
    """Mark notifications done through the REST API when IDs and token permit it."""
    token = get_token()
    if not token:
        return None

    if not notification_ids:
        return ActionResult(
            status="error",
            error="No notification IDs provided for action",
        )

    thread_ids = await _rest_thread_ids_from_notification_ids(
        token,
        notification_ids,
        request_id=request_id,
    )
    if thread_ids is None:
        return None

    client = get_client()
    last_status_code: int | None = None
    headers = _github_api_headers(token)
    for thread_id in thread_ids:
        url = f"{GITHUB_API_BASE}/notifications/threads/{thread_id}"
        started = time.perf_counter()
        try:
            response = await client.request(
                "DELETE",
                url,
                headers=headers,
            )
        except Exception as error:
            emit_github_api_call_audit(
                request_id=request_id,
                source="archive.thread_delete",
                method="DELETE",
                url=url,
                status_code=None,
                duration_ms=(time.perf_counter() - started) * 1000,
                error=error.__class__.__name__,
            )
            raise
        emit_github_api_call_audit(
            request_id=request_id,
            source="archive.thread_delete",
            method="DELETE",
            url=url,
            status_code=response.status_code,
            duration_ms=(time.perf_counter() - started) * 1000,
            response_headers=getattr(response, "headers", None),
        )
        last_status_code = response.status_code
        if response.status_code >= 400:
            return ActionResult(
                status="error",
                error=f"HTTP {response.status_code}",
                response_html=response.text,
                github_status_code=response.status_code,
            )

    return ActionResult(status="ok", github_status_code=last_status_code)


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


def _repo_key(owner: str, repo: str) -> str:
    return f"{owner}/{repo}"


def _local_state_response(
    owner: str,
    repo: str,
    notification_id: str,
    field: str,
    value: bool | str | None,
    *,
    setter,
) -> dict:
    repo_key = _repo_key(owner, repo)
    result = setter(repo_key, notification_id, value)
    notification_id = result["notification_id"]
    value = result[field]
    return {
        "status": "ok",
        "repo": repo_key,
        "notification_id": notification_id,
        field: value,
    }


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
            if result.status != "ok":
                break

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
