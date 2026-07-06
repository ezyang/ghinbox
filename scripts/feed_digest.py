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
DEFAULT_REPORT_PATH = "/tmp/feed-report.html"


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
    Classify notifications into the Feed queue.

    Matches the webapp's matchesView('issues') logic:
    Feed = NOT review-queue AND NOT directed-at-current-user.
    """
    feed = []
    for n in notifications:
        if _is_review_queue(n):
            continue
        thread = comment_threads.get(n["id"], {})
        comments = thread.get("comments", [])
        state_events = thread.get("stateEvents", [])
        if _is_directed_at_current_user(n, comments, state_events, CURRENT_USER):
            continue
        feed.append(n)

    return feed


# ---------------------------------------------------------------------------
# Review-queue classification
# ---------------------------------------------------------------------------


def _is_review_queue(n: dict) -> bool:
    """A notification is in the review queue if it's a PR with review-requested reason."""
    if (n.get("subject") or {}).get("type") != "PullRequest":
        return False
    reason = (n.get("reason") or "").lower()
    if reason in ("review_requested", "review requested"):
        return True
    if n.get("responsibility_source") == "review-requested":
        return True
    return False


# ---------------------------------------------------------------------------
# "Directed at current user" — port of the webapp's
# isNotificationDirectedAtCurrentUser from notifications-comment-interest.js
# ---------------------------------------------------------------------------

_KNOWN_BOTS = frozenset(
    [
        "dr-ci",
        "dr-ci-bot",
        "bors",
        "homu",
        "mergify",
        "pytorchbot",
        "pytorchmergebot",
        "pytorch-bot",
        "htmlpurifierbot",
        "github-actions",
        "dependabot",
        "dependabot-preview",
    ]
)

_BOT_COMMAND_RE = None  # lazily compiled


def _is_bot_author(login: str) -> bool:
    normalized = (login or "").strip().lower()
    if not normalized:
        return False
    if normalized.endswith("[bot]"):
        return True
    return normalized in _KNOWN_BOTS


def _is_bot_interaction_comment(body: str) -> bool:
    global _BOT_COMMAND_RE
    import re

    if _BOT_COMMAND_RE is None:
        cmds = (
            r"label|unlabel|merge|close|reopen|rebase|retry|rerun|retest|"
            r"backport|cherry-pick|assign|unassign|cc|triage|priority|"
            r"kind|lgtm|r\+"
        )
        _BOT_COMMAND_RE = [
            re.compile(rf"^/(?:{cmds})(?:\s|$)", re.I),
            re.compile(rf"^@?[\w-]*bot\b\s+(?:{cmds})(?:\s|$)", re.I),
            re.compile(r"^bors\b", re.I),
            re.compile(r"^@?bors\b", re.I),
            re.compile(r"^@?homu\b", re.I),
            re.compile(r"^@?mergify\b", re.I),
            re.compile(r"^@?dr[-.\s]?ci\b", re.I),
            re.compile(r"^r\+$", re.I),
        ]
    lines = [ln.strip() for ln in (body or "").splitlines() if ln.strip()]
    if not lines:
        return False
    return all(any(pat.search(ln) for pat in _BOT_COMMAND_RE) for ln in lines)


def _is_uninteresting_comment(comment: dict) -> bool:
    import re

    body = comment.get("body") or ""
    if re.search(r"\brevert(?:ed|ing)?\b", body, re.I) or re.search(
        r"\brollback\b", body, re.I
    ):
        return False
    author = (comment.get("user") or {}).get("login", "")
    if _is_bot_author(author):
        return True
    return _is_bot_interaction_comment(body)


def _parse_timestamp(ts: str | None) -> float | None:
    from datetime import datetime

    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp() * 1000  # ms like JS Date.parse
    except (ValueError, AttributeError):
        return None


def _comment_timestamp_ms(comment: dict) -> float:
    ts = comment.get("created_at") or comment.get("updated_at")
    return _parse_timestamp(ts) or 0.0


def _is_closed_or_merged(n: dict) -> bool:
    state = ((n.get("subject") or {}).get("state") or "").lower()
    return state in ("closed", "merged")


def _get_latest_close_event_ms(state_events: list[dict]) -> float | None:
    latest: float | None = None
    for ev in state_events:
        event_name = (ev.get("event") or ev.get("type") or "").lower()
        is_closing = event_name in ("closed", "merged")
        if not is_closing and event_name in ("state_change", "state-change"):
            to_state = (
                ev.get("state") or ev.get("to_state") or ev.get("to") or ""
            ).lower()
            is_closing = to_state in ("closed", "merged")
        if not is_closing:
            continue
        ts = _parse_timestamp(ev.get("created_at") or ev.get("updated_at"))
        if ts is not None:
            latest = max(latest, ts) if latest is not None else ts
    return latest


def _mentions_user(text: str, login: str) -> bool:
    import re

    if not text or not login:
        return False
    escaped = re.escape(login)
    return bool(
        re.search(rf"(?:^|[^A-Za-z0-9-])@{escaped}(?![A-Za-z0-9-])", text, re.I)
    )


def _is_cc_line(line: str, login: str) -> bool:
    import re

    text = line.strip()
    if not re.match(r"^cc:?\s+", text, re.I):
        return False
    return _mentions_user(text, login)


def _has_actionable_mention(comment: dict, login: str) -> bool:
    body = comment.get("body") or ""
    if not _mentions_user(body, login):
        return False
    # For issue comments, filter out CC-only lines
    if not comment.get("isIssue"):
        return True
    mentioned_lines = [ln for ln in body.splitlines() if _mentions_user(ln, login)]
    return any(not _is_cc_line(ln, login) for ln in mentioned_lines)


