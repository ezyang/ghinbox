"""Tests for the background feed digest worker, prompts, and routes."""

import asyncio
import json
import os
import shlex
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from ghinbox.api import digest_routes
from ghinbox.api.fetcher import ActionResult
from ghinbox.api.snapshot_store import (
    get_snapshot,
    init_snapshot_db,
    remove_notifications_from_snapshots,
    save_snapshot,
)
from ghinbox.digest.feed import mention_signal
from ghinbox.digest import prompts, worker
from ghinbox.digest.store import (
    get_digest_state,
    get_item_notes,
    get_llm_usage,
    init_digest_db,
    save_item_notes,
    update_digest_state,
)
from ghinbox.api.notification_shapes import utc_now_iso

PROFILE = "pytorch"
KEY = f"profile:{PROFILE}"


@pytest.fixture
def db_path(monkeypatch: pytest.MonkeyPatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setenv("GHINBOX_SNAPSHOT_DB_PATH", path)
    # Tests opt into auto-done explicitly with a fake archiver.
    monkeypatch.setenv("GHINBOX_DIGEST_AUTO_DONE", "0")
    init_snapshot_db(path)
    init_digest_db(path)
    yield path
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass


def _notification(nid: str, number: int, updated_at: str, **extra) -> dict:
    return {
        "id": nid,
        "reason": "mention",
        "updated_at": updated_at,
        "repository": {"full_name": "pytorch/pytorch"},
        "subject": {
            "title": f"Ambient issue {number}",
            "type": "Issue",
            "number": number,
            "state": "open",
        },
        "actors": [{"login": "alice"}],
        "labels": [],
        **extra,
    }


REVIEW = _notification(
    "review-pr", 9, "2026-09-01T00:00:00Z", reason="review_requested"
)
REVIEW["subject"]["type"] = "PullRequest"


def _save(notifications: list[dict], db_path: str) -> None:
    save_snapshot(
        KEY,
        notifications,
        comment_cache={"version": 1, "threads": {}},
        db_path=db_path,
    )


class FakeLlm:
    """Answers triage prompts from ``attention`` and records every prompt."""

    def __init__(self, attention: dict[str, str] | None = None) -> None:
        self.attention = attention or {}
        self.prompts: list[str] = []

    async def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        items = (
            json.loads(prompt.rsplit("\n", 1)[-1]) if "Items (JSON)" in prompt else []
        )
        if items:
            return "banner line\n" + json.dumps(
                {
                    "items": [
                        {
                            "id": item["id"],
                            "attention": self.attention.get(item["id"], "low"),
                            "theme": "Dynamo",
                            "summary": f"summary of {item['id']}",
                            "why": "worth it",
                        }
                        for item in items
                    ]
                }
            )
        item_lines = prompt.split("summary | why):\n", 1)[1].splitlines()
        ids = [line.split(" | ")[0] for line in item_lines]
        return (
            "```json\n"
            + json.dumps(
                {
                    "vibe": [
                        {
                            "title": "Dynamo",
                            "text": "Busy week.",
                            "example_ids": ids + ["invented"],
                        },
                    ],
                }
            )
            + "\n```"
        )

    @property
    def triage_calls(self) -> int:
        return sum("Items (JSON)" in prompt for prompt in self.prompts)

    @property
    def compose_calls(self) -> int:
        return len(self.prompts) - self.triage_calls


def test_extract_json_object_skips_banners_and_fences() -> None:
    text = 'Loaded {config}\n```json\n{"items": [{"id": "1"}]}\n```'
    assert prompts.extract_json_object(text) == {"items": [{"id": "1"}]}
    with pytest.raises(ValueError):
        prompts.extract_json_object("no json here")


def test_parse_triage_response_validates_and_backfills() -> None:
    items = [
        {"id": "a", "title": "A", "updated_at": "t1"},
        {"id": "b", "title": "B", "updated_at": "t2"},
    ]
    notes = prompts.parse_triage_response(
        {
            "items": [
                {"id": "a", "attention": "HIGH", "theme": "x", "why": "ping"},
                {"id": "a", "attention": "low"},  # duplicate ignored
                {"id": "zzz", "attention": "high"},  # unknown id ignored
                "garbage",
            ]
        },
        items,
    )
    assert notes["a"]["attention"] == "high"
    assert notes["a"]["why"] == "ping"
    assert notes["a"]["summary"] == "A"
    # Skipped items still get a note so the queue drains.
    assert notes["b"] == {
        "updated_at": "t2",
        "attention": "low",
        "theme": "misc",
        "summary": "B",
        "why": "",
    }


def test_parse_compose_response_caps_and_drops_unknown_ids() -> None:
    known = {str(n) for n in range(30)}
    digest = prompts.parse_compose_response(
        {
            "vibe": [
                {"title": "t", "text": "p", "example_ids": ["1", "nope", "2", "3"]},
                {"title": "empty", "text": ""},
            ]
            + [{"title": "x", "text": "q"}] * 20,
        },
        known,
    )
    assert digest["vibe"][0] == {"title": "t", "text": "p", "example_ids": ["1", "2"]}
    assert len(digest["vibe"]) == prompts.MAX_VIBE_THEMES


def test_update_digest_triages_new_items_and_composes(db_path: str) -> None:
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
            REVIEW,
        ],
        db_path,
    )
    llm = FakeLlm({"n-1": "high"})

    state = asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))

    assert (llm.triage_calls, llm.compose_calls) == (1, 1)
    # Review requests are not Feed items and never reach the LLM.
    assert "review-pr" not in llm.prompts[0]
    notes = get_item_notes(PROFILE)
    assert set(notes) == {"n-1", "n-2"}
    # "High" attention is what surfaces an item in "Look at these".
    assert notes["n-1"]["surfaced"] is True
    assert "surfaced" not in notes["n-2"]
    assert state["pending_count"] == 0
    assert state["counts"]["feed_count"] == 2
    assert state["digest"] == {
        "vibe": [
            {"title": "Dynamo", "text": "Busy week.", "example_ids": ["n-1", "n-2"]}
        ]
    }

    # Nothing changed: no LLM calls at all.
    asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))
    assert len(llm.prompts) == 2


