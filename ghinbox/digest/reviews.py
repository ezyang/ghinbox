"""LLM screening of External review requests (Reviews > Needs review > External).

External PRs (authors without write access to a high-volume repo) far
outnumber the user's review time. After each sync the digest worker asks the
LLM, per PR, which of the user's "worth a look" buckets it fits (see
``review_rubric.md``): easy to land, code the user knows well, or important.
No bucket means "skip"; the client's "Worth a look" filter hides only those.

Which PRs are External is the webapp's decision (``isExternalReviewCandidate``,
run under Node); it needs each author's repository permission, which this
module fetches and caches (SOUL.md axiom 2). Judging also needs the diff, so
each PR costs one GitHub call per update (to read its head SHA) and one more
for its files when the code changed. Verdicts are a disposable cache keyed by
``owner/repo#number``, redone when the head SHA or the rubric changes.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

from ghinbox.api.rate_governor import RateGovernorDeniedError
from ghinbox.digest import prompts
from ghinbox.digest.store import (
    get_review_assessments,
    save_author_permission,
    save_review_assessments,
)

logger = logging.getLogger(__name__)

DEFAULT_RUBRIC_PATH = Path(__file__).with_name("review_rubric.md")
REVIEW_BATCH_SIZE = 4
MAX_REVIEW_ASSESSMENTS_PER_PASS = 12
MAX_PR_FETCHES_PER_PASS = 30
MAX_PERMISSION_FETCHES_PER_PASS = 30
PERMISSION_MAX_AGE = timedelta(days=7)
# What the LLM sees per PR: the description, recent human comments, every
# changed file (first page of 100), and as many patches as fit the budget.
REVIEW_BODY_CHARS = 2000
REVIEW_COMMENT_CHARS = 400
REVIEW_MAX_COMMENTS = 4
REVIEW_DIFF_CHARS = 12000
REVIEW_PATCH_CHARS = 4000

# Calls the LLM with (prompt, item_count) and logs it; returns the answer text.
ReviewAsker = Callable[[str, int], Awaitable[str]]


class ReviewFetchError(RuntimeError):
    pass


class ReviewFetcher(Protocol):
    async def permission(self, repo: str, login: str) -> str: ...

    async def pull(self, repo: str, number: int) -> dict[str, Any]: ...

    async def files(self, repo: str, number: int) -> list[dict[str, Any]]: ...


class GitHubReviewFetcher:
    """Background-class REST calls with the server's token."""

    async def _get(
        self, path: str, source: str, params: dict[str, str] | None = None
    ) -> tuple[int, Any]:
        from ghinbox.api.github_proxy import _github_get_json, get_client, get_token

        token = get_token()
        if not token:
            raise ReviewFetchError("No GitHub token configured")
        return await _github_get_json(
            get_client(),
            token,
            path,
            params,
            source=source,
            call_class="background",
        )

    async def permission(self, repo: str, login: str) -> str:
        status, payload = await self._get(
            f"repos/{repo}/collaborators/{quote(login)}/permission",
            "digest.review_permission",
        )
        if status == 404:
            return "none"
        if status >= 400 or not isinstance(payload, dict):
            raise ReviewFetchError(f"Permission lookup for {login} failed ({status})")
        return str(payload.get("permission") or payload.get("role_name") or "none")

    async def pull(self, repo: str, number: int) -> dict[str, Any]:
        status, payload = await self._get(
            f"repos/{repo}/pulls/{number}", "digest.review_pull"
        )
        if status >= 400 or not isinstance(payload, dict):
            raise ReviewFetchError(f"Fetching {repo}#{number} failed ({status})")
        return payload

    async def files(self, repo: str, number: int) -> list[dict[str, Any]]:
        status, payload = await self._get(
            f"repos/{repo}/pulls/{number}/files",
            "digest.review_files",
            {"per_page": "100"},
        )
        if status >= 400 or not isinstance(payload, list):
            raise ReviewFetchError(f"Fetching {repo}#{number} files failed ({status})")
        return [entry for entry in payload if isinstance(entry, dict)]


