"""Feed classification and report-item shaping shared by digest consumers.

Queue decisions (what is Feed vs Replies vs trash) come from the webapp's UMD
modules via a thin Node classifier, so the server-side digest, the
``scripts/feed_digest.py`` CLI and the browser all agree (SOUL.md axiom 3).
The helpers here only reshape already-classified data for an LLM.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

DEFAULT_REPO = "pytorch/pytorch"
DEFAULT_CURRENT_USER = "ezyang"
# The webapp's default profile id (GhinboxProfiles.DEFAULT_PROFILE_ID). Only in
# this profile does the client route non-PyTorch-org notifications to Replies.
PYTORCH_PROFILE = "pytorch"
CLASSIFIER_SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts" / "feed_digest_classify.js"
)


class FeedDigestError(RuntimeError):
    """Raised for expected feed digest failures that should be user-readable."""


def routes_outside_pytorch_to_replies(profile_name: str | None) -> bool:
    """Mirror ``isNotificationDirectedAtCurrentUser``'s profile special case."""
    return profile_name == PYTORCH_PROFILE


def classify_notifications(
    notifications: list[dict],
    comment_threads: dict,
    current_user: str = DEFAULT_CURRENT_USER,
    *,
    route_outside_pytorch_to_replies: bool = False,
) -> dict:
    """Classify notifications by shelling out to the webapp's JS classifier."""
    node = shutil.which("node")
    if not node:
        raise FeedDigestError(
            "Node.js is required for feed classification; put `node` on PATH."
        )

    payload = {
        "notifications": notifications,
        "commentThreads": comment_threads,
        "currentUserLogin": current_user,
        "routeOutsidePytorchToReplies": route_outside_pytorch_to_replies,
    }
    try:
        result = subprocess.run(
            [node, str(CLASSIFIER_SCRIPT)],
            input=json.dumps(payload),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        message = str(exc)
        if isinstance(exc, subprocess.CalledProcessError):
            message = (exc.stderr or exc.stdout or message).strip()
        raise FeedDigestError(f"Node feed classifier failed: {message}") from exc

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise FeedDigestError(
            f"Node feed classifier returned invalid JSON: {exc}"
        ) from exc


def classify_feed(
    notifications: list[dict],
    comment_threads: dict,
    current_user: str = DEFAULT_CURRENT_USER,
    *,
    route_outside_pytorch_to_replies: bool = False,
) -> list[dict]:
    """
    Classify notifications into the Feed queue using the authoritative JS modules.

    Matches the webapp's matchesView('issues') logic.
    """
    classifications = classify_notifications(
        notifications,
        comment_threads,
        current_user,
        route_outside_pytorch_to_replies=route_outside_pytorch_to_replies,
    )
    feed_ids = {str(notification_id) for notification_id in classifications["feed_ids"]}
    return [
        notification
        for notification in notifications
        if str(notification.get("id", "")) in feed_ids
    ]


def _classify_mention(body: str, user_lower: str) -> str | None:
    """Classify how ``user_lower`` is @-mentioned in a comment body.

    Returns "direct" (a targeted mention), "broadcast" (buried in a large
    cc/@-list — weak signal), or None (not mentioned). A ``cc @a @b @c ...``
    line naming many maintainers is a broadcast: it means "this touches your
    area", not "I'm asking you specifically", so the digest should down-weight
    it rather than treat it like a direct ping.
    """
    lowered = body.lower()
    if f"@{user_lower}" not in lowered:
        return None
    mentions = re.findall(r"@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", lowered)
    unique_mentions = set(mentions)
    # A comment that @-mentions many distinct people is a broadcast cc, even if
    # it doesn't literally start with "cc". Threshold kept low: 2 others + you.
    if len(unique_mentions) >= 4:
        return "broadcast"
    return "direct"


def find_reply_nature_in_feed(
    feed_notifications: list[dict],
    comment_threads: dict,
    current_user: str = DEFAULT_CURRENT_USER,
) -> list[dict]:
    """
    Find feed items that have "reply" nature — the user participated and
    someone replied after them, but the notification wasn't classified into
    the Replies queue.

    Catches:
    - Someone @-mentioned the user in a comment body (direct vs. broadcast cc)
    - The user commented and someone (non-bot) replied after their last comment
    """
    reply_nature = []
    user_lower = current_user.lower()

    for n in feed_notifications:
        thread = comment_threads.get(n["id"], {})
        comments = thread.get("comments", [])

        reply_signals = []

        # Signal 1: @-mention in comment body. Prefer a direct mention; only
        # fall back to reporting a broadcast cc if that's all there is, so a
        # 15-name "cc @ezyang @gchanan ..." list doesn't masquerade as someone
        # asking the user directly.
        direct_mention_author: str | None = None
        broadcast_mention_author: str | None = None
        for c in comments:
            author = (c.get("user", {}).get("login") or "").lower()
            if author == user_lower:
                continue
            kind = _classify_mention(c.get("body") or "", user_lower)
            if kind == "direct" and direct_mention_author is None:
                direct_mention_author = author
                break
            if kind == "broadcast" and broadcast_mention_author is None:
                broadcast_mention_author = author
        if direct_mention_author is not None:
            reply_signals.append(f"@-mentioned by {direct_mention_author}")
        elif broadcast_mention_author is not None:
            reply_signals.append(f"cc'd (broadcast) by {broadcast_mention_author}")

        # Signal 2: user commented and got non-bot replies after
        user_comments = [
            c
            for c in comments
            if (c.get("user", {}).get("login") or "").lower() == user_lower
        ]
        if user_comments:
            last_user_time = max(
                c.get("created_at") or c.get("createdAt") or "" for c in user_comments
            )
            newer_from_others = [
                c
                for c in comments
                if (c.get("user", {}).get("login") or "").lower() != user_lower
                and (c.get("created_at") or c.get("createdAt") or "") > last_user_time
                and not (c.get("user", {}).get("login") or "").endswith("[bot]")
            ]
            if newer_from_others:
                repliers = {
                    (c.get("user", {}).get("login") or "?") for c in newer_from_others
                }
                reply_signals.append(f"replied to by {', '.join(sorted(repliers))}")

        if reply_signals:
            n["_reply_signals"] = reply_signals
            reply_nature.append(n)

    return reply_nature


def _compact_text(text: str, max_chars: int = 240) -> str:
    collapsed = " ".join((text or "").split())
    if len(collapsed) <= max_chars:
        return collapsed
    return collapsed[: max_chars - 3].rstrip() + "..."


def _subject_type_label(subject_type: str | None) -> str:
    if subject_type == "PullRequest":
        return "PR"
    return subject_type or "?"


def _notification_url(notification: dict, repo: str = DEFAULT_REPO) -> str:
    subject = notification.get("subject") or {}
    url = subject.get("url")
    if url:
        return str(url)

    # Profile snapshots span many repos; the fallback repo is only for
    # notifications that carry no repository of their own.
    notification_repo = (notification.get("repository") or {}).get("full_name")
    repo_name = notification_repo or repo
    number = subject.get("number")
    if number:
        path = "pull" if subject.get("type") == "PullRequest" else "issues"
        return f"https://github.com/{repo_name}/{path}/{number}"

    return f"https://github.com/{repo_name}"


def _actor_logins(notification: dict) -> list[str]:
    return [
        actor.get("login", "?")
        for actor in notification.get("actors", [])
        if actor.get("login")
    ]


def _label_names(notification: dict) -> list[str]:
    return [
        label.get("name", "?")
        for label in notification.get("labels", [])
        if label.get("name")
    ]


def build_report_items(
    feed_notifications: list[dict],
    comment_threads: dict,
    reply_nature_ids: set[str],
    repo: str = DEFAULT_REPO,
) -> list[dict]:
    """Build structured items for the LLM-generated HTML report."""
    items: list[dict] = []
    for n in feed_notifications:
        nid = str(n.get("id", ""))
        subject = n.get("subject") or {}
        thread = comment_threads.get(nid, {})
        comments = thread.get("comments", [])

        snippets = []
        for comment in comments[-2:]:
            body = _compact_text(comment.get("body") or "")
            if not body:
                continue
            snippets.append(
                {
                    "author": (comment.get("user") or {}).get("login", "?"),
                    "body": body,
                }
            )

        items.append(
            {
                "id": nid,
                "number": subject.get("number"),
                "title": subject.get("title", "???"),
                "url": _notification_url(n, repo),
                "type": _subject_type_label(subject.get("type")),
                "state": subject.get("state", "?"),
                "reason": n.get("reason", "?"),
                "updated_at": n.get("updated_at", "?"),
                "actors": _actor_logins(n),
                "labels": _label_names(n),
                "comment_count": len(comments),
                "reply_nature": nid in reply_nature_ids,
                "reply_signals": n.get("_reply_signals", []),
                "snippets": snippets,
            }
        )

    return items