def test_update_digest_retriages_only_updated_items_and_prunes(db_path: str) -> None:
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    llm = FakeLlm()
    asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))

    # n-1 got new activity, n-2 left the Feed (marked done on GitHub).
    _save([_notification("n-1", 1, "2026-09-02T00:00:00Z")], db_path)
    llm.prompts.clear()
    state = asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))

    # Triage runs every pass; composing waits for the daily interval.
    assert (llm.triage_calls, llm.compose_calls) == (1, 0)
    assert '"id": "n-1"' in llm.prompts[0]
    assert '"n-2"' not in llm.prompts[0]
    assert get_item_notes(PROFILE)["n-1"]["updated_at"] == "2026-09-02T00:00:00Z"
    assert "n-2" not in get_item_notes(PROFILE)
    assert state["counts"]["feed_count"] == 1


def _comment(author: str, created_at: str, body: str, **extra) -> dict:
    return {
        "user": {"login": author, "type": extra.pop("user_type", "User")},
        "created_at": created_at,
        "body": body,
        **extra,
    }


def test_triage_sees_body_first_then_only_new_comments(db_path: str) -> None:
    thread = {
        "comments": [
            _comment("alice", "2026-09-01T00:00:00Z", "Body text " * 200, isIssue=True),
            _comment("bob", "2026-09-01T01:00:00Z", "early question"),
            _comment("spammer", "2026-09-01T02:00:00Z", "hidden", minimized=True),
            _comment(
                "pytorch-bot[bot]",
                "2026-09-01T03:00:00Z",
                "CI report " * 100,
                user_type="Bot",
            ),
        ]
    }

    def save(updated_at: str) -> None:
        save_snapshot(
            KEY,
            [_notification("n-1", 1, updated_at)],
            comment_cache={"version": 1, "threads": {"n-1": thread}},
            db_path=db_path,
        )

    def triaged_items(llm: FakeLlm) -> list[dict]:
        return json.loads(llm.prompts[0].rsplit("\n", 1)[-1])

    save("2026-09-01T03:00:00Z")
    llm = FakeLlm()
    asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))
    [first] = triaged_items(llm)
    assert first["body"].startswith("Body text")
    assert len(first["body"]) == worker.TRIAGE_BODY_CHARS
    assert "previous_summary" not in first
    # Minimized comments are dropped; bot comments get a short excerpt.
    assert [c["author"] for c in first["snippets"]] == ["bob", "pytorch-bot[bot]"]
    assert len(first["snippets"][1]["body"]) == worker.TRIAGE_BOT_COMMENT_CHARS

    thread["comments"].append(
        _comment("carol", "2026-09-02T00:00:00Z", "any update on this?")
    )
    save("2026-09-02T00:00:00Z")
    llm = FakeLlm()
    asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))
    [again] = triaged_items(llm)
    assert "body" not in again
    assert again["previous_summary"] == "summary of n-1"
    assert again["snippets"] == [
        {
            "author": "carol",
            "at": "2026-09-02T00:00:00Z",
            "body": "any update on this?",
        }
    ]


