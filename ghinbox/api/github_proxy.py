"""
GitHub API proxy routes.

Proxies requests to GitHub's REST and GraphQL APIs using the stored token.
"""

import asyncio
import os
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

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
    account = os.environ.get("GHSIM_ACCOUNT")
    if not account:
        return None
    return load_token(account)


async def _github_get_json(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    params: dict[str, str] | None = None,
) -> tuple[int, object]:
    url = f"{GITHUB_API_BASE}/{path}"
    if params:
        url += f"?{urlencode(params)}"
    response = await client.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    if response.status_code >= 400:
        return response.status_code, response.text
    return response.status_code, response.json()


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

    status, issue_comments = await _github_get_json(
        client,
        token,
        f"repos/{owner}/{repo}/issues/{number}/comments",
        params,
    )
    if status >= 400:
        return key, {
            "error": f"Issue comments fetch failed ({status}): {issue_comments}"
        }
    if isinstance(issue_comments, list):
        comments.extend(issue_comments)

    if is_pr:
        status, review_comments = await _github_get_json(
            client,
            token,
            f"repos/{owner}/{repo}/pulls/{number}/comments",
            params,
        )
        if status < 400 and isinstance(review_comments, list):
            for comment in review_comments:
                if isinstance(comment, dict):
                    comment = {**comment, "isReviewComment": True}
                comments.append(comment)

    if fetch_state_events:
        status, issue_events = await _github_get_json(
            client,
            token,
            f"repos/{owner}/{repo}/issues/{number}/events",
            {"per_page": "100"},
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
    if not isinstance(items, list):
        raise HTTPException(
            status_code=400, detail="Expected JSON body with items list."
        )

    client = get_client()
    limit = asyncio.Semaphore(COMMENT_BULK_CONCURRENCY)

    async def run_item(item: object) -> tuple[str, dict]:
        if not isinstance(item, dict):
            return "", {"error": "Invalid bulk comment request item."}
        async with limit:
            return await _fetch_bulk_comment_item(client, token_value, item)

    results = await asyncio.gather(*(run_item(item) for item in items))
    threads = {key: result for key, result in results if key}
    return {"threads": threads}


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

    # Build headers
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Get request body if present
    body = await request.body()

    # Make the proxied request
    client = get_client()
    response = await client.request(
        method=request.method,
        url=url,
        headers=headers,
        content=body if body else None,
    )

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

    # Build headers
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Make the proxied request
    client = get_client()
    response = await client.post(
        f"{GITHUB_API_BASE}/graphql",
        headers=headers,
        content=body,
    )

    return Response(
        content=response.content,
        status_code=response.status_code,
        headers={
            "Content-Type": response.headers.get("Content-Type", "application/json"),
        },
    )