def reviews_enabled() -> bool:
    return os.environ.get("GHINBOX_DIGEST_REVIEWS", "1") != "0"


def load_rubric() -> tuple[str, str]:
    """The user's rubric (``GHINBOX_REVIEW_RUBRIC_FILE``) and its hash.

    Editing the rubric changes the hash, which re-assesses every PR.
    """
    path = Path(os.environ.get("GHINBOX_REVIEW_RUBRIC_FILE") or DEFAULT_RUBRIC_PATH)
    text = path.read_text(encoding="utf-8")
    return text, hashlib.sha256(text.encode()).hexdigest()[:16]


def pr_key(notification: dict[str, Any]) -> str:
    """``owner/repo#number`` with a lowercase repo, like the client's PR key."""
    repo = str((notification.get("repository") or {}).get("full_name") or "")
    number = (notification.get("subject") or {}).get("number")
    return f"{repo.lower()}#{number}" if repo and number else ""


async def refresh_author_permissions(
    requests: list[dict[str, Any]],
    fetcher: ReviewFetcher,
    now: datetime,
) -> tuple[int, str | None]:
    """Fetch and cache permissions the classifier asked for (bounded).

    Returns how many were cached and the error that stopped the pass, if any.
    """
    fetched = 0
    for request in requests[:MAX_PERMISSION_FETCHES_PER_PASS]:
        repo, login = str(request["repo"]), str(request["login"])
        try:
            permission = await fetcher.permission(repo, login)
        except (ReviewFetchError, RateGovernorDeniedError) as error:
            logger.warning("Digest permission lookup stopped: %s", error)
            return fetched, str(error)
        save_author_permission(repo, login, permission, now)
        fetched += 1
    return fetched, None


def _is_bot(login: str, user: dict[str, Any]) -> bool:
    return user.get("type") == "Bot" or login.endswith("[bot]")


def _human_comments(thread: dict[str, Any] | None) -> list[dict[str, str]]:
    comments = []
    for comment in (thread or {}).get("comments") or []:
        if not isinstance(comment, dict) or comment.get("isIssue"):
            continue
        user = comment.get("user") or {}
        login = str(user.get("login") or "?")
        if comment.get("minimized") or not comment.get("body") or _is_bot(login, user):
            continue
        comments.append(
            {
                "author": login,
                "body": prompts.compact(comment.get("body"), REVIEW_COMMENT_CHARS),
            }
        )
    return comments[-REVIEW_MAX_COMMENTS:]