def test_update_digest_bounds_triage_batches_per_pass(
    db_path: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(worker, "TRIAGE_BATCH_SIZE", 2)
    monkeypatch.setattr(worker, "MAX_TRIAGE_BATCHES_PER_RUN", 1)
    _save(
        [_notification(f"n-{i}", i, "2026-09-01T00:00:00Z") for i in range(1, 6)],
        db_path,
    )
    llm = FakeLlm()

    state = asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))

    assert llm.triage_calls == 1
    assert state["pending_count"] == 3

    async def drain() -> None:
        worker.schedule_digest_update(PROFILE, llm=llm)
        while worker.is_digest_running(PROFILE):
            await asyncio.sleep(0)

    asyncio.run(drain())
    assert get_digest_state(PROFILE)["pending_count"] == 0
    assert len(get_item_notes(PROFILE)) == 5


def test_worker_records_llm_failure(db_path: str) -> None:
    _save([_notification("n-1", 1, "2026-09-01T00:00:00Z")], db_path)

    async def broken_llm(prompt: str) -> str:
        raise worker.DigestError("model unavailable")

    async def run() -> None:
        worker.schedule_digest_update(PROFILE, llm=broken_llm)
        while worker.is_digest_running(PROFILE):
            await asyncio.sleep(0)

    asyncio.run(run())
    state = get_digest_state(PROFILE)
    assert state["status"] == "error"
    assert state["error"] == "model unavailable"


def test_run_llm_uses_configured_command(monkeypatch: pytest.MonkeyPatch) -> None:
    script = "import sys; data = sys.stdin.read(); print('banner'); print(data.upper())"
    monkeypatch.setenv(
        "GHINBOX_DIGEST_LLM_COMMAND",
        f"{shlex.quote(sys.executable)} -c {shlex.quote(script)}",
    )
    assert asyncio.run(worker.run_llm("hello")) == worker.LlmReply("banner\nHELLO\n")

    monkeypatch.setenv(
        "GHINBOX_DIGEST_LLM_COMMAND",
        f"{shlex.quote(sys.executable)} -c {shlex.quote('import sys; sys.exit(3)')}",
    )
    with pytest.raises(worker.DigestError, match="exited 3"):
        asyncio.run(worker.run_llm("hello"))


def test_run_llm_can_pass_prompt_as_file(monkeypatch: pytest.MonkeyPatch) -> None:
    script = "import sys; print(open(sys.argv[1]).read().upper())"
    monkeypatch.setenv(
        "GHINBOX_DIGEST_LLM_COMMAND",
        f"{shlex.quote(sys.executable)} -c {shlex.quote(script)} {{prompt_file}}",
    )
    assert asyncio.run(worker.run_llm("from a file")).text == "FROM A FILE\n"


def test_post_sync_hook_only_digests_configured_profiles(
    monkeypatch: pytest.MonkeyPatch, db_path: str
) -> None:
    scheduled: list[str] = []
    monkeypatch.setattr(
        worker, "schedule_digest_update", lambda profile: scheduled.append(profile)
    )
    monkeypatch.setenv("GHINBOX_DIGEST_PROFILES", "pytorch, other")
    monkeypatch.delenv("GHINBOX_DIGEST_ENABLED", raising=False)

    for key in ("profile:pytorch", "profile:unlisted", "pytorch/pytorch"):
        asyncio.run(worker.on_snapshot_synced(key))
    assert scheduled == ["pytorch"]

    monkeypatch.setenv("GHINBOX_DIGEST_ENABLED", "0")
    asyncio.run(worker.on_snapshot_synced("profile:other"))
    assert scheduled == ["pytorch"]


