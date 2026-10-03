"""Tests for the digest's screen of External review requests."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import pytest

from ghinbox.api import digest_routes
from ghinbox.api.snapshot_store import init_snapshot_db, save_snapshot
from ghinbox.digest import prompts, reviews, worker
from ghinbox.digest.store import (
    get_author_permissions,
    get_review_assessments,
    init_digest_db,
)

PROFILE = "pytorch"
KEY = f"profile:{PROFILE}"


@pytest.fixture
def db_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setenv("GHINBOX_SNAPSHOT_DB_PATH", path)
    monkeypatch.setenv("GHINBOX_DIGEST_AUTO_DONE", "0")
    rubric = tmp_path / "rubric.md"
    rubric.write_text("Look at fake tensor PRs.\n")
    monkeypatch.setenv("GHINBOX_REVIEW_RUBRIC_FILE", str(rubric))
    init_snapshot_db(path)
    init_digest_db(path)
    yield path
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass


def _review_request(number: int, author: str, updated_at: str) -> dict[str, Any]:
    """A synthetic Reviews row, as the server's review-request search builds it."""
    return {
        "id": f"review-request:pytorch/pytorch#{number}",
        "reason": "review_requested",
        "responsibility_source": "review-requested",
        "updated_at": updated_at,
        "repository": {"full_name": "pytorch/pytorch"},
        "subject": {
            "title": f"PR {number}",
            "type": "PullRequest",
            "number": number,
            "state": "open",
        },
        "actors": [{"login": author}],
        "author_association": "CONTRIBUTOR",
        "labels": [{"name": "open source"}],
    }


def _save(notifications: list[dict[str, Any]], db_path: str) -> None:
    save_snapshot(
        KEY,
        notifications,
        comment_cache={"version": 1, "threads": {}},
        db_path=db_path,
    )


class FakeFetcher:
    def __init__(self, permissions: dict[str, str]) -> None:
        self.permissions = permissions
        self.heads: dict[int, str] = {}
        self.calls: list[str] = []
        self.fail = False

    async def permission(self, repo: str, login: str) -> str:
        self.calls.append(f"permission {login}")
        return self.permissions[login]

    async def pull(self, repo: str, number: int) -> dict[str, Any]:
        self.calls.append(f"pull {number}")
        if self.fail:
            raise reviews.ReviewFetchError("Fetching failed (502)")
        return {
            "title": f"PR {number}",
            "body": f"Fixes a fake tensor crash ({number}).",
            "user": {"login": "outsider"},
            "head": {"sha": self.heads.get(number, "sha-1")},
            "additions": 3,
            "deletions": 1,
            "changed_files": 1,
        }

    async def files(self, repo: str, number: int) -> list[dict[str, Any]]:
        self.calls.append(f"files {number}")
        return [
            {
                "filename": "torch/_subclasses/fake_tensor.py",
                "status": "modified",
                "additions": 3,
                "deletions": 1,
                "patch": "@@ -1 +1 @@\n-old\n+new",
            }
        ]


class FakeReviewLlm:
    """Answers review prompts with ``buckets`` per PR key."""

    def __init__(self, buckets: dict[str, list[str]]) -> None:
        self.buckets = buckets
        self.prompts: list[str] = []

    async def __call__(self, prompt: str) -> str:
        assert "Pull requests (JSON)" in prompt
        self.prompts.append(prompt)
        items = json.loads(prompt.rsplit("\n", 1)[-1])
        return json.dumps(
            {
                "items": [
                    {
                        "id": item["id"],
                        "buckets": self.buckets.get(item["id"], []),
                        "why": f"why {item['id']}",
                        "summary": f"summary {item['id']}",
                    }
                    for item in items
                ]
            }
        )


def _run(llm: FakeReviewLlm, fetcher: FakeFetcher) -> dict[str, Any]:
    return asyncio.run(
        worker.update_digest(
            PROFILE, llm=llm, current_user="ezyang", review_fetcher=fetcher
        )
    )


def test_parse_review_response_orders_buckets_and_backfills() -> None:
    items = [{"id": "a#1"}, {"id": "a#2"}, {"id": "a#3"}]
    response = {
        "items": [
            {"id": "a#1", "buckets": ["Important", "easy", "bogus"], "why": "w"},
            {"id": "a#2", "buckets": [], "why": "drive-by"},
            {"id": "unknown#9", "buckets": ["easy"]},
        ]
    }

    verdicts = prompts.parse_review_response(response, items)

    assert verdicts["a#1"]["verdict"] == "look"
    assert verdicts["a#1"]["buckets"] == ["easy", "important"]
    assert verdicts["a#2"] == {
        "verdict": "skip",
        "buckets": [],
        "why": "drive-by",
        "summary": "",
    }
    assert verdicts["a#3"]["verdict"] == "unknown"
    assert set(verdicts) == {"a#1", "a#2", "a#3"}