def _get_review_thread_key(comment: dict) -> str | None:
    if not comment.get("isReviewComment"):
        return None
    root_id = comment.get("in_reply_to_id") or comment.get("id")
    return str(root_id) if root_id is not None else None


def _get_direct_review_thread_replies(comments: list[dict], login: str) -> list[dict]:
    login = login.lower()
    by_thread: dict[str, list[tuple[dict, int]]] = {}
    for idx, c in enumerate(comments):
        key = _get_review_thread_key(c)
        if key is None:
            continue
        by_thread.setdefault(key, []).append((c, idx))

    replies = []
    for thread in by_thread.values():
        last_own_idx = -1
        for i, (c, _) in enumerate(thread):
            author = ((c.get("user") or {}).get("login") or "").lower()
            if author == login:
                last_own_idx = i
        if last_own_idx == -1:
            continue
        for c, _ in thread[last_own_idx + 1 :]:
            author = ((c.get("user") or {}).get("login") or "").lower()
            if author and author != login:
                replies.append(c)

    replies.sort(key=lambda c: _comment_timestamp_ms(c))
    return replies


def _is_directed_at_current_user(
    notification: dict,
    comments: list[dict],
    state_events: list[dict],
    current_user: str,
) -> bool:
    """
    Port of the webapp's isNotificationDirectedAtCurrentUser.

    Returns True if the notification should go to Replies (not Feed).
    """
    login = current_user.lower()
    if not login:
        return False

    # Sort comments by timestamp
    sorted_comments = sorted(
        comments, key=lambda c: (_comment_timestamp_ms(c), c.get("id") or 0)
    )
    if not sorted_comments:
        return False

    last_read_at_ms = _parse_timestamp(notification.get("last_read_at"))

    def is_unread(c: dict) -> bool:
        ts = _comment_timestamp_ms(c)
        return last_read_at_ms is None or ts > last_read_at_ms

    # For closed/merged notifications, only consider comments after close event
    latest_close_ms = None
    if _is_closed_or_merged(notification):
        latest_close_ms = _get_latest_close_event_ms(state_events)
        if latest_close_ms is None:
            return False

    def is_after_close(c: dict) -> bool:
        if latest_close_ms is None:
            return True
        return _comment_timestamp_ms(c) > latest_close_ms

    def is_interesting_unread(c: dict) -> bool:
        return is_unread(c) and not _is_uninteresting_comment(c) and is_after_close(c)

    # Check 1: direct review thread replies to user's review comments
    if any(
        is_interesting_unread(c)
        for c in _get_direct_review_thread_replies(sorted_comments, login)
    ):
        return True

    # Check 2: author-type notifications with unread comments from others
    has_unread_from_other = any(
        is_interesting_unread(c)
        and ((c.get("user") or {}).get("login") or "").lower() not in ("", login)
        for c in sorted_comments
    )

    reason = (notification.get("reason") or "").lower()
    subj_type = (notification.get("subject") or {}).get("type")
    if (
        subj_type in ("Issue", "PullRequest")
        and reason == "author"
        and has_unread_from_other
    ):
        return True

    # Check 3: actionable @-mentions in comments, and issue main-thread replies
    for i, c in enumerate(sorted_comments):
        if not is_interesting_unread(c):
            continue
        if _has_actionable_mention(c, current_user):
            return True
        # Issue main-thread reply: user commented, next main-thread comment is from other
        if subj_type != "Issue":
            continue
        if c.get("isReviewComment"):
            continue
        author = ((c.get("user") or {}).get("login") or "").lower()
        if not author or author == login:
            continue
        # Find previous main-thread comment
        prev_main = None
        for j in range(i - 1, -1, -1):
            if not sorted_comments[j].get("isReviewComment"):
                prev_main = sorted_comments[j]
                break
        if prev_main:
            prev_author = ((prev_main.get("user") or {}).get("login") or "").lower()
            if prev_author == login:
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


def _compact_text(text: str, max_chars: int = 240) -> str:
    collapsed = " ".join((text or "").split())
    if len(collapsed) <= max_chars:
        return collapsed
    return collapsed[: max_chars - 3].rstrip() + "..."


def _subject_type_label(subject_type: str | None) -> str:
    if subject_type == "PullRequest":
        return "PR"
    return subject_type or "?"


def _notification_url(notification: dict) -> str:
    subject = notification.get("subject") or {}
    url = subject.get("url")
    if url:
        return str(url)

    number = subject.get("number")
    if number:
        path = "pull" if subject.get("type") == "PullRequest" else "issues"
        return f"https://github.com/{REPO}/{path}/{number}"

    return f"https://github.com/{REPO}"


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
                "url": _notification_url(n),
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
) -> dict:
    """Build the JSON payload consumed by the LLM summarization step."""
    snap = snapshot_data.get("snapshot", {})
    notifications = snap.get("notifications", [])
    comment_cache = snap.get("comment_cache", {})
    comment_threads = comment_cache.get("threads", {})
    authenticity_token = snap.get("authenticity_token", "")

    feed = classify_feed(notifications, comment_threads)
    reply_nature = find_reply_nature_in_feed(feed, comment_threads)
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
        "report_items": build_report_items(feed, comment_threads, reply_nature_ids),
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


def do_extract() -> None:
    """Extract feed data and output JSON to stdout."""
    output = build_extract_output(fetch_snapshot())

    print(f"Total notifications: {output['total_count']}", file=sys.stderr)
    print(f"Feed notifications: {output['feed_count']}", file=sys.stderr)
    print(
        f"Reply-nature items in feed: {output['reply_nature_count']}",
        file=sys.stderr,
    )
    print(f"HTML report target: {output['report_path']}", file=sys.stderr)
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