def test_post_sync_hook_ingests_after_every_sync(
    monkeypatch: pytest.MonkeyPatch, db_path: str
) -> None:
    scheduled: list[str] = []
    monkeypatch.setattr(
        worker, "schedule_digest_update", lambda profile: scheduled.append(profile)
    )
    monkeypatch.delenv("GHINBOX_DIGEST_ENABLED", raising=False)
    monkeypatch.delenv("GHINBOX_DIGEST_PROFILES", raising=False)

    update_digest_state(PROFILE, finished_at=utc_now_iso(), composed_at=utc_now_iso())
    asyncio.run(worker.on_snapshot_synced(KEY))
    asyncio.run(worker.on_snapshot_synced(KEY))
    assert scheduled == [PROFILE, PROFILE]


def test_compose_runs_daily_or_when_forced(
    monkeypatch: pytest.MonkeyPatch, db_path: str
) -> None:
    monkeypatch.delenv("GHINBOX_DIGEST_COMPOSE_INTERVAL_HOURS", raising=False)
    now = datetime(2026, 9, 2, tzinfo=timezone.utc)
    llm = FakeLlm()

    def run(at: datetime, **kwargs) -> dict:
        return asyncio.run(
            worker.update_digest(
                PROFILE, llm=llm, current_user="ezyang", now=at, **kwargs
            )
        )

    _save([_notification("n-1", 1, "2026-09-01T00:00:00Z")], db_path)
    run(now)
    assert llm.compose_calls == 1

    # New items are triaged right away but wait for the daily compose.
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    state = run(now + timedelta(hours=1))
    assert (llm.triage_calls, llm.compose_calls) == (2, 1)
    assert state["composed_at"] == now.isoformat()

    # Refresh forces a compose.
    state = run(now + timedelta(hours=2), force_compose=True)
    assert llm.compose_calls == 2
    assert state["composed_at"] == (now + timedelta(hours=2)).isoformat()

    # Due, but nothing changed: no compose.
    run(now + timedelta(hours=30))
    assert llm.compose_calls == 2

    _save([_notification("n-1", 1, "2026-09-03T00:00:00Z")], db_path)
    run(now + timedelta(hours=30))
    assert llm.compose_calls == 3


def test_is_compose_due_table() -> None:
    now = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
    day = 24 * 3600
    cases = [
        ("never composed", {}, day, True),
        ("composed 1h ago", {"composed_at": "2026-09-23T11:00:00+00:00"}, day, False),
        ("composed 25h ago", {"composed_at": "2026-09-22T11:00:00+00:00"}, day, True),
        ("pacing disabled", {"composed_at": "2026-09-23T11:59:00+00:00"}, 0, True),
        ("naive timestamp", {"composed_at": "2026-09-23T11:30:00"}, day, False),
        ("garbage timestamp", {"composed_at": "yesterday"}, day, True),
    ]
    for name, state, interval, expected in cases:
        assert (
            worker.is_compose_due(state, now=now, interval_seconds=interval) is expected
        ), name


def test_digest_response_joins_snapshot_and_drops_gone_items(db_path: str) -> None:
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    llm = FakeLlm({"n-1": "high"})
    asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))
    # n-1 was marked done and dropped by the next sync.
    _save([_notification("n-2", 2, "2026-09-01T00:00:00Z")], db_path)

    response = digest_routes.build_digest_response(PROFILE)

    # n-1 was the surfaced item; the user handled it, so nothing is left.
    assert response["look_at"] == []
    assert response["vibe"][0]["text"] == "Busy week."
    assert [e["id"] for e in response["vibe"][0]["examples"]] == ["n-2"]
    assert response["vibe"][0]["examples"][0]["url"] == (
        "https://github.com/pytorch/pytorch/issues/2"
    )
    assert response["snapshot_synced_at"]
    assert response["status"] == "idle"


def test_saved_note_round_trip(db_path: str) -> None:
    save_item_notes(
        PROFILE, {"x": {"updated_at": "t", "attention": "high", "why": "w"}}
    )
    assert get_item_notes(PROFILE) == {
        "x": {"updated_at": "t", "attention": "high", "why": "w"}
    }


