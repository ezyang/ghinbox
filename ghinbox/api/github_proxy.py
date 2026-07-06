"""
GitHub API proxy routes.

Proxies requests to GitHub's REST and GraphQL APIs using the stored token.
"""

import asyncio
import os
import time
from collections.abc import Iterable, Mapping
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from ghinbox.github_headers import github_graphql_headers, github_rest_headers
from ghinbox.api.notification_shapes import (
    REVIEW_REQUEST_SEARCH_PER_PAGE,
    build_review_request_search_query,
    notification_to_bulk_comment_item,
    search_item_to_review_request_notification,
)
from ghinbox.api.observability import emit_github_api_call_audit
from ghinbox.api.rate_governor import (
    CallClass,
    RateGovernorDeniedError,
    get_rate_governor,
)
from ghinbox.token import load_token

router = APIRouter(prefix="/github", tags=["github-proxy"])

GITHUB_API_BASE = "https://api.github.com"
COMMENT_BULK_CONCURRENCY = 8

# Shared httpx client (created lazily)
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """Get or create the shared httpx client."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=30.0)
    return _client


def get_token() -> str | None:
    """Get the GitHub token for the configured account."""
    account = os.environ.get("GHINBOX_ACCOUNT")
    if not account:
        return None
    return load_token(account)


def _github_url(path_or_url: str, params: dict[str, str] | None = None) -> str:
    if path_or_url.startswith("https://"):
        url = path_or_url
    else:
        url = f"{GITHUB_API_BASE}/{path_or_url}"
    if params:
        url += f"?{urlencode(params)}"
    return url


def _expected_rest_rate_pool(path_or_url: str) -> str:
    parsed = urlparse(path_or_url)
    path = parsed.path if parsed.scheme else path_or_url.partition("?")[0]
    normalized_path = path.lstrip("/")
    if normalized_path.startswith("search/"):
        return "search"
    return "core"


def check_github_rate_governor(
    *,
    request_id: str | None,
    source: str,
    method: str,
    url: str,
    call_class: CallClass,
    pool: str,
) -> None:
    decision = get_rate_governor().check(
        pool=pool,
        call_class=call_class,
        request_id=request_id,
        source=source,
        method=method,
        url=url,
    )
    if decision.allowed:
        return

    detail = decision.to_detail()
    emit_github_api_call_audit(
        request_id=request_id,
        source=source,
        method=method,
        url=url,
        status_code=429,
        duration_ms=0,
        error="rate_governor_denied",
        governor_denial=detail,
    )
    raise RateGovernorDeniedError(decision)


def update_github_rate_governor_from_headers(
    headers: Mapping[str, str] | None,
) -> None:
    get_rate_governor().update_from_headers(headers)


async def _github_get_json_with_headers(
    client: httpx.AsyncClient,
    token: str,
    path_or_url: str,
    params: dict[str, str] | None = None,
    *,
    source: str = "github_proxy",
    request_id: str | None = None,
    call_class: CallClass = "background",
) -> tuple[int, object, httpx.Headers]:
    # Build the query string into the URL rather than passing params to
    # httpx: client.get(url, params={}) REPLACES the URL's own query string,
    # which silently strips page/per_page from Link rel="next" URLs and turns
    # pagination into an infinite page-1 loop (burned the full core rate
    # limit on 2026-07-06).
    request_url = _github_url(path_or_url, params)
    audit_url = request_url
    check_github_rate_governor(
        request_id=request_id,
        source=source,
        method="GET",
        url=audit_url,
        call_class=call_class,
        pool=_expected_rest_rate_pool(request_url),
    )
    started = time.perf_counter()
    try:
        response = await client.get(
            request_url,
            headers=github_rest_headers(token),
        )
    except Exception as error:
        emit_github_api_call_audit(
            request_id=request_id,
            source=source,
            method="GET",
            url=audit_url,
            status_code=None,
            duration_ms=(time.perf_counter() - started) * 1000,
            error=error.__class__.__name__,
        )
        raise
    emit_github_api_call_audit(
        request_id=request_id,
        source=source,
        method="GET",
        url=audit_url,
        status_code=response.status_code,
        duration_ms=(time.perf_counter() - started) * 1000,
        response_headers=response.headers,
    )
    update_github_rate_governor_from_headers(response.headers)
    if response.status_code >= 400:
        return response.status_code, response.text, response.headers
    return response.status_code, response.json(), response.headers


async def _github_get_json(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    params: dict[str, str] | None = None,
    *,
    source: str = "github_proxy",
    request_id: str | None = None,
    call_class: CallClass = "background",
) -> tuple[int, object]:
    status, payload, _headers = await _github_get_json_with_headers(
        client,
        token,
        path,
        params,
        source=source,
        request_id=request_id,
        call_class=call_class,
    )
    return status, payload


def _next_link_url(link_header: str | None) -> str | None:
    if not link_header:
        return None
    for part in link_header.split(","):
        section = part.strip()
        if 'rel="next"' not in section:
            continue
        if not section.startswith("<"):
            continue
        end_index = section.find(">")
        if end_index <= 1:
            continue
        return section[1:end_index]
    return None


async def _github_get_paginated_list(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    params: dict[str, str] | None = None,
    *,
    source: str = "github_proxy",
    request_id: str | None = None,
    call_class: CallClass = "background",
) -> tuple[int, object]:
    items: list[object] = []
    path_or_url = path
    page_params = dict(params or {})
    page_params.setdefault("per_page", "100")

    # Hard cap on pages followed: an unbounded Link-header walk once burned
    # the entire core rate limit (see _github_get_json_with_headers comment).
    # 20 pages x 100 items is far beyond any legitimate consumer here.
    for _ in range(20):
        status, payload, headers = await _github_get_json_with_headers(
            client,
            token,
            path_or_url,
            page_params,
            source=source,
            request_id=request_id,
            call_class=call_class,
        )
        if status >= 400:
            return status, payload
        if not isinstance(payload, list):
            return status, payload
        items.extend(payload)
        next_url = _next_link_url(headers.get("link"))
        if not next_url:
            return status, items
        path_or_url = next_url
        page_params = None
    return status, items


class ReviewRequestSearchError(RuntimeError):
    """Raised when the GitHub search for review requests fails."""

    def __init__(self, status_code: int, detail: object):
        super().__init__(f"Review request search failed ({status_code}): {detail}")
        self.status_code = status_code


async def fetch_review_request_notifications(
    owner: str | None,
    repo: str | None,
    query: str | None = None,
    request_id: str | None = None,
) -> list[dict]:
    """Search GitHub for active review requests and normalize to notifications."""
    token = get_token()
    if not token:
        return []

    search_query = build_review_request_search_query(owner, repo, query)
    status, payload = await _github_get_json(
        get_client(),
        token,
        "search/issues",
        {"q": search_query, "per_page": str(REVIEW_REQUEST_SEARCH_PER_PAGE)},
        source="review_requests.search",
        request_id=request_id,
        call_class="background",
    )
    if status >= 400:
        raise ReviewRequestSearchError(status, payload)
    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        items = []
    return [
        notification
        for item in items
        if isinstance(item, dict)
        and (
            notification := search_item_to_review_request_notification(
                owner,
                repo,
                item,
            )
        )
        is not None
    ]


class BulkCommentFetchResults(list[tuple[str, dict]]):
    """List of fetched bulk comment results plus stop reason metadata."""

    def __init__(
        self,
        values: Iterable[tuple[str, dict[str, Any]]] = (),
        *,
        rate_limited: bool = False,
        denial: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(values)
        self.rate_limited = rate_limited
        self.denial = denial


async def fetch_bulk_comment_results(
    token: str,
    items: list[dict],
    on_progress=None,
    request_id: str | None = None,
) -> BulkCommentFetchResults:
    """Fetch comment threads for multiple notifications with bounded concurrency."""
    client = get_client()
    next_index = 0
    stopped = False
    denial_detail: dict[str, Any] | None = None
    results_by_index: dict[int, tuple[str, dict]] = {}
    lock = asyncio.Lock()

    async def claim_item() -> tuple[int, dict] | None:
        nonlocal next_index
        async with lock:
            if stopped or next_index >= len(items):
                return None
            index = next_index
            next_index += 1
            return index, items[index]

    async def stop_for_denial(detail: dict[str, Any]) -> None:
        nonlocal stopped, denial_detail
        async with lock:
            stopped = True
            if denial_detail is None:
                denial_detail = detail

    async def run_worker() -> None:
        while claimed := await claim_item():
            index, item = claimed
            try:
                result = await _fetch_bulk_comment_item(
                    client,
                    token,
                    item,
                    request_id=request_id,
                )
            except RateGovernorDeniedError as error:
                detail = error.detail
                await stop_for_denial(detail)
                result = (
                    str(item.get("key") or ""),
                    {
                        "error": detail.get("message") or str(error),
                        "rate_limited": True,
                        "governor": detail,
                    },
                )
            results_by_index[index] = result
            if on_progress is not None:
                on_progress(result)

    worker_count = min(COMMENT_BULK_CONCURRENCY, len(items))
    if worker_count:
        await asyncio.gather(*(run_worker() for _ in range(worker_count)))

    ordered_results = [
        results_by_index[index] for index in sorted(results_by_index.keys())
    ]
    return BulkCommentFetchResults(
        ordered_results,
        rate_limited=denial_detail is not None,
        denial=denial_detail,
    )


def _issue_to_comment(issue: object) -> dict | None:
    if not isinstance(issue, dict):
        return None
    return {
        "id": issue.get("id") or f"issue-{issue.get('number') or 'unknown'}",
        "user": issue.get("user"),
        "body": issue.get("body") or "",
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
        "isIssue": True,
    }


async def _fetch_bulk_comment_item(
    client: httpx.AsyncClient,
    token: str,
    item: dict,
    *,
    request_id: str | None = None,
) -> tuple[str, dict]:
    key = str(item.get("key") or "")
    owner = str(item.get("owner") or "")
    repo = str(item.get("repo") or "")
    number = item.get("number")
    if not key or not owner or not repo or not isinstance(number, int):
        return key, {"error": "Invalid bulk comment request item."}

    is_pr = bool(item.get("is_pr"))
    anchor = item.get("anchor")
    last_read_at = item.get("last_read_at")
    subject_state = str(item.get("subject_state") or "").lower()
    fetch_state_events = subject_state in {"closed", "merged"}
    use_all_comments = bool(anchor or not last_read_at or fetch_state_events)
    params = {} if use_all_comments else {"since": str(last_read_at)}
    comments: list[object] = []
    state_events: list[object] = []

    if use_all_comments:
        status, issue = await _github_get_json(
            client,
            token,
            f"repos/{owner}/{repo}/issues/{number}",
            source="comments_bulk.issue",
            request_id=request_id,
            call_class="background",
        )
        if status < 400:
            issue_comment = _issue_to_comment(issue)
            if issue_comment is not None:
                comments.append(issue_comment)
            if (
                fetch_state_events
                and isinstance(issue, dict)
                and issue.get("closed_at")
            ):
                state_events.append(
                    {
                        "id": f"issue-{number}-closed-at",
                        "event": "merged" if subject_state == "merged" else "closed",
                        "created_at": issue.get("closed_at"),
                    }
                )

    status, issue_comments = await _github_get_paginated_list(
        client,
        token,
        f"repos/{owner}/{repo}/issues/{number}/comments",
        params,
        source="comments_bulk.issue_comments",
        request_id=request_id,
        call_class="background",
    )
    if status >= 400:
        return key, {
            "error": f"Issue comments fetch failed ({status}): {issue_comments}"
        }
    if isinstance(issue_comments, list):
        comments.extend(issue_comments)

    if is_pr:
        status, review_comments = await _github_get_paginated_list(
            client,
            token,
            f"repos/{owner}/{repo}/pulls/{number}/comments",
            params,
            source="comments_bulk.pr_review_comments",
            request_id=request_id,
            call_class="background",
        )
        if status < 400 and isinstance(review_comments, list):
            for comment in review_comments:
                if isinstance(comment, dict):
                    comment = {**comment, "isReviewComment": True}
                comments.append(comment)

    if fetch_state_events:
        status, issue_events = await _github_get_paginated_list(
            client,
            token,
            f"repos/{owner}/{repo}/issues/{number}/events",
            {},
            source="comments_bulk.issue_events",
            request_id=request_id,
            call_class="background",
        )
        if status < 400 and isinstance(issue_events, list):
            state_events.extend(
                event
                for event in issue_events
                if isinstance(event, dict)
                and str(event.get("event") or "").lower() in {"closed", "merged"}
            )

    comments.sort(
        key=lambda comment: (
            comment.get("created_at") if isinstance(comment, dict) else None
        )
        or ""
    )
    return key, {
        "comments": comments,
        "stateEvents": state_events,
        "allComments": use_all_comments,
    }


@router.post(
    "/rest/comments/bulk",
    summary="Bulk GitHub comment fetch",
    description="Fetches issue and PR comments for multiple notifications.",
)
async def bulk_comments(request: Request) -> dict:
    token = get_token()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="No GitHub token configured. Start server with --account.",
        )
    token_value = token

    payload = await request.json()
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list) and isinstance(payload, dict):
        notifications = payload.get("notifications")
        repository = payload.get("repository")
        fallback_owner = (
            repository.get("owner") if isinstance(repository, dict) else None
        )
        fallback_repo = (
            repository.get("repo") or repository.get("name")
            if isinstance(repository, dict)
            else None
        )
        if isinstance(notifications, list):
            items = [
                item
                for notification in notifications
                if isinstance(notification, dict)
                and (
                    item := notification_to_bulk_comment_item(
                        notification,
                        str(fallback_owner) if fallback_owner else None,
                        str(fallback_repo) if fallback_repo else None,
                    )
                )
                is not None
            ]
    if not isinstance(items, list):
        raise HTTPException(
            status_code=400,
            detail="Expected JSON body with items or notifications list.",
        )

    dict_items = [item for item in items if isinstance(item, dict)]
    request_id = request.scope.get("ghinbox_request_id")
    results = await fetch_bulk_comment_results(
        token_value,
        dict_items,
        request_id=request_id if isinstance(request_id, str) else None,
    )
    threads = {key: result for key, result in results if key}
    response: dict[str, Any] = {"threads": threads}
    if results.rate_limited:
        response["rate_limited"] = True
        response["rate_limit"] = results.denial
    return response


@router.get(
    "/rest/review-requests",
    summary="Review-request notifications",
    description="Fetches and normalizes active PR review requests for the authenticated user.",
)
async def review_requests(
    request: Request,
    owner: str | None = None,
    repo: str | None = None,
    query: str | None = None,
) -> dict:
    if not query and not (owner and repo):
        raise HTTPException(
            status_code=400,
            detail="Expected owner/repo parameters or a query parameter.",
        )
    if not get_token():
        raise HTTPException(
            status_code=503,
            detail="No GitHub token configured. Start server with --account.",
        )

    try:
        request_id = request.scope.get("ghinbox_request_id")
        notifications = await fetch_review_request_notifications(
            owner,
            repo,
            query,
            request_id=request_id if isinstance(request_id, str) else None,
        )
    except ReviewRequestSearchError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))
    return {"notifications": notifications}


@router.api_route(
    "/rest/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    summary="GitHub REST API proxy",
    description="Proxies requests to GitHub's REST API with authentication.",
    include_in_schema=False,
)
async def rest_proxy(path: str, request: Request) -> Response:
    """
    Proxy requests to GitHub REST API.

    All HTTP methods are supported. Query parameters and request body
    are forwarded as-is.
    """
    token = get_token()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="No GitHub token configured. Start server with --account.",
        )

    # Build target URL
    url = f"{GITHUB_API_BASE}/{path}"

    # Forward query parameters
    if request.query_params:
        url += f"?{request.query_params}"

    # Get request body if present
    body = await request.body()

    # Make the proxied request
    client = get_client()
    request_id = request.scope.get("ghinbox_request_id")
    request_id = request_id if isinstance(request_id, str) else None
    check_github_rate_governor(
        request_id=request_id,
        source="rest_proxy",
        method=request.method,
        url=url,
        call_class="interactive",
        pool=_expected_rest_rate_pool(url),
    )
    started = time.perf_counter()
    try:
        response = await client.request(
            method=request.method,
            url=url,
            headers=github_rest_headers(token),
            content=body if body else None,
        )
    except Exception as error:
        emit_github_api_call_audit(
            request_id=request_id,
            source="rest_proxy",
            method=request.method,
            url=url,
            status_code=None,
            duration_ms=(time.perf_counter() - started) * 1000,
            error=error.__class__.__name__,
        )
        raise
    emit_github_api_call_audit(
        request_id=request_id,
        source="rest_proxy",
        method=request.method,
        url=url,
        status_code=response.status_code,
        duration_ms=(time.perf_counter() - started) * 1000,
        response_headers=response.headers,
    )
    update_github_rate_governor_from_headers(response.headers)

    # Return the response with appropriate headers
    return Response(
        content=response.content,
        status_code=response.status_code,
        headers={
            "Content-Type": response.headers.get("Content-Type", "application/json"),
        },
    )


@router.post(
    "/graphql",
    summary="GitHub GraphQL API proxy",
    description="Proxies GraphQL queries to GitHub's GraphQL API with authentication.",
)
async def graphql_proxy(request: Request) -> Response:
    """
    Proxy GraphQL queries to GitHub.

    Expects a JSON body with 'query' and optional 'variables' fields.
    """
    token = get_token()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="No GitHub token configured. Start server with --account.",
        )

    # Get request body
    body = await request.body()

    # Make the proxied request
    client = get_client()
    request_id = request.scope.get("ghinbox_request_id")
    request_id = request_id if isinstance(request_id, str) else None
    url = f"{GITHUB_API_BASE}/graphql"
    check_github_rate_governor(
        request_id=request_id,
        source="graphql_proxy",
        method="POST",
        url=url,
        call_class="interactive",
        pool="graphql",
    )
    started = time.perf_counter()
    try:
        response = await client.post(
            url,
            headers=github_graphql_headers(token),
            content=body,
        )
    except Exception as error:
        emit_github_api_call_audit(
            request_id=request_id,
            source="graphql_proxy",
            method="POST",
            url=url,
            status_code=None,
            duration_ms=(time.perf_counter() - started) * 1000,
            error=error.__class__.__name__,
        )
        raise
    emit_github_api_call_audit(
        request_id=request_id,
        source="graphql_proxy",
        method="POST",
        url=url,
        status_code=response.status_code,
        duration_ms=(time.perf_counter() - started) * 1000,
        response_headers=response.headers,
    )
    update_github_rate_governor_from_headers(response.headers)

    return Response(
        content=response.content,
        status_code=response.status_code,
        headers={
            "Content-Type": response.headers.get("Content-Type", "application/json"),
        },
    )
