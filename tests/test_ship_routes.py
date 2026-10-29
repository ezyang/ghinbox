import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ghinbox.api import ship_routes
from ghinbox.api.app import app

# The real pytorch/pytorch wiki page pytorchbot links to.
GUIDE = (
    Path(__file__).parent / "fixtures" / "ship" / "PyTorch-AutoLabel-Bot.md"
).read_text()


class FakeFetcher:
    def __init__(self, sha: str = "abc123", guide: str | Exception = GUIDE):
        self.sha = sha
        self.guide_text = guide
        self.calls: list[str] = []

    async def pull(self, repo: str, number: int) -> dict[str, Any]:
        self.calls.append(f"pull {repo}#{number}")
        return {
            "title": "Expose torch.assert_async as the public name",
            "body": "Makes torch.assert_async public, keeping the alias.",
            "labels": [{"name": "ciflow/trunk"}],
            "head": {"sha": self.sha},
        }

    async def files(self, repo: str, number: int) -> list[dict[str, Any]]:
        self.calls.append("files")
        return [
            {
                "filename": "torch/__init__.py",
                "additions": 3,
                "deletions": 0,
                "patch": "+assert_async = _assert_async",
            },
            {"filename": "test/test_torch.py", "additions": 5, "deletions": 0},
        ]

    async def labels(self, repo: str) -> list[str]:
        self.calls.append("labels")
        return [
            "module: nn",
            "release notes: python_frontend",
            "release notes: fx",
            "topic: not user facing",
        ]

    async def guide(self, url: str) -> str:
        self.calls.append(f"guide {url}")
        if isinstance(self.guide_text, Exception):
            raise self.guide_text
        return self.guide_text


@pytest.fixture(autouse=True)
def clear_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ship_routes, "_guide_cache", {})
    monkeypatch.setattr(ship_routes, "_labels_cache", {})
    monkeypatch.setattr(ship_routes, "_suggestion_cache", {})
    monkeypatch.setattr(ship_routes, "_reviewer_cache", {})


def test_extract_guide_keeps_only_the_release_notes_section() -> None:
    guide = ship_routes.extract_guide(GUIDE)
    assert guide.startswith(
        "## Why categorize (for release notes)? And how does it work?"
    )
    assert "`topic: not user facing` should be added" in guide
    assert "## How it works" not in guide
    assert "Probot" not in guide


def test_suggest_release_label_asks_with_the_guide_and_only_real_labels() -> None:
    fetcher = FakeFetcher()
    prompts: list[str] = []

    async def ask(prompt: str) -> str:
        prompts.append(prompt)
        return 'Sure! {"label": "Release notes: python_frontend", "why": "New public torch API."}'

    result = asyncio.run(
        ship_routes.suggest_release_label(
            "pytorch/pytorch", 196069, fetcher=fetcher, ask=ask
        )
    )
    # Case-insensitive match, returned with the repo's own spelling.
    assert result == {
        "label": "release notes: python_frontend",
        "why": "New public torch API.",
    }
    [prompt] = prompts
    assert "## Why categorize" in prompt
    assert (
        "- topic: not user facing\n- release notes: fx\n- release notes: python_frontend\n"
        in prompt
    )
    assert "module: nn" not in prompt.split("Pull request (JSON):")[0]
    item = json.loads(prompt.split("Pull request (JSON):\n", 1)[1])
    assert item["files"][0] == {
        "path": "torch/__init__.py",
        "additions": 3,
        "deletions": 0,
    }
    assert item["diff"] == "--- torch/__init__.py\n+assert_async = _assert_async"

    # Same head SHA: no GitHub calls, no LLM call.
    fetcher.calls.clear()
    again = asyncio.run(
        ship_routes.suggest_release_label(
            "pytorch/pytorch", 196069, fetcher=fetcher, ask=ask, head_sha="abc123"
        )
    )
    assert again == result
    assert fetcher.calls == []
    assert len(prompts) == 1


def test_suggest_release_label_rejects_invented_labels() -> None:
    async def ask(prompt: str) -> str:
        return '{"label": "release notes: torch", "why": "?"}'

    with pytest.raises(ship_routes.ReleaseLabelError, match="doesn't have"):
        asyncio.run(
            ship_routes.suggest_release_label(
                "pytorch/pytorch", 1, fetcher=FakeFetcher(), ask=ask
            )
        )


def test_an_unreachable_guide_falls_back_to_pytorchbots_message() -> None:
    prompts: list[str] = []

    async def ask(prompt: str) -> str:
        prompts.append(prompt)
        return '{"label": "topic: not user facing", "why": "Tests only."}'

    fetcher = FakeFetcher(guide=OSError("offline"))
    asyncio.run(
        ship_routes.suggest_release_label(
            "pytorch/pytorch", 1, fetcher=fetcher, ask=ask
        )
    )
    assert ship_routes.FALLBACK_GUIDE in prompts[0]


def test_release_label_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ship_routes, "_fetcher", FakeFetcher())

    async def ask(prompt: str) -> str:
        return '{"label": "topic: not user facing", "why": "Tests only."}'

    monkeypatch.setattr(ship_routes, "_ask", ask)
    client = TestClient(app)
    response = client.post(
        "/api/ship/release-label", json={"repo": "pytorch/pytorch", "number": 7}
    )
    assert response.status_code == 200
    assert response.json() == {"label": "topic: not user facing", "why": "Tests only."}
    assert (
        client.post(
            "/api/ship/release-label", json={"repo": "../etc", "number": 7}
        ).status_code
        == 400
    )