class FakeArchiver:
    """Marks ids done like the real archiver: succeed, then prune snapshots."""

    def __init__(self, fail_ids: set[str] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.fail_ids = fail_ids or set()

    async def __call__(self, ids: list[str]) -> ActionResult:
        self.calls.append(list(ids))
        done = [nid for nid in ids if nid not in self.fail_ids]
        remove_notifications_from_snapshots(done)
        if len(done) < len(ids):
            return ActionResult(
                status="partial", error="HTTP 500", successful_notification_ids=done
            )
        return ActionResult(status="ok", successful_notification_ids=done)


def test_mention_signal_table() -> None:
    cases = [
        ([], None),
        (["cc'd (broadcast) by alice"], "broadcast"),
        (["@-mentioned by alice"], "direct"),
        (["@-mentioned by meta-codesync[bot]"], None),
        (["cc'd (broadcast) by alice", "replied to by bob"], "direct"),
    ]
    for signals, expected in cases:
        assert mention_signal(signals) == expected, signals


def test_select_auto_done_ids_table() -> None:
    def entry(nid: str, signals: list[str] | None = None, **note) -> tuple:
        return ({"id": nid, "reply_signals": signals or []}, note)

    entries = [
        entry("ambient"),
        entry("broadcast", ["cc'd (broadcast) by alice"]),
        entry("bot-mention", ["@-mentioned by meta-codesync[bot]"]),
        entry("surfaced", surfaced=True),
        entry("human-mention", ["@-mentioned by alice"]),
        entry("replied-after", ["replied to by bob"]),
        entry("already-done", archived_at="2026-09-01T00:00:00+00:00"),
    ]
    assert worker.select_auto_done_ids(entries) == [
        "ambient",
        "broadcast",
        "bot-mention",
    ]


def test_auto_done_marks_digested_feed_items_done_and_keeps_them_in_the_vibe(
    db_path: str,
) -> None:
    now = datetime(2026, 9, 2, tzinfo=timezone.utc)
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
            _notification("n-3", 3, "2026-09-01T00:00:00Z"),
            REVIEW,
        ],
        db_path,
    )
    llm = FakeLlm({"n-1": "high"})
    archiver = FakeArchiver()

    def run(at: datetime = now) -> dict:
        return asyncio.run(
            worker.update_digest(
                PROFILE, llm=llm, archiver=archiver, current_user="ezyang", now=at
            )
        )

    state = run()

    # The "high" item is surfaced in "Look at these"; it stays in the inbox.
    # Review requests are not Feed and are never touched.
    assert archiver.calls == [["n-2", "n-3"]]
    assert state["auto_done"]["done"] == 2
    assert state["counts"] == {
        "feed_count": 3,
        "direct_count": 0,
        "broadcast_count": 0,
        "auto_done_count": 2,
    }
    snapshot_ids = [n["id"] for n in (get_snapshot(KEY) or {})["notifications"]]
    assert snapshot_ids == ["n-1", "review-pr"]
    notes = get_item_notes(PROFILE)
    assert notes["n-1"]["surfaced"] is True
    assert notes["n-2"]["archived_at"] == now.isoformat()
    # Auto-done ran before this pass composed, so n-2/n-3 are already in it.
    assert state["queue_count"] == 0
    assert "(auto-done)" in llm.prompts[-1]

    # The next pass sees the pruned snapshot but still digests n-2/n-3; nothing
    # changed, so there are no LLM calls and nothing new to mark done.
    llm.prompts.clear()
    state = run()
    assert llm.prompts == []
    assert len(archiver.calls) == 1
    response = digest_routes.build_digest_response(PROFILE)
    assert [item["id"] for item in response["look_at"]] == ["n-1"]
    assert response["look_at"][0]["why"] == "worth it"
    assert [e["id"] for e in response["vibe"][0]["examples"]] == ["n-1", "n-2"]
    assert response["vibe"][0]["examples"][1]["url"] == (
        "https://github.com/pytorch/pytorch/issues/2"
    )

    # New activity brings n-2 back to the inbox: re-triaged, marked done again.
    # The surfaced n-1 also changed; its surfaced flag survives re-triage.
    _save(
        [
            _notification("n-1", 1, "2026-09-03T00:00:00Z"),
            _notification("n-2", 2, "2026-09-03T00:00:00Z"),
        ],
        db_path,
    )
    llm.prompts.clear()
    state = run(now + timedelta(hours=1))
    assert (llm.triage_calls, llm.compose_calls) == (1, 0)
    assert archiver.calls[-1] == ["n-2"]
    assert get_item_notes(PROFILE)["n-1"]["surfaced"] is True
    # Marked done since the last compose: queued for the next one.
    assert state["queue_count"] == 1
    assert digest_routes.build_digest_response(PROFILE)["queue_count"] == 1

    # The daily compose takes in the queue. n-3 (composed yesterday) has aged
    # out of the window; the re-archived n-2 was still queued, so it stays.
    llm.prompts.clear()
    state = run(now + timedelta(hours=25))
    assert set(get_item_notes(PROFILE)) == {"n-1", "n-2"}
    assert llm.compose_calls == 1
    assert state["queue_count"] == 0

    # A day after that compose, n-2 ages out too.
    state = run(now + timedelta(hours=50))
    assert set(get_item_notes(PROFILE)) == {"n-1"}
    assert state["counts"]["feed_count"] == 1


