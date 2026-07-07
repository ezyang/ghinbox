#!/usr/bin/env python3
"""
Feed Digest — extract and format Feed notifications for LLM summarization.

All data comes from the running ghinbox server over its local debug Unix
socket (SOUL.md axiom 2: the server owns the snapshot; consumers talk to it
rather than reaching into its private SQLite store). The server must be running
with a debug socket (default: auth_state/ghinbox-debug.sock).

Usage (two-step flow, run from repo root):

    # Step 1: Extract feed data to JSON. By default the JSON instructs the
    #         caller to write an HTML report to /tmp/feed-report.html with
    #         "Open all" controls for each summarized section.
    uv run python scripts/feed_digest.py --extract > /tmp/feed_data.json

    # Step 2: Feed the JSON to a Claude Code subagent for summarization and
    #         HTML report generation. The LLM generates the grouped report;
    #         this script supplies the data and durable instructions.

    # Step 3: Mark done (after reviewing the digest)
    uv run python scripts/feed_digest.py --mark-done [--exclude-ids id1,id2,...]

    # After marking done, the server prunes those IDs from its stored snapshot,
    # so an already-open browser tab can pick up the change by clicking
    # "Server Refresh" (no full GitHub sync needed).

The extract output includes a "snapshot_health" block; if the server's last
sync fetched more notifications than are stored (a truncated snapshot), the
digest surfaces a warning instead of silently reporting a partial feed.

The Feed queue contains notifications that are NOT directed at the current user
(replies) and NOT review requests. These are the "ambient awareness" items.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx


DEFAULT_SOCKET_PATH = "auth_state/ghinbox-debug.sock"
BASE_URL = "http://ghinbox"
ACTION_URL = f"{BASE_URL}/notifications/html/action"
DEFAULT_REPO = "pytorch/pytorch"
DEFAULT_CURRENT_USER = "ezyang"
DEFAULT_REPORT_PATH = "/tmp/feed-report.html"
CLASSIFIER_SCRIPT = Path(__file__).with_name("feed_digest_classify.js")

# The default target is the "PyTorch" profile (mirrors the webapp's default
# profile in notifications-core.js): the two orgs the user actually watches.
# The server snapshots a profile as one keyed unit; single repos remain
# addressable via --repo for ad-hoc digests.
DEFAULT_PROFILE = "pytorch"
DEFAULT_PROFILE_ENTRIES = ["org:pytorch", "org:meta-pytorch"]

# A snapshot older than this is likely to have drifted from GitHub (new
# notifications never entered it). Periodic sync is often off, so the digest
# warns rather than silently reporting a stale feed.
STALE_SNAPSHOT_SECONDS = 6 * 3600

# How long to wait for a server-side profile sync to finish before giving up.
SYNC_POLL_TIMEOUT_SECONDS = 300
SYNC_POLL_INTERVAL_SECONDS = 2


class FeedDigestError(RuntimeError):
    """Raised for expected feed digest failures that should be user-readable."""


def _debug_client(socket_path: str = DEFAULT_SOCKET_PATH) -> httpx.Client:
    """HTTP client bound to the server's local debug Unix socket.

    Per SOUL.md axiom 2, the server owns the snapshot; consumers talk to it
    over HTTP rather than reaching into its private SQLite store (which also
    dodges WAL/readonly staleness surprises).
    """
    transport = httpx.HTTPTransport(uds=socket_path)
    return httpx.Client(transport=transport, base_url=BASE_URL, timeout=60)


def _entry_to_payload(entry: str) -> dict:
    """Classify a profile entry string into a server SnapshotEntry payload.

    Mirrors the webapp's classifyProfileEntry: a bare ``owner/repo`` or
    ``repo:owner/repo`` becomes a repo entry; anything else (``org:...``,
    free-form search) becomes a query entry.
    """
    value = entry.strip()
    if not value:
        raise FeedDigestError("Empty profile entry")
    repo_match = re.fullmatch(r"(?:repo:)?([^/\s:]+)/([^/\s:]+)", value)
    if repo_match:
        return {
            "kind": "repo",
            "owner": repo_match.group(1),
            "repo": repo_match.group(2),
        }
    return {"kind": "query", "query": value}


def _normalize_snapshot(payload: dict, missing_msg: str) -> dict:
    snapshot = payload.get("snapshot")
    if not snapshot:
        raise FeedDigestError(missing_msg)
    return {
        "snapshot": {
            "notifications": snapshot.get("notifications", []),
            "comment_cache": snapshot.get("comment_cache") or {},
            "authenticity_token": snapshot.get("authenticity_token") or "",
            "generated_at": snapshot.get("generated_at"),
            "synced_at": snapshot.get("synced_at"),
        },
        "sync": payload.get("sync") or {},
    }


def fetch_snapshot(
    repo: str = DEFAULT_REPO,
    socket_path: str = DEFAULT_SOCKET_PATH,
) -> dict:
    """Fetch a single-repo server snapshot over the debug socket."""
    owner, _, name = repo.partition("/")
    if not owner or not name:
        raise FeedDigestError(f"Invalid repo {repo!r}; expected owner/name")

    try:
        with _debug_client(socket_path) as client:
            resp = client.get(f"/api/snapshots/{owner}/{name}")
            resp.raise_for_status()
            payload = resp.json()
    except httpx.HTTPError as exc:
        raise FeedDigestError(
            f"Unable to reach ghinbox server at {socket_path!r}: {exc}. "
            "Is the server running with a debug socket?"
        ) from exc

    return _normalize_snapshot(
        payload, f"Server has no snapshot for {repo}; run a sync first."
    )


def fetch_profile_snapshot(
    profile: str = DEFAULT_PROFILE,
    socket_path: str = DEFAULT_SOCKET_PATH,
) -> dict:
    """Fetch a profile server snapshot over the debug socket."""
    try:
        with _debug_client(socket_path) as client:
            resp = client.get(f"/api/snapshots/profile/{profile}")
            resp.raise_for_status()
            payload = resp.json()
    except httpx.HTTPError as exc:
        raise FeedDigestError(
            f"Unable to reach ghinbox server at {socket_path!r}: {exc}. "
            "Is the server running with a debug socket?"
        ) from exc

    return _normalize_snapshot(
        payload,
        f"Server has no snapshot for profile {profile!r}; "
        "run `--sync` first to build it.",
    )


def sync_profile_snapshot(
    profile: str = DEFAULT_PROFILE,
    entries: list[str] | None = None,
    socket_path: str = DEFAULT_SOCKET_PATH,
) -> dict:
    """Trigger a server-side profile sync and poll until it finishes.

    This is a live GitHub sync; only run it when the caller explicitly asks
    (the --sync flag). Returns the final sync state dict.
    """
    entry_payloads = [
        _entry_to_payload(e) for e in (entries or DEFAULT_PROFILE_ENTRIES)
    ]
    try:
        with _debug_client(socket_path) as client:
            resp = client.post(
                f"/api/snapshots/profile/{profile}/sync",
                json={"mode": "full", "entries": entry_payloads},
            )
            resp.raise_for_status()

            waited = 0.0
            while True:
                sync_resp = client.get(f"/api/snapshots/profile/{profile}/sync")
                sync_resp.raise_for_status()
                sync = sync_resp.json().get("sync") or {}
                status = sync.get("status")
                if status == "success":
                    return sync
                if status == "error":
                    raise FeedDigestError(
                        f"Profile sync failed: {sync.get('error') or 'unknown error'}"
                    )
                if waited >= SYNC_POLL_TIMEOUT_SECONDS:
                    raise FeedDigestError(
                        f"Profile sync did not finish within "
                        f"{SYNC_POLL_TIMEOUT_SECONDS}s (status={status})."
                    )
                phase = sync.get("phase", "?")
                count = sync.get("notifications_count", 0)
                print(
                    f"  syncing… phase={phase} notifications={count} "
                    f"pages={sync.get('pages_fetched', 0)}",
                    file=sys.stderr,
                )
                time.sleep(SYNC_POLL_INTERVAL_SECONDS)
                waited += SYNC_POLL_INTERVAL_SECONDS
    except httpx.HTTPError as exc:
        raise FeedDigestError(
            f"Unable to reach ghinbox server at {socket_path!r}: {exc}. "
            "Is the server running with a debug socket?"
        ) from exc


def classify_notifications(
    notifications: list[dict],
    comment_threads: dict,
    current_user: str = DEFAULT_CURRENT_USER,
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
) -> list[dict]:
    """
    Classify notifications into the Feed queue using the authoritative JS modules.

    Matches the webapp's matchesView('issues') logic.
    """
    classifications = classify_notifications(
        notifications,
        comment_threads,
        current_user,
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


def build_report_instructions(report_path: str = DEFAULT_REPORT_PATH) -> list[str]:
    """Instructions for the LLM step that turns feed data into an HTML report.

    Philosophy: this is a CURATED digest, NOT an exhaustive listing. The user
    already has ghinbox to page through every notification; the report's only job
    is to surface the small set of things worth a human's attention plus a few
    prose "vibe" summaries of everything else. Do NOT enumerate every feed item.
    """
    return [
        f"Write a short, curated HTML feed report to {report_path} by default before replying.",
        "Do not stop at a chat-only summary unless the user explicitly asks for that.",
        "This is a DIGEST, not a full listing. The user can already page through every "
        "notification in ghinbox; do NOT reproduce that. Ruthlessly omit low-signal items.",
        "Structure the report in two parts:",
        "  1) 'Look at these' — a short, hand-picked list (aim for ~5-15 items, hard cap ~20) "
        "of notifications that genuinely warrant the user's attention. STRONGLY prefer OPEN items "
        "(report_items[].state == 'open'); a closed/merged item is resolved by default, so only "
        "surface one when there is a concrete live reason (e.g. it was reverted, reopened, or a "
        "human is explicitly waiting on the user). Prioritize the user's own delegated @claude tasks "
        "whose answers are now waiting, reply-nature items (report_items[].reply_nature / reply_signals), "
        "reverts/rollbacks, direct @-mentions from real humans (not bots), and anything unusual or "
        "high-stakes. Each gets a one-line 'why it matters' plus a GitHub link. If more than ~20 "
        "qualify, keep only the most important and say how many were omitted.",
        "  2) 'Overall vibe' — a few short prose paragraphs (LLM-generated) that characterize the "
        "rest of the feed thematically (e.g. 'lots of Dynamo/compiler churn', 'steady CI/testing "
        "activity', 'ROCm backend work'). Summaries ARE the value here; do NOT list the individual "
        "PRs/issues behind each theme. Link at most a couple of representative examples per theme.",
        "For the 'Look at these' list, include one 'Open all' button that opens those curated URLs "
        "in new tabs from a click handler, deriving URLs from links already in the DOM.",
        "Keep the report lightweight and fast to open from file://: no full JSON payload, no giant "
        "tables, no per-theme exhaustive item lists.",
        "Do not run --mark-done or imply anything was marked done; marking done is a separate explicit user action.",
        "After writing the report, tell the user the report path, the feed/reply-nature counts, and how "
        "many items you surfaced vs. summarized-only.",
    ]


def build_snapshot_health(snapshot_data: dict, notifications: list[dict]) -> dict:
    """Surface staleness signals so the digest never silently reports on a
    stale snapshot.

    Freshness is the reliable signal here. ``synced_at`` is when the server
    last rebuilt the snapshot from GitHub; if that is old, the feed has drifted
    from reality (new notifications never entered the snapshot) — re-sync first.

    Note we deliberately do NOT compare the server sync's
    ``notifications_count`` against the stored count: mark-done/archive prunes
    the stored ``data`` in place (remove_notifications_from_snapshots) without
    touching sync state, so a smaller stored count is the normal fingerprint of
    "archived a batch after the last sync", not a truncated save. That
    comparison produced false "truncated" warnings on every archive.
    """
    snap = snapshot_data.get("snapshot", {})
    sync = snapshot_data.get("sync", {})

    stored = len(notifications)
    synced_at = snap.get("synced_at")

    age_seconds: float | None = None
    if synced_at:
        try:
            synced_dt = datetime.fromisoformat(synced_at)
            if synced_dt.tzinfo is None:
                synced_dt = synced_dt.replace(tzinfo=timezone.utc)
            age_seconds = (datetime.now(timezone.utc) - synced_dt).total_seconds()
        except ValueError:
            pass

    warnings: list[str] = []
    if age_seconds is not None and age_seconds > STALE_SNAPSHOT_SECONDS:
        hours = age_seconds / 3600
        warnings.append(
            f"Snapshot is stale: last synced {hours:.1f}h ago ({synced_at}). "
            "New notifications since then are not in this digest; trigger a "
            "full sync (client UI or POST /api/snapshots/{owner}/{repo}/sync) "
            "before trusting it."
        )
    elif age_seconds is None:
        warnings.append("Snapshot has no synced_at timestamp; cannot verify freshness.")
    if sync.get("status") == "error":
        warnings.append(f"Last sync errored: {sync.get('error') or 'unknown error'}")

    return {
        "stored_count": stored,
        "synced_count": sync.get("notifications_count"),
        "pages_fetched": sync.get("pages_fetched"),
        "generated_at": snap.get("generated_at"),
        "synced_at": synced_at,
        "age_hours": round(age_seconds / 3600, 1) if age_seconds is not None else None,
        "sync_status": sync.get("status"),
        "warnings": warnings,
    }


def build_extract_output(
    snapshot_data: dict,
    report_path: str = DEFAULT_REPORT_PATH,
    *,
    current_user: str = DEFAULT_CURRENT_USER,
    repo: str = DEFAULT_REPO,
) -> dict:
    """Build the JSON payload consumed by the LLM summarization step."""
    snap = snapshot_data.get("snapshot", {})
    notifications = snap.get("notifications", [])
    comment_cache = snap.get("comment_cache", {})
    comment_threads = comment_cache.get("threads", {})
    authenticity_token = snap.get("authenticity_token", "")

    feed = classify_feed(notifications, comment_threads, current_user)
    reply_nature = find_reply_nature_in_feed(feed, comment_threads, current_user)
    reply_nature_ids = {n["id"] for n in reply_nature}
    formatted = format_for_llm(feed, comment_threads, reply_nature_ids)

    # Build reply-nature summary for the LLM
    reply_nature_summary = []
    for n in reply_nature:
        subj = n.get("subject", {})
        signals = n.get("_reply_signals", [])
        reply_nature_summary.append(
            {
                "number": subj.get("number"),
                "title": subj.get("title"),
                "signals": signals,
            }
        )

    return {
        "total_count": len(notifications),
        "feed_count": len(feed),
        "reply_nature_count": len(reply_nature),
        "snapshot_health": build_snapshot_health(snapshot_data, notifications),
        "feed_ids": [n["id"] for n in feed],
        "reply_nature_ids": sorted(reply_nature_ids),
        "reply_nature_summary": reply_nature_summary,
        "formatted_text": formatted,
        "report_path": report_path,
        "report_instructions": build_report_instructions(report_path),
        "report_items": build_report_items(
            feed,
            comment_threads,
            reply_nature_ids,
            repo,
        ),
        "authenticity_token": authenticity_token,
    }


def format_for_llm(
    feed_notifications: list[dict],
    comment_threads: dict,
    reply_nature_ids: set[str],
) -> str:
    """Format feed notifications as compact text for the LLM."""
    lines: list[str] = []
    for n in feed_notifications:
        nid = n["id"]
        subj = n.get("subject", {})
        title = subj.get("title", "???")
        stype = subj.get("type", "?")
        state = subj.get("state", "?")
        number = subj.get("number", "")
        reason = n.get("reason", "?")
        actors = ", ".join(a.get("login", "?") for a in n.get("actors", []))
        updated = n.get("updated_at", "?")

        thread = comment_threads.get(nid, {})
        comments = thread.get("comments", [])
        n_comments = len(comments)

        # Last 2 comment snippets for context
        comment_snippets: list[str] = []
        for c in comments[-2:]:
            author = c.get("user", {}).get("login", "?")
            body = (c.get("body") or "")[:200].replace("\n", " ").strip()
            if body:
                comment_snippets.append(f"  [{author}]: {body}")

        reply_tag = " [REPLY-NATURE]" if nid in reply_nature_ids else ""
        type_tag = "PR" if stype == "PullRequest" else stype
        line = f"#{number} [{type_tag}/{state}] {title}{reply_tag}"
        line += f"\n  reason={reason} actors={actors} updated={updated} comments={n_comments}"
        if comment_snippets:
            line += "\n" + "\n".join(comment_snippets)

        lines.append(line)

    return "\n\n".join(lines)


def _resolve_snapshot(
    *,
    profile: str | None,
    entries: list[str] | None,
    repo: str | None,
    socket_path: str,
    do_sync: bool,
) -> tuple[dict, str]:
    """Fetch the snapshot for the requested target (profile or single repo).

    Returns (snapshot_data, target_label). When ``do_sync`` is set, triggers a
    live server-side rebuild first (profile target only).
    """
    if repo:
        if do_sync:
            raise FeedDigestError(
                "--sync is only supported for profile targets, not --repo."
            )
        return fetch_snapshot(repo, socket_path), f"repo {repo}"

    target_profile = profile or DEFAULT_PROFILE
    if do_sync:
        print(
            f"Triggering server sync for profile {target_profile!r}…", file=sys.stderr
        )
        sync_profile_snapshot(target_profile, entries, socket_path)
    return fetch_profile_snapshot(target_profile, socket_path), (
        f"profile {target_profile}"
    )


def do_extract(
    *,
    profile: str | None = None,
    entries: list[str] | None = None,
    repo: str | None = None,
    current_user: str = DEFAULT_CURRENT_USER,
    socket_path: str = DEFAULT_SOCKET_PATH,
    do_sync: bool = False,
) -> None:
    """Extract feed data and output JSON to stdout."""
    snapshot_data, target_label = _resolve_snapshot(
        profile=profile,
        entries=entries,
        repo=repo,
        socket_path=socket_path,
        do_sync=do_sync,
    )
    output = build_extract_output(
        snapshot_data,
        current_user=current_user,
        repo=repo or DEFAULT_REPO,
    )

    health = output["snapshot_health"]
    print(f"Target: {target_label}", file=sys.stderr)
    print(f"Total notifications: {output['total_count']}", file=sys.stderr)
    print(f"Feed notifications: {output['feed_count']}", file=sys.stderr)
    print(
        f"Reply-nature items in feed: {output['reply_nature_count']}",
        file=sys.stderr,
    )
    print(
        f"Snapshot synced_at: {health.get('synced_at')} "
        f"(status={health.get('sync_status')})",
        file=sys.stderr,
    )
    for warning in health.get("warnings", []):
        print(f"WARNING: {warning}", file=sys.stderr)
    print(f"HTML report target: {output['report_path']}", file=sys.stderr)
    json.dump(output, sys.stdout, indent=2)


def do_mark_done(
    exclude_ids: list[str] | None = None,
    *,
    profile: str | None = None,
    repo: str | None = None,
    current_user: str = DEFAULT_CURRENT_USER,
    socket_path: str = DEFAULT_SOCKET_PATH,
) -> None:
    """Mark feed notifications as done, excluding specified IDs."""
    snapshot_data, _ = _resolve_snapshot(
        profile=profile,
        entries=None,
        repo=repo,
        socket_path=socket_path,
        do_sync=False,
    )
    snap = snapshot_data.get("snapshot", {})
    notifications = snap.get("notifications", [])
    comment_cache = snap.get("comment_cache", {})
    comment_threads = comment_cache.get("threads", {})
    authenticity_token = snap.get("authenticity_token", "")

    feed = classify_feed(notifications, comment_threads, current_user)
    exclude = set(exclude_ids or [])
    ids_to_mark = [n["id"] for n in feed if n["id"] not in exclude]

    print(
        f"Marking {len(ids_to_mark)} notifications as done "
        f"(excluding {len(exclude)} IDs)...",
        file=sys.stderr,
    )

    if not ids_to_mark:
        print("Nothing to mark.", file=sys.stderr)
        return

    with _debug_client(socket_path) as client:
        chunk_size = 25
        for i in range(0, len(ids_to_mark), chunk_size):
            chunk = ids_to_mark[i : i + chunk_size]
            resp = client.post(
                ACTION_URL,
                json={
                    "action": "archive",
                    "notification_ids": chunk,
                    "authenticity_token": authenticity_token,
                },
            )
            resp.raise_for_status()
            result = resp.json()
            if result.get("status") != "ok":
                print(
                    f"  Warning: batch {i // chunk_size + 1} failed: "
                    f"{result.get('error')}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"  Marked done: batch {i // chunk_size + 1} "
                    f"({len(chunk)} notifications)",
                    file=sys.stderr,
                )

    print("Done!", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Feed Digest — extract/mark-done")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--extract", action="store_true", help="Extract feed data as JSON to stdout"
    )
    group.add_argument(
        "--mark-done", action="store_true", help="Mark feed notifications as done"
    )
    parser.add_argument(
        "--exclude-ids",
        type=str,
        default="",
        help="Comma-separated notification IDs to exclude from mark-done",
    )
    parser.add_argument(
        "--socket-path",
        default=DEFAULT_SOCKET_PATH,
        help=f"ghinbox debug Unix socket path (default: {DEFAULT_SOCKET_PATH})",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help=(
            "Profile snapshot key to target (default: "
            f"{DEFAULT_PROFILE!r}). Ignored when --repo is given."
        ),
    )
    parser.add_argument(
        "--entries",
        default=None,
        help=(
            "Comma-separated profile entries to sync (default: "
            f"{','.join(DEFAULT_PROFILE_ENTRIES)}). Only used with --sync."
        ),
    )
    parser.add_argument(
        "--sync",
        action="store_true",
        help=(
            "Trigger a live server-side profile sync before extracting "
            "(profile target only). This hits GitHub."
        ),
    )
    parser.add_argument(
        "--repo",
        default=None,
        help="Single-repo snapshot key (owner/repo) instead of a profile.",
    )
    parser.add_argument(
        "--current-user",
        default=DEFAULT_CURRENT_USER,
        help=f"GitHub login used for Feed/Replies classification (default: {DEFAULT_CURRENT_USER})",
    )

    args = parser.parse_args()

    entries = (
        [e.strip() for e in args.entries.split(",") if e.strip()]
        if args.entries
        else None
    )

    try:
        if args.extract:
            do_extract(
                profile=args.profile,
                entries=entries,
                repo=args.repo,
                current_user=args.current_user,
                socket_path=args.socket_path,
                do_sync=args.sync,
            )
        elif args.mark_done:
            exclude = [x.strip() for x in args.exclude_ids.split(",") if x.strip()]
            do_mark_done(
                exclude,
                profile=args.profile,
                repo=args.repo,
                current_user=args.current_user,
                socket_path=args.socket_path,
            )
    except FeedDigestError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