def test_release_label_route_refuses_the_llm_in_test_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ship_routes, "_fetcher", FakeFetcher())
    monkeypatch.setenv("GHINBOX_TEST_MODE", "1")
    monkeypatch.delenv("GHINBOX_DIGEST_LLM_COMMAND", raising=False)
    response = TestClient(app).post(
        "/api/ship/release-label", json={"repo": "pytorch/pytorch", "number": 7}
    )
    assert response.status_code == 503


# Real history of torch/_subclasses/fake_tensor.py (trimmed to the fields we
# read), harvested over the debug socket:
#   curl --unix-socket auth_state/ghinbox-debug.sock \
#     "http://ghinbox/github/rest/repos/pytorch/pytorch/commits?path=torch/_subclasses/fake_tensor.py&per_page=12"
COMMITS = json.loads(
    (
        Path(__file__).parent / "fixtures" / "ship" / "commits-fake_tensor.json"
    ).read_text()
)


class FakeReviewerFetcher:
    def __init__(self, history: list[dict[str, Any]] = COMMITS) -> None:
        self.history = history
        self.calls: list[str] = []

    async def pull(self, repo: str, number: int) -> dict[str, Any]:
        self.calls.append("pull")
        return {
            "title": "Fix fake tensor caching for subclasses",
            "body": "",
            "labels": [],
            "head": {"sha": "abc123"},
            "user": {"login": "liangel-02"},
            "requested_reviewers": [{"login": "zou3519"}],
        }

    async def files(self, repo: str, number: int) -> list[dict[str, Any]]:
        self.calls.append("files")
        return [
            {"filename": "test/test_fake_tensor.py", "additions": 2, "deletions": 0},
            {
                "filename": "torch/_subclasses/fake_tensor.py",
                "additions": 30,
                "deletions": 4,
                "patch": "+cache",
            },
        ]

    async def commits(self, repo: str, path: str, since: str) -> list[dict[str, Any]]:
        self.calls.append(f"commits {path}")
        return self.history if path == "torch/_subclasses/fake_tensor.py" else []


def test_reviewer_candidates_are_who_wrote_or_approved_the_files() -> None:
    candidates = ship_routes.collect_reviewer_candidates(
        {"torch/_subclasses/fake_tensor.py": COMMITS}, {"liangel-02", "zou3519"}
    )
    by_login = {candidate["login"]: candidate for candidate in candidates}
    # The author and the silent reviewer are excluded; approvals count double.
    assert candidates[0]["login"] == "ezyang"
    assert by_login["ezyang"]["approved"] == 7
    assert by_login["ezyang"]["authored"] == 1
    assert by_login["ezyang"]["last_active"] == "2026-10-29"
    assert by_login["albanD"]["approved"] == 1
    # "Approved by:" lists every approver.
    assert {"pbielak", "etaf", "jansel"} <= set(by_login)
    assert "liangel-02" not in by_login and "zou3519" not in by_login
    assert by_login["ezyang"]["files"] == ["torch/_subclasses/fake_tensor.py"]


def test_suggest_reviewers_returns_only_candidates_and_caches_by_sha() -> None:
    fetcher = FakeReviewerFetcher()
    prompts: list[str] = []

    async def ask(prompt: str) -> str:
        prompts.append(prompt)
        return json.dumps(
            {
                "reviewers": [
                    {"login": "EZYANG", "why": "Approves most fake tensor changes."},
                    {"login": "someone-made-up", "why": "?"},
                    {"login": "ezyang", "why": "Duplicate."},
                    {"login": "aorenste", "why": "Recently approved here."},
                ]
            }
        )

    result = asyncio.run(
        ship_routes.suggest_reviewers("pytorch/pytorch", 7, fetcher=fetcher, ask=ask)
    )
    assert result == {
        "reviewers": [
            {
                "login": "ezyang",
                "name": "Edward Z. Yang",
                "why": "Approves most fake tensor changes.",
            },
            {"login": "aorenste", "name": "", "why": "Recently approved here."},
        ]
    }
    # The biggest file's history is read first.
    assert fetcher.calls[2] == "commits torch/_subclasses/fake_tensor.py"
    [prompt] = prompts
    assert "from @zou3519, who have not responded" in prompt
    candidates = json.loads(prompt.split("Candidates (JSON):\n", 1)[1].split("\n\n")[0])
    assert "liangel-02" not in {candidate["login"] for candidate in candidates}

    fetcher.calls.clear()
    again = asyncio.run(
        ship_routes.suggest_reviewers(
            "pytorch/pytorch", 7, fetcher=fetcher, ask=ask, head_sha="abc123"
        )
    )
    assert again == result
    assert fetcher.calls == []
    assert len(prompts) == 1


def test_suggest_reviewers_skips_the_llm_with_no_candidates() -> None:
    fetcher = FakeReviewerFetcher(history=[])

    async def ask(prompt: str) -> str:
        raise AssertionError("no candidates, no LLM call")

    result = asyncio.run(
        ship_routes.suggest_reviewers("pytorch/pytorch", 7, fetcher=fetcher, ask=ask)
    )
    assert result == {"reviewers": []}


def test_reviewer_suggestions_route(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ship_routes, "_fetcher", FakeReviewerFetcher())

    async def ask(prompt: str) -> str:
        return '{"reviewers": [{"login": "albanD", "why": "Reviews here."}]}'

    monkeypatch.setattr(ship_routes, "_ask_reviewers", ask)
    response = TestClient(app).post(
        "/api/ship/reviewer-suggestions",
        json={"repo": "pytorch/pytorch", "number": 7},
    )
    assert response.status_code == 200
    assert response.json() == {
        "reviewers": [{"login": "albanD", "name": "", "why": "Reviews here."}]
    }