def test_auto_done_failures_are_reported_and_retried(db_path: str) -> None:
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
            _notification("n-3", 3, "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    llm = FakeLlm({"n-1": "high"})
    archiver = FakeArchiver(fail_ids={"n-3"})

    state = asyncio.run(
        worker.update_digest(PROFILE, llm=llm, archiver=archiver, current_user="ezyang")
    )
    assert state["auto_done"] == {
        "at": state["auto_done"]["at"],
        "attempted": 2,
        "done": 1,
        "error": "HTTP 500",
    }
    assert "archived_at" not in get_item_notes(PROFILE)["n-3"]

    archiver.fail_ids.clear()
    asyncio.run(
        worker.update_digest(PROFILE, llm=llm, archiver=archiver, current_user="ezyang")
    )
    assert archiver.calls[-1] == ["n-3"]

    async def no_token(ids: list[str]) -> None:
        return None

    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-4", 4, "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    state = asyncio.run(
        worker.update_digest(PROFILE, llm=llm, archiver=no_token, current_user="ezyang")
    )
    assert state["auto_done"]["error"] == "No GitHub token configured"


def test_parse_llm_output_reads_pi_json_events() -> None:
    events = [
        {"type": "session", "id": "x"},
        {"type": "message_end", "message": {"role": "user", "content": []}},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "hmm"},
                    {"type": "text", "text": '{"items": []}'},
                ],
                "usage": {
                    "input": 389,
                    "output": 23,
                    "cacheRead": 5,
                    "cost": {"total": 0.25},
                },
            },
        },
        {"type": "agent_settled"},
    ]
    output = "\n".join(json.dumps(event) for event in events) + "\n"
    assert worker.parse_llm_output(output) == worker.LlmReply(
        text='{"items": []}',
        usage={
            "input_tokens": 389,
            "output_tokens": 23,
            "cache_read_tokens": 5,
            "cost_usd": 0.25,
        },
    )
    assert worker.parse_llm_output('plain {"a": 1}\n') == worker.LlmReply(
        'plain {"a": 1}\n'
    )


def test_llm_calls_are_logged_with_usage(db_path: str) -> None:
    _save(
        [
            _notification("n-1", 1, "2026-09-01T00:00:00Z"),
            _notification("n-2", 2, "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    fake = FakeLlm()

    async def llm(prompt: str) -> worker.LlmReply:
        text = await fake(prompt)
        return worker.LlmReply(
            text, {"input_tokens": len(prompt), "output_tokens": 10, "cost_usd": 0.5}
        )

    asyncio.run(worker.update_digest(PROFILE, llm=llm, current_user="ezyang"))

    usage = get_llm_usage(PROFILE, datetime.now(timezone.utc) - timedelta(hours=1))
    assert usage["triage"]["calls"] == 1
    assert usage["triage"]["items"] == 2
    assert usage["triage"]["input_tokens"] == len(fake.prompts[0])
    assert usage["compose"]["calls"] == 1
    assert usage["total"]["calls"] == 2
    assert usage["total"]["output_tokens"] == 20
    assert usage["total"]["cost_usd"] == 1.0
    assert usage["total"]["errors"] == 0
    response = digest_routes.build_digest_response(PROFILE)
    assert response["llm_usage"]["window_hours"] == 24
    assert response["llm_usage"]["total"]["calls"] == 2

    async def broken(prompt: str) -> str:
        raise worker.DigestError("model unavailable")

    _save([_notification("n-3", 3, "2026-09-01T00:00:00Z")], db_path)
    with pytest.raises(worker.DigestError):
        asyncio.run(worker.update_digest(PROFILE, llm=broken, current_user="ezyang"))
    usage = get_llm_usage(PROFILE, datetime.now(timezone.utc) - timedelta(hours=1))
    assert usage["triage"]["calls"] == 2
    assert usage["triage"]["errors"] == 1