def test_screen_judges_only_external_review_requests(db_path: str) -> None:
    _save(
        [
            _review_request(1, "outsider", "2026-09-01T00:00:00Z"),
            _review_request(2, "committer", "2026-09-01T00:00:00Z"),
        ],
        db_path,
    )
    fetcher = FakeFetcher({"outsider": "read", "committer": "write"})
    llm = FakeReviewLlm({"pytorch/pytorch#1": ["context"]})

    state = _run(llm, fetcher)

    assert sorted(fetcher.calls) == [
        "files 1",
        "permission committer",
        "permission outsider",
        "pull 1",
    ]
    assert get_author_permissions(reviews.PERMISSION_MAX_AGE) == {
        "pytorch/pytorch": {"outsider": "read", "committer": "write"}
    }
    assert len(llm.prompts) == 1
    # The rubric and the diff both reach the model.
    assert "Look at fake tensor PRs." in llm.prompts[0]
    assert "torch/_subclasses/fake_tensor.py\\n@@ -1 +1 @@" in llm.prompts[0]
    assert state["reviews"]["candidates"] == 1
    assert state["reviews"]["look"] == 1
    assert state["reviews"]["pending"] == 0
    assert state["reviews"]["error"] is None

    response = digest_routes.build_digest_response(PROFILE)
    assert response["review_assessments"] == [
        {
            "pr": "pytorch/pytorch#1",
            "id": "review-request:pytorch/pytorch#1",
            "verdict": "look",
            "buckets": ["context"],
            "why": "why pytorch/pytorch#1",
            "summary": "summary pytorch/pytorch#1",
        }
    ]

    # Nothing changed: no GitHub calls (permissions are cached), no LLM.
    fetcher.calls.clear()
    _run(llm, fetcher)
    assert fetcher.calls == []
    assert len(llm.prompts) == 1


def test_screen_reassesses_on_new_commits_or_rubric_changes(
    db_path: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _save([_review_request(1, "outsider", "2026-09-01T00:00:00Z")], db_path)
    fetcher = FakeFetcher({"outsider": "none"})
    llm = FakeReviewLlm({})
    _run(llm, fetcher)
    assert get_review_assessments(PROFILE)["pytorch/pytorch#1"]["verdict"] == "skip"

    # A comment bumps updated_at but not the head: one cheap read, no LLM.
    _save([_review_request(1, "outsider", "2026-09-02T00:00:00Z")], db_path)
    fetcher.calls.clear()
    _run(llm, fetcher)
    assert fetcher.calls == ["pull 1"]
    assert len(llm.prompts) == 1

    # New commits: the diff is fetched and judged again.
    _save([_review_request(1, "outsider", "2026-09-03T00:00:00Z")], db_path)
    fetcher.heads[1] = "sha-2"
    llm.buckets["pytorch/pytorch#1"] = ["easy"]
    _run(llm, fetcher)
    assert len(llm.prompts) == 2
    assessment = get_review_assessments(PROFILE)["pytorch/pytorch#1"]
    assert (assessment["verdict"], assessment["buckets"]) == ("look", ["easy"])

    # Editing the rubric re-judges every PR, with no new activity needed.
    rubric = tmp_path / "rubric2.md"
    rubric.write_text("Only important PRs.\n")
    monkeypatch.setenv("GHINBOX_REVIEW_RUBRIC_FILE", str(rubric))
    _run(llm, fetcher)
    assert len(llm.prompts) == 3
    assert "Only important PRs." in llm.prompts[2]


def test_screen_failures_are_reported_without_breaking_the_digest(
    db_path: str,
) -> None:
    _save([_review_request(1, "outsider", "2026-09-01T00:00:00Z")], db_path)
    fetcher = FakeFetcher({"outsider": "read"})
    fetcher.fail = True
    llm = FakeReviewLlm({})

    state = _run(llm, fetcher)

    assert state["status"] == "idle"
    assert state["error"] is None
    assert state["reviews"]["error"] == "Fetching failed (502)"
    assert state["reviews"]["pending"] == 1
    assert llm.prompts == []
    assert worker._has_more_reviews(state) is False
    assert digest_routes.build_digest_response(PROFILE)["review_assessments"] == []
