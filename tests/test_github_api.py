import json
import urllib.request
from typing import Any

import pytest

from ghinbox import github_api
from ghinbox.github_api import GitHubAPI, GitHubPaginationLimitError


class FakeResponse:
    def __init__(
        self,
        payload: Any,
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status = status
        self.headers = headers or {}
        self._payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


def test_paginated_list_follows_next_link_and_preserves_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    next_url = (
        "https://api.github.com/repos/test/repo/issues/10/comments?per_page=100&page=2"
    )
    responses = [
        FakeResponse([{"id": 1}], headers={"Link": f'<{next_url}>; rel="next"'}),
        FakeResponse([{"id": 2}]),
    ]

    def fake_urlopen(request: urllib.request.Request) -> FakeResponse:
        calls.append(request.full_url)
        return responses.pop(0)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    api = GitHubAPI("token")
    comments = api.list_issue_comments(
        "test",
        "repo",
        10,
        since="2026-07-08T00:00:00Z",
    )

    assert comments == [{"id": 1}, {"id": 2}]
    assert calls == [
        "https://api.github.com/repos/test/repo/issues/10/comments"
        "?per_page=100&since=2026-07-08T00%3A00%3A00Z",
        next_url,
    ]
    assert api.request_count == 2


def test_paginated_list_raises_when_next_link_does_not_advance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    first_url = "https://api.github.com/notifications?all=true&per_page=100"

    def fake_urlopen(request: urllib.request.Request) -> FakeResponse:
        calls.append(request.full_url)
        return FakeResponse(
            [{"id": len(calls)}],
            headers={"Link": f'<{first_url}>; rel="next"'},
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    api = GitHubAPI("token")
    with pytest.raises(GitHubPaginationLimitError, match="did not advance"):
        api.get_notifications(all_notifications=True)

    assert calls == [first_url]
    assert api.request_count == 1


def test_paginated_list_raises_when_page_cap_is_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_urlopen(request: urllib.request.Request) -> FakeResponse:
        calls.append(request.full_url)
        next_url = f"https://api.github.com/notifications?all=true&per_page=100&page={len(calls) + 1}"
        return FakeResponse(
            [{"id": len(calls)}],
            headers={"Link": f'<{next_url}>; rel="next"'},
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(github_api, "MAX_GITHUB_API_PAGES", 2)

    api = GitHubAPI("token")
    with pytest.raises(GitHubPaginationLimitError, match="exceeded 2 pages"):
        api.get_notifications(all_notifications=True)

    assert len(calls) == 2
    assert api.request_count == 2
