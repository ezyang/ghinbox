"""REST-backed notification archive helpers."""

import base64
import binascii
import logging
import re
import time
from urllib.parse import urlparse

from ghinbox.api.fetcher import ActionResult
from ghinbox.api.github_proxy import (
    GITHUB_API_BASE,
    _github_get_json_with_headers,
    _next_link_url,
    check_github_rate_governor,
    get_client,
    get_token,
    update_github_rate_governor_from_headers,
)
from ghinbox.api.observability import emit_github_api_call_audit
from ghinbox.api.snapshot_store import (
    get_snapshot,
    list_snapshot_repos,
    remove_notifications_from_snapshots,
)
from ghinbox.github_headers import github_rest_headers

logger = logging.getLogger(__name__)

MAX_GITHUB_NOTIFICATION_ACTION_IDS = 25
# Keep this hard cap: an uncapped lookup loop once burned the entire GitHub
# rate limit while trying to resolve current HTML notification IDs.
MAX_REST_THREAD_LOOKUP_PAGES = 10
SubjectKey = tuple[str, str, str, int]


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
    thread_ids: dict[SubjectKey, str] = {}

    for (owner, repo), repo_keys in keys_by_repo.items():
        path_or_url = f"repos/{owner}/{repo}/notifications"
        params = {"all": "true", "per_page": "100"}
        pages_fetched = 0

        while True:
            if pages_fetched >= MAX_REST_THREAD_LOOKUP_PAGES:
                return None
            status, payload, headers = await _github_get_json_with_headers(
                client,
                token,
                path_or_url,
                params,
                source="archive.thread_lookup",
                request_id=request_id,
                call_class="interactive",
            )
            pages_fetched += 1
            if status >= 400:
                return None

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

            next_url = _next_link_url(headers.get("link"))
            if next_url is None:
                break
            path_or_url = next_url
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


def _prune_snapshot_for_action(action: str, notification_ids: list[str]) -> None:
    """Keep the stored snapshot coherent after a successful action.

    Archive and unsubscribe remove notifications from the inbox, so drop those
    IDs from the stored snapshot. This lets an already-open browser tab reflect
    the change via a lightweight "Server Refresh" (GET /api/snapshots/...)
    instead of a full GitHub sync, and reconciles out-of-band mark-done
    (e.g. scripts/feed_digest.py --mark-done). Undo actions (unarchive/subscribe)
    do not remove inbox items; a full sync reconciles those.
    """
    if action not in {"archive", "unsubscribe"}:
        return
    try:
        remove_notifications_from_snapshots(notification_ids)
    except Exception:
        # Snapshot pruning is a cache-coherence convenience; never fail the
        # action (which already succeeded against GitHub) because of it.
        logger.exception("Failed to prune archived notifications from snapshot")


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
    headers = github_rest_headers(token)
    for thread_id in thread_ids:
        url = f"{GITHUB_API_BASE}/notifications/threads/{thread_id}"
        check_github_rate_governor(
            request_id=request_id,
            source="archive.thread_delete",
            method="DELETE",
            url=url,
            call_class="interactive",
            pool="core",
        )
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
        update_github_rate_governor_from_headers(getattr(response, "headers", None))
        last_status_code = response.status_code
        if response.status_code >= 400:
            return ActionResult(
                status="error",
                error=f"HTTP {response.status_code}",
                response_html=response.text,
                github_status_code=response.status_code,
            )

    return ActionResult(status="ok", github_status_code=last_status_code)
