"""Tests for the background feed digest worker, prompts, and routes."""

import asyncio
import json
import os
import shlex
import sys
import tempfile
from datetime import datetime, timezone

import pytest

from ghinbox.api import digest_routes
from ghinbox.api.snapshot_store import init_snapshot_db, save_snapshot
from ghinbox.digest import prompts, worker
from ghinbox.digest.store import (
    get_digest_state,
    get_item_notes,
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
                    "look_at": [{"id": nid, "why": "look"} for nid in ids[:1]]
                    + [{"id": "invented", "why": "hallucinated"}],
                    "vibe": [
                        {"title": "Dynamo", "text": "Busy week.", "example_ids": ids},
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
            "look_at": [{"id": str(n), "why": "w"} for n in range(30)]
            + [{"id": "nope", "why": "w"}],
            "vibe": [
                {"title": "t", "text": "p", "example_ids": ["1", "nope", "2", "3"]},
                {"title": "empty", "text": ""},
            ],
        },
        known,
    )
    assert len(digest["look_at"]) == prompts.MAX_LOOK_AT
    assert digest["vibe"] == [{"title": "t", "text": "p", "example_ids": ["1", "2"]}]


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
    assert set(get_item_notes(PROFILE)) == {"n-1", "n-2"}
    assert state["pending_count"] == 0
    assert state["counts"]["feed_count"] == 2
    assert state["digest"]["look_at"] == [{"id": "n-1", "why": "look"}]
    assert state["digest"]["vibe"][0]["example_ids"] == ["n-1", "n-2"]

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

    assert (llm.triage_calls, llm.compose_calls) == (1, 1)
    assert '"id": "n-1"' in llm.prompts[0]
    assert '"n-2"' not in llm.prompts[0]
    assert get_item_notes(PROFILE)["n-1"]["updated_at"] == "2026-09-02T00:00:00Z"
    assert "n-2" not in get_item_notes(PROFILE)
    assert state["counts"]["feed_count"] == 1


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
    assert asyncio.run(worker.run_llm("hello")) == "banner\nHELLO\n"

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
    assert asyncio.run(worker.run_llm("from a file")) == "FROM A FILE\n"


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


def test_post_sync_hook_paces_background_passes(
    monkeypatch: pytest.MonkeyPatch, db_path: str
) -> None:
    scheduled: list[str] = []
    monkeypatch.setattr(
        worker, "schedule_digest_update", lambda profile: scheduled.append(profile)
    )
    monkeypatch.delenv("GHINBOX_DIGEST_ENABLED", raising=False)
    monkeypatch.delenv("GHINBOX_DIGEST_PROFILES", raising=False)
    monkeypatch.setenv("GHINBOX_DIGEST_MIN_INTERVAL_MINUTES", "60")

    update_digest_state(PROFILE, finished_at=utc_now_iso())
    asyncio.run(worker.on_snapshot_synced(KEY))
    assert scheduled == []

    update_digest_state(PROFILE, finished_at="2026-01-01T00:00:00+00:00")
    asyncio.run(worker.on_snapshot_synced(KEY))
    assert scheduled == [PROFILE]


def test_is_background_digest_due_table() -> None:
    now = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
    cases = [
        ("never ran", {}, 3600, True),
        ("finished 10m ago", {"finished_at": "2026-09-23T11:50:00+00:00"}, 3600, False),
        ("finished 61m ago", {"finished_at": "2026-09-23T10:59:00+00:00"}, 3600, True),
        ("pacing disabled", {"finished_at": "2026-09-23T11:59:00+00:00"}, 0, True),
        ("naive timestamp", {"finished_at": "2026-09-23T11:30:00"}, 3600, False),
        ("garbage timestamp", {"finished_at": "yesterday"}, 3600, True),
    ]
    for name, state, interval, expected in cases:
        assert (
            worker.is_background_digest_due(
                state, now=now, min_interval_seconds=interval
            )
            is expected
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
