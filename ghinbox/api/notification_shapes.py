"""Shared notification shape helpers for API routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

REVIEW_REQUEST_SEARCH_PER_PAGE = 100


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_repo_input(value: str | None) -> dict[str, str] | None:
    parts = str(value or "").strip().split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return {"owner": parts[0], "repo": parts[1], "full_name": f"{parts[0]}/{parts[1]}"}


def parse_github_repo_url(value: object) -> dict[str, str] | None:
    if not value:
        return None
    try:
        parsed = urlparse(str(value))
    except ValueError:
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if parsed.hostname == "api.github.com":
        try:
            repos_index = parts.index("repos")
        except ValueError:
            return None
        if len(parts) > repos_index + 2:
            return parse_repo_input(
                f"{parts[repos_index + 1]}/{parts[repos_index + 2]}"
            )
    if parsed.hostname == "github.com" or (
        parsed.hostname and parsed.hostname.endswith(".github.com")
    ):
        if len(parts) >= 2:
            return parse_repo_input(f"{parts[0]}/{parts[1]}")
    return None


def repository_dict(owner: str, repo: str) -> dict[str, str]:
    return {"owner": owner, "name": repo, "full_name": f"{owner}/{repo}"}


def get_notification_repo(
    notification: dict[str, Any],
    owner: str | None = None,
    repo: str | None = None,
) -> dict[str, str] | None:
    repository = notification.get("repository")
    if isinstance(repository, dict):
        full_name = repository.get("full_name")
        parsed = parse_repo_input(str(full_name)) if full_name else None
        if parsed:
            return parsed
        repo_owner = repository.get("owner")
        repo_name = repository.get("name") or repository.get("repo")
        if repo_owner and repo_name:
            return parse_repo_input(f"{repo_owner}/{repo_name}")

    subject = notification.get("subject")
    subject_url = subject.get("url") if isinstance(subject, dict) else None
    parsed_url = parse_github_repo_url(subject_url or notification.get("url"))
    if parsed_url:
        return parsed_url
    if owner and repo:
        return parse_repo_input(f"{owner}/{repo}")
    return None


def get_comment_fetch_window(
    notification: dict[str, Any],
) -> tuple[str | None, str | None]:
    subject = notification.get("subject")
    ui = notification.get("ui")
    anchor = subject.get("anchor") if isinstance(subject, dict) else None
    read_comment_watermark_at = (
        ui.get("read_comment_watermark_at") if isinstance(ui, dict) else None
    )
    last_read_at = read_comment_watermark_at or notification.get("last_read_at")
    return anchor, last_read_at


def notification_to_bulk_comment_item(
    notification: dict[str, Any],
    owner: str | None = None,
    repo: str | None = None,
) -> dict[str, Any] | None:
    subject = notification.get("subject")
    if not isinstance(subject, dict):
        return None
    number = subject.get("number")
    if not isinstance(number, int):
        return None
    repo_info = get_notification_repo(notification, owner, repo)
    if repo_info is None:
        return None
    anchor, last_read_at = get_comment_fetch_window(notification)
    return {
        "key": str(notification.get("id") or ""),
        "owner": repo_info["owner"],
        "repo": repo_info["repo"],
        "number": number,
        "is_pr": subject.get("type") == "PullRequest",
        "subject_state": subject.get("state"),
        "anchor": anchor,
        "last_read_at": last_read_at,
    }


def build_comment_cache_entry(
    notification: dict[str, Any],
    result: dict[str, Any],
    fetched_at: str,
) -> dict[str, Any]:
    anchor, last_read_at = get_comment_fetch_window(notification)
    entry = {
        "notificationUpdatedAt": notification.get("updated_at"),
        "anchor": anchor,
        "lastReadAt": last_read_at,
        "unread": notification.get("unread"),
        "comments": result.get("comments")
        if isinstance(result.get("comments"), list)
        else [],
        "stateEvents": result.get("stateEvents")
        if isinstance(result.get("stateEvents"), list)
        else [],
        "allComments": bool(result.get("allComments")),
        "fetchedAt": fetched_at,
    }
    if result.get("error"):
        entry["error"] = result.get("error")
    return entry


def build_review_request_search_query(
    owner: str | None = None,
    repo: str | None = None,
    query: str | None = None,
) -> str:
    scope = query or (f"repo:{owner}/{repo}" if owner and repo else "")
    return " ".join(
        [scope, "is:pr", "is:open", "user-review-requested:@me", "-review:approved"]
    ).strip()


def get_search_item_repo(
    item: dict[str, Any],
    owner: str | None = None,
    repo: str | None = None,
) -> dict[str, str] | None:
    for key in ("repository_url", "html_url", "url"):
        parsed = parse_github_repo_url(item.get(key))
        if parsed:
            return parsed
    pull_request = item.get("pull_request")
    if isinstance(pull_request, dict):
        parsed = parse_github_repo_url(pull_request.get("url"))
        if parsed:
            return parsed
    if owner and repo:
        return parse_repo_input(f"{owner}/{repo}")
    return None


def _label_names_from_search_item(item: dict[str, Any]) -> list[str]:
    labels = item.get("labels")
    if not isinstance(labels, list):
        return []
    names = []
    for label in labels:
        name = (
            label
            if isinstance(label, str)
            else (label.get("name") if isinstance(label, dict) else None)
        )
        if isinstance(name, str) and name.strip():
            names.append(name)
    return names


def search_item_to_review_request_notification(
    owner: str | None,
    repo: str | None,
    item: dict[str, Any],
) -> dict[str, Any] | None:
    number = item.get("number")
    if not isinstance(number, int) or item.get("pull_request") is None:
        return None
    repo_info = get_search_item_repo(item, owner, repo)
    if repo_info is None:
        return None
    repo_owner = repo_info["owner"]
    repo_name = repo_info["repo"]
    user = item.get("user") if isinstance(item.get("user"), dict) else {}
    state = "draft" if item.get("draft") else str(item.get("state") or "open").lower()
    notification: dict[str, Any] = {
        "id": f"review-request:{repo_owner}/{repo_name}#{number}",
        "unread": False,
        "reason": "review_requested",
        "responsibility_source": "review-requested",
        "updated_at": item.get("updated_at") or item.get("created_at") or _now(),
        "last_read_at": None,
        "repository": repository_dict(repo_owner, repo_name),
        "subject": {
            "title": item.get("title") or f"Pull request #{number}",
            "url": item.get("html_url")
            or f"https://github.com/{repo_owner}/{repo_name}/pull/{number}",
            "type": "PullRequest",
            "number": number,
            "state": state,
            "state_reason": None,
        },
        "actors": (
            [{"login": user["login"], "avatar_url": user.get("avatar_url") or ""}]
            if user.get("login")
            else []
        ),
        "ui": {"saved": False, "done": False, "action_tokens": {}},
    }
    if isinstance(item.get("labels"), list):
        notification["labels"] = [
            {"name": name} for name in _label_names_from_search_item(item)
        ]
    if item.get("author_association") is not None:
        notification["author_association"] = item.get("author_association")
    return notification