def build_review_item(
    notification: dict[str, Any],
    thread: dict[str, Any] | None,
    pull: dict[str, Any],
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    """What the LLM sees for one PR."""
    diff_parts: list[str] = []
    diff_chars = 0
    omitted = 0
    for entry in files:
        patch = str(entry.get("patch") or "")
        if not patch:
            continue
        if len(patch) > REVIEW_PATCH_CHARS:
            patch = patch[:REVIEW_PATCH_CHARS] + "\n[patch truncated]"
        part = f"--- {entry.get('filename')}\n{patch}"
        if diff_chars + len(part) > REVIEW_DIFF_CHARS:
            omitted += 1
            continue
        diff_parts.append(part)
        diff_chars += len(part)
    changed_files = pull.get("changed_files")
    return {
        "id": pr_key(notification),
        "title": pull.get("title") or (notification.get("subject") or {}).get("title"),
        "author": (pull.get("user") or {}).get("login"),
        "author_association": pull.get("author_association")
        or notification.get("author_association"),
        "labels": [
            label.get("name")
            for label in notification.get("labels") or []
            if isinstance(label, dict) and label.get("name")
        ],
        "additions": pull.get("additions"),
        "deletions": pull.get("deletions"),
        "changed_files": changed_files,
        "body": prompts.compact(pull.get("body"), REVIEW_BODY_CHARS),
        "comments": _human_comments(thread),
        "files": [
            {
                "path": entry.get("filename"),
                "status": entry.get("status"),
                "additions": entry.get("additions"),
                "deletions": entry.get("deletions"),
            }
            for entry in files
        ],
        "files_not_listed": max(0, int(changed_files or 0) - len(files)),
        "diff": "\n".join(diff_parts),
        "diff_omitted_files": omitted,
    }


def is_current(
    assessment: dict[str, Any] | None, updated_at: Any, rubric_hash: str
) -> bool:
    return bool(
        assessment
        and assessment.get("updated_at") == updated_at
        and assessment.get("rubric_hash") == rubric_hash
    )


async def assess_reviews(
    profile: str,
    ask: ReviewAsker,
    fetcher: ReviewFetcher,
    notifications: dict[str, dict[str, Any]],
    threads: dict[str, dict[str, Any]],
    external_ids: list[str],
    current_user: str,
    now: datetime,
) -> dict[str, Any]:
    """Assess External review requests that changed since their last verdict.

    Only a new head SHA (or rubric) costs an LLM call; other activity just
    re-reads the PR. Bounded per pass; never raises, so a GitHub or LLM
    failure cannot take the Feed digest down with it.
    """
    rubric, rubric_hash = load_rubric()
    stored = get_review_assessments(profile)
    candidates = {
        key: notifications[nid]
        for nid in external_ids
        if nid in notifications and (key := pr_key(notifications[nid]))
    }
    updated: dict[str, dict[str, Any]] = {}
    queue: list[tuple[str, dict[str, Any], dict[str, Any], list[dict[str, Any]]]] = []
    fetches = 0
    error: str | None = None
    for key, notification in candidates.items():
        previous = stored.get(key)
        updated_at = notification.get("updated_at")
        if is_current(previous, updated_at, rubric_hash):
            continue
        if (
            len(queue) >= MAX_REVIEW_ASSESSMENTS_PER_PASS
            or fetches >= MAX_PR_FETCHES_PER_PASS
        ):
            break
        repo, number = key.rsplit("#", 1)
        try:
            pull = await fetcher.pull(repo, int(number))
            fetches += 1
            head_sha = (pull.get("head") or {}).get("sha")
            if (
                previous
                and previous.get("verdict") != "unknown"
                and previous.get("head_sha") == head_sha
                and previous.get("rubric_hash") == rubric_hash
            ):
                updated[key] = {**previous, "updated_at": updated_at}
                continue
            files = await fetcher.files(repo, int(number))
            fetches += 1
        except (ReviewFetchError, RateGovernorDeniedError) as exc:
            logger.warning("Digest review fetch stopped for %s: %s", profile, exc)
            error = str(exc)
            break
        queue.append((key, notification, pull, files))

    assessed = 0
    for start in range(0, len(queue), REVIEW_BATCH_SIZE):
        batch = queue[start : start + REVIEW_BATCH_SIZE]
        views = [
            build_review_item(
                notification, threads.get(str(notification.get("id"))), pull, files
            )
            for _, notification, pull, files in batch
        ]
        try:
            response = await ask(
                prompts.build_review_prompt(views, current_user, rubric), len(batch)
            )
            verdicts = prompts.parse_review_response(
                prompts.extract_json_object(response), views
            )
        except Exception as exc:
            logger.exception("Digest review check failed for %s", profile)
            error = str(exc) or exc.__class__.__name__
            break
        for key, notification, pull, _ in batch:
            updated[key] = {
                **verdicts[key],
                "notification_id": str(notification.get("id")),
                "title": pull.get("title"),
                "updated_at": notification.get("updated_at"),
                "head_sha": (pull.get("head") or {}).get("sha"),
                "rubric_hash": rubric_hash,
                "assessed_at": now.isoformat(),
            }
        assessed += len(batch)

    save_review_assessments(profile, updated, set(candidates))
    current = {
        key: assessment
        for key, assessment in {**stored, **updated}.items()
        if key in candidates
    }
    verdicts_now = [assessment.get("verdict") for assessment in current.values()]
    return {
        "candidates": len(candidates),
        "assessed": assessed,
        "progress": len(updated),
        "pending": sum(
            not is_current(
                current.get(key), notification.get("updated_at"), rubric_hash
            )
            for key, notification in candidates.items()
        ),
        "look": verdicts_now.count("look"),
        "skip": verdicts_now.count("skip"),
        "error": error,
    }
