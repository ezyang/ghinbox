#!/usr/bin/env python3
"""
Feed Digest — extract and format Feed notifications for LLM summarization.

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

The Feed queue contains notifications that are NOT directed at the current user
(replies) and NOT review requests. These are the "ambient awareness" items.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import httpx


DEFAULT_SOCKET_PATH = "auth_state/ghinbox-debug.sock"
ACTION_URL = "http://ghinbox/notifications/html/action"
DEFAULT_DB_PATH = "auth_state/ghinbox_snapshots.db"
DEFAULT_REPO = "pytorch/pytorch"
DEFAULT_CURRENT_USER = "ezyang"
DEFAULT_REPORT_PATH = "/tmp/feed-report.html"
CLASSIFIER_SCRIPT = Path(__file__).with_name("feed_digest_classify.js")


class FeedDigestError(RuntimeError):
    """Raised for expected feed digest failures that should be user-readable."""


def _sqlite_readonly_uri(db_path: str) -> str:
    if db_path.startswith("file:"):
        return db_path
    path = Path(db_path).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve(strict=False).as_uri() + "?mode=ro"


def fetch_snapshot(
    db_path: str = DEFAULT_DB_PATH,
    repo: str = DEFAULT_REPO,
) -> dict:
    """Read snapshot directly from SQLite (faster than the HTTP API for large snapshots)."""
    try:
        conn = sqlite3.connect(_sqlite_readonly_uri(db_path), uri=True)
    except sqlite3.Error as exc:
        raise FeedDigestError(f"Unable to open snapshot DB {db_path!r}: {exc}") from exc

    try:
        row = conn.execute(
            "SELECT data, comment_cache, authenticity_token "
            "FROM notification_snapshots WHERE repo = ?",
            (repo,),
        ).fetchone()
    except sqlite3.Error as exc:
        raise FeedDigestError(f"Unable to read snapshot DB {db_path!r}: {exc}") from exc
    finally:
        conn.close()

    if not row:
        raise FeedDigestError(f"No snapshot found for {repo} in {db_path}")
    data_json, cc_json, auth_token = row
    return {
        "snapshot": {
            "notifications": json.loads(data_json),
            "comment_cache": json.loads(cc_json) if cc_json else {},
            "authenticity_token": auth_token or "",
        }
    }


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
    - Someone @-mentioned the user in a comment body
    - The user commented and someone (non-bot) replied after their last comment
    """
    reply_nature = []
    user_lower = current_user.lower()

    for n in feed_notifications:
        thread = comment_threads.get(n["id"], {})
        comments = thread.get("comments", [])

        reply_signals = []

        # Signal 1: @-mention in comment body
        for c in comments:
            author = (c.get("user", {}).get("login") or "").lower()
            if author == user_lower:
                continue
            body = (c.get("body") or "").lower()
            if f"@{user_lower}" in body:
                reply_signals.append(f"@-mentioned by {author}")
                break

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

    number = subject.get("number")
    if number:
        path = "pull" if subject.get("type") == "PullRequest" else "issues"
        return f"https://github.com/{repo}/{path}/{number}"

    return f"https://github.com/{repo}"


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


def do_extract(
    db_path: str = DEFAULT_DB_PATH,
    repo: str = DEFAULT_REPO,
    current_user: str = DEFAULT_CURRENT_USER,
) -> None:
    """Extract feed data and output JSON to stdout."""
    output = build_extract_output(
        fetch_snapshot(db_path, repo),
        current_user=current_user,
        repo=repo,
    )

    print(f"Total notifications: {output['total_count']}", file=sys.stderr)
    print(f"Feed notifications: {output['feed_count']}", file=sys.stderr)
    print(
        f"Reply-nature items in feed: {output['reply_nature_count']}",
        file=sys.stderr,
    )
    print(f"HTML report target: {output['report_path']}", file=sys.stderr)
    json.dump(output, sys.stdout, indent=2)


def do_mark_done(
    exclude_ids: list[str] | None = None,
    db_path: str = DEFAULT_DB_PATH,
    repo: str = DEFAULT_REPO,
    current_user: str = DEFAULT_CURRENT_USER,
) -> None:
    """Mark feed notifications as done, excluding specified IDs."""
    snapshot_data = fetch_snapshot(db_path, repo)
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

    transport = httpx.HTTPTransport(uds=DEFAULT_SOCKET_PATH)
    with httpx.Client(transport=transport, timeout=60) as client:
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
        "--db-path",
        default=DEFAULT_DB_PATH,
        help=f"SQLite snapshot DB path (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"Repository snapshot key (default: {DEFAULT_REPO})",
    )
    parser.add_argument(
        "--current-user",
        default=DEFAULT_CURRENT_USER,
        help=f"GitHub login used for Feed/Replies classification (default: {DEFAULT_CURRENT_USER})",
    )

    args = parser.parse_args()

    try:
        if args.extract:
            do_extract(args.db_path, args.repo, args.current_user)
        elif args.mark_done:
            exclude = [x.strip() for x in args.exclude_ids.split(",") if x.strip()]
            do_mark_done(exclude, args.db_path, args.repo, args.current_user)
    except FeedDigestError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
