#!/usr/bin/env python3
"""
Feed Digest — extract and format Feed notifications for LLM summarization.

Usage (two-step flow, run from repo root):

    # Step 1: Extract feed data to JSON
    uv run python scripts/feed_digest.py --extract > /tmp/feed_data.json

    # Step 2: Feed the JSON to a Claude Code subagent for summarization
    #         (done by the caller — see scripts/feed_digest_skill below)

    # Step 3: Mark done (after reviewing the digest)
    uv run python scripts/feed_digest.py --mark-done [--exclude-ids id1,id2,...]

The Feed queue contains notifications that are NOT directed at the current user
(replies) and NOT review requests. These are the "ambient awareness" items.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys

import httpx


SOCKET_PATH = "auth_state/ghinbox-debug.sock"
ACTION_URL = "http://ghinbox/notifications/html/action"
DB_PATH = "auth_state/ghinbox_snapshots.db"
REPO = "pytorch/pytorch"
CURRENT_USER = "ezyang"


def fetch_snapshot() -> dict:
    """Read snapshot directly from SQLite (faster than the HTTP API for large snapshots)."""
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT data, comment_cache, authenticity_token FROM notification_snapshots WHERE repo = ?",
        (REPO,),
    ).fetchone()
    conn.close()
    if not row:
        print(f"No snapshot found for {REPO}", file=sys.stderr)
        sys.exit(1)
    data_json, cc_json, auth_token = row
    return {
        "snapshot": {
            "notifications": json.loads(data_json),
            "comment_cache": json.loads(cc_json) if cc_json else {},
            "authenticity_token": auth_token or "",
        }
    }


def classify_feed(notifications: list[dict], comment_threads: dict) -> list[dict]:
    """
    Classify notifications into the Feed queue (server-side approximation).

    Feed = NOT review-queue AND NOT directed-at-current-user.
    """
    feed = []
    for n in notifications:
        reason = (n.get("reason") or "").lower()

        # Skip review queue items
        if reason in ("review_requested", "review requested"):
            continue
        if n.get("responsibility_source") == "review-requested":
            continue

        # Skip items directed at current user
        if reason == "author":
            continue
        if reason == "mention":
            continue

        # Check comment-level "directed at user" — direct replies to user's comments
        thread = comment_threads.get(n["id"], {})
        comments = thread.get("comments", [])
        if _has_direct_reply_to_user(n, comments, CURRENT_USER):
            continue

        feed.append(n)

    return feed


def _has_direct_reply_to_user(
    notification: dict, comments: list[dict], current_user: str
) -> bool:
    """Check if any unread comment is a direct reply to the current user."""
    last_read_at = notification.get("last_read_at") or ""
    user_lower = current_user.lower()

    user_comment_ids = set()
    for c in comments:
        author = (c.get("user", {}).get("login") or "").lower()
        if author == user_lower:
            user_comment_ids.add(c.get("id"))

    if not user_comment_ids:
        return False

    for c in comments:
        author = (c.get("user", {}).get("login") or "").lower()
        if author == user_lower:
            continue
        created = c.get("created_at") or c.get("createdAt") or ""
        if last_read_at and created <= last_read_at:
            continue
        reply_to = c.get("in_reply_to_id")
        if reply_to and reply_to in user_comment_ids:
            return True

    return False


def find_reply_nature_in_feed(
    feed_notifications: list[dict], comment_threads: dict
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
    user_lower = CURRENT_USER.lower()

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


def do_extract() -> None:
    """Extract feed data and output JSON to stdout."""
    snapshot_data = fetch_snapshot()
    snap = snapshot_data.get("snapshot", {})
    notifications = snap.get("notifications", [])
    comment_cache = snap.get("comment_cache", {})
    comment_threads = comment_cache.get("threads", {})
    authenticity_token = snap.get("authenticity_token", "")

    print(f"Total notifications: {len(notifications)}", file=sys.stderr)

    feed = classify_feed(notifications, comment_threads)
    print(f"Feed notifications: {len(feed)}", file=sys.stderr)

    reply_nature = find_reply_nature_in_feed(feed, comment_threads)
    reply_nature_ids = {n["id"] for n in reply_nature}
    print(f"Reply-nature items in feed: {len(reply_nature)}", file=sys.stderr)

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

    output = {
        "feed_count": len(feed),
        "reply_nature_count": len(reply_nature),
        "feed_ids": [n["id"] for n in feed],
        "reply_nature_ids": list(reply_nature_ids),
        "reply_nature_summary": reply_nature_summary,
        "formatted_text": formatted,
        "authenticity_token": authenticity_token,
    }
    json.dump(output, sys.stdout, indent=2)


def do_mark_done(exclude_ids: list[str] | None = None) -> None:
    """Mark feed notifications as done, excluding specified IDs."""
    snapshot_data = fetch_snapshot()
    snap = snapshot_data.get("snapshot", {})
    notifications = snap.get("notifications", [])
    comment_cache = snap.get("comment_cache", {})
    comment_threads = comment_cache.get("threads", {})
    authenticity_token = snap.get("authenticity_token", "")

    feed = classify_feed(notifications, comment_threads)
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

    transport = httpx.HTTPTransport(uds=SOCKET_PATH)
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

    args = parser.parse_args()

    if args.extract:
        do_extract()
    elif args.mark_done:
        exclude = [x.strip() for x in args.exclude_ids.split(",") if x.strip()]
        do_mark_done(exclude)


if __name__ == "__main__":
    main()
