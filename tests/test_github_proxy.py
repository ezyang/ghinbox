"""Tests for GitHub API proxy helpers."""

import asyncio
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import Request
import httpx
import pytest

from ghinbox.api import github_proxy
from ghinbox.api.rate_governor import (
    RateGovernorDecision,
    RateGovernorDeniedError,
    get_rate_governor,
)
from ghinbox.api.notification_shapes import notification_to_bulk_comment_item


def test_bulk_comment_item_includes_close_events_for_closed_notifications(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, str] | None]] = []

    async def fake_github_get_json(
        client,
        token: str,
        path: str,
        params=None,
        **kwargs,
    ):
        assert kwargs["source"] == "comments_bulk.issue"
        assert client == "client"
        assert token == "token"
        calls.append((path, params))
        if path == "repos/test/repo/issues/10":
            return 200, {
                "id": 10,
                "number": 10,
                "body": "issue body",
                "created_at": "2026-06-08T08:00:00Z",
                "updated_at": "2026-06-08T08:00:00Z",
                "closed_at": "2026-06-08T11:00:00Z",
                "user": {"login": "alice"},
            }
        raise AssertionError(f"unexpected GitHub path: {path}")

    async def fake_github_get_paginated_list(
        client,
        token: str,
        path: str,
        params=None,
        **kwargs,
    ):
        assert client == "client"
        assert token == "token"
        assert kwargs["source"] in {
            "comments_bulk.issue_comments",
            "comments_bulk.issue_events",
        }
        calls.append((path, params))
        if path == "repos/test/repo/issues/10/comments":
            return 200, [
                {
                    "id": 100,
                    "body": "post-close reply",
                    "created_at": "2026-06-08T12:00:00Z",
                    "updated_at": "2026-06-08T12:00:00Z",
                    "user": {"login": "bob"},
                }
            ]
        if path == "repos/test/repo/issues/10/events":
            return 200, [
                {
                    "id": 200,
                    "event": "closed",
                    "created_at": "2026-06-08T11:00:00Z",
                },
                {
                    "id": 201,
                    "event": "labeled",
                    "created_at": "2026-06-08T11:30:00Z",
                },
            ]
        raise AssertionError(f"unexpected GitHub path: {path}")

    monkeypatch.setattr(github_proxy, "_github_get_json", fake_github_get_json)
    monkeypatch.setattr(
        github_proxy,
        "_github_get_paginated_list",
        fake_github_get_paginated_list,
    )

    key, result = asyncio.run(
        github_proxy._fetch_bulk_comment_item(
            cast(Any, "client"),
            "token",
            {
                "key": "closed-issue",
                "owner": "test",
                "repo": "repo",
                "number": 10,
                "is_pr": False,
                "subject_state": "closed",
                "last_read_at": "2026-06-08T09:00:00Z",
            },
        )
    )

    assert key == "closed-issue"
    assert result["allComments"] is True
    assert result["comments"][0]["isIssue"] is True
    assert result["comments"][1]["body"] == "post-close reply"
    assert result["stateEvents"] == [
        {
            "id": "issue-10-closed-at",
            "event": "closed",
            "created_at": "2026-06-08T11:00:00Z",
        },
        {
            "id": 200,
            "event": "closed",
            "created_at": "2026-06-08T11:00:00Z",
        },
    ]
    assert calls == [
        ("repos/test/repo/issues/10", None),
        ("repos/test/repo/issues/10/comments", {}),
        ("repos/test/repo/issues/10/events", {}),
    ]


def test_paginated_github_list_adds_per_page_and_follows_next(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []
    next_url = "https://api.github.com/repos/test/repo/issues/10/comments?page=2"

    async def fake_github_get_json_with_headers(
        client,
        token: str,
        path_or_url: str,
        params=None,
        **kwargs,
    ):
        assert client == "client"
        assert token == "token"
        assert kwargs["source"] == "github_proxy"
        calls.append((path_or_url, params))
        if len(calls) == 1:
            return 200, [{"id": 1}], {"link": f'<{next_url}>; rel="next"'}
        return 200, [{"id": 2}], {}

    monkeypatch.setattr(
        github_proxy,
        "_github_get_json_with_headers",
        fake_github_get_json_with_headers,
    )

    status, payload = asyncio.run(
        github_proxy._github_get_paginated_list(
            cast(Any, "client"),
            "token",
            "repos/test/repo/issues/10/comments",
            {"since": "2026-06-08T09:00:00Z"},
        )
    )

    assert status == 200
    assert payload == [{"id": 1}, {"id": 2}]
    assert calls == [
        (
            "repos/test/repo/issues/10/comments",
            {"since": "2026-06-08T09:00:00Z", "per_page": "100"},
        ),
        (next_url, None),
    ]


def test_paginated_github_list_caps_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    # A rel="next" chain that never terminates must not loop forever: an
    # unbounded walk once consumed the entire core rate limit.
    calls = []

    async def fake_github_get_json_with_headers(
        client,
        token: str,
        path_or_url: str,
        params=None,
        **kwargs,
    ):
        calls.append(path_or_url)
        page = len(calls) + 1
        next_url = (
            f"https://api.github.com/repos/test/repo/issues/10/events?page={page}"
        )
        return 200, [{"id": len(calls)}], {"link": f'<{next_url}>; rel="next"'}

    monkeypatch.setattr(
        github_proxy,
        "_github_get_json_with_headers",
        fake_github_get_json_with_headers,
    )

    status, payload = asyncio.run(
        github_proxy._github_get_paginated_list(
            cast(Any, "client"),
            "token",
            "repos/test/repo/issues/10/events",
        )
    )

    assert status == 200
    assert len(calls) == 20
    assert isinstance(payload, list) and len(payload) == 20


def test_github_get_preserves_next_link_query_string() -> None:
    # Regression: passing params={} to httpx replaces the URL's own query
    # string, so following a Link rel="next" URL re-fetched page 1 forever
    # (2026-07-06 rate-limit burn). The request URL must keep the query.
    captured = {}

    class FakeResponse:
        status_code = 200
        headers = httpx.Headers({})
        text = "[]"

        @staticmethod
        def json():
            return []

    class FakeClient:
        async def get(self, url, headers=None, **kwargs):
            captured["url"] = url
            captured["kwargs"] = kwargs
            return FakeResponse()

    next_url = (
        "https://api.github.com/repos/test/repo/issues/10/events?page=2&per_page=100"
    )
    status, payload, _headers = asyncio.run(
        github_proxy._github_get_json_with_headers(
            cast(Any, FakeClient()),
            "token",
            next_url,
            None,
        )
    )

    assert status == 200
    assert captured["url"] == next_url
    assert "params" not in captured["kwargs"]


def test_bulk_comment_item_can_be_built_from_notification_payload() -> None:
    item = notification_to_bulk_comment_item(
        {
            "id": "thread-42",
            "last_read_at": "2026-06-08T09:00:00Z",
            "repository": {"full_name": "test/repo"},
            "subject": {
                "type": "PullRequest",
                "number": 42,
                "state": "open",
                "anchor": "discussion_r42",
            },
        }
    )

    assert item == {
        "key": "thread-42",
        "owner": "test",
        "repo": "repo",
        "number": 42,
        "is_pr": True,
        "subject_state": "open",
        "anchor": "discussion_r42",
        "last_read_at": "2026-06-08T09:00:00Z",
    }


def test_bulk_comment_results_stop_with_partial_rate_limited_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_fetch_bulk_comment_item(
        client,
        token: str,
        item: dict,
        *,
        request_id: str | None = None,
    ):
        assert client == "client"
        assert token == "token"
        assert request_id == "req-123"
        if item["key"] == "two":
            raise RateGovernorDeniedError(
                RateGovernorDecision(
                    allowed=False,
                    reason="remaining_below_floor",
                    call_class="background",
                    pool="core",
                    remaining=499,
                    floor=500,
                    reset_at=datetime(2026, 7, 6, 13, 0, tzinfo=UTC),
                    request_id="req-123",
                    request_count=1,
                    request_budget=300,
                )
            )
        return item["key"], {"comments": [{"id": item["key"]}]}

    monkeypatch.setattr(github_proxy, "get_client", lambda: "client")
    monkeypatch.setattr(
        github_proxy,
        "_fetch_bulk_comment_item",
        fake_fetch_bulk_comment_item,
    )

    results = asyncio.run(
        github_proxy.fetch_bulk_comment_results(
            "token",
            [
                {"key": "one"},
                {"key": "two"},
                {"key": "three"},
            ],
            request_id="req-123",
        )
    )

    assert results.rate_limited is True
    assert results.denial is not None
    assert results.denial["reason"] == "remaining_below_floor"
    assert any(result.get("rate_limited") for _key, result in results)


def test_archive_delete_is_governed_before_direct_httpx_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ghinbox.api import archive_api

    class FakeClient:
        async def request(self, *args, **kwargs):
            raise AssertionError("governor should deny before DELETE is issued")

    monkeypatch.delenv("GHINBOX_TEST_MODE", raising=False)
    monkeypatch.setattr(archive_api, "get_token", lambda: "token")
    monkeypatch.setattr(archive_api, "get_client", lambda: FakeClient())
    get_rate_governor().update_from_headers(
        {
            "x-ratelimit-remaining": "50",
            "x-ratelimit-reset": "4102444800",
            "x-ratelimit-resource": "core",
        },
        observed_at=datetime(2026, 7, 6, 12, 0, tzinfo=UTC),
    )

    with pytest.raises(RateGovernorDeniedError) as error:
        asyncio.run(
            archive_api._submit_archive_with_github_api(
                ["12345"],
                request_id="req-archive",
            )
        )

    assert error.value.detail["reason"] == "remaining_below_floor"
    assert error.value.detail["pool"] == "core"


def test_review_requests_endpoint_normalizes_search_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_github_get_json(
        client,
        token: str,
        path: str,
        params=None,
        **kwargs,
    ):
        assert client == "client"
        assert token == "token"
        assert kwargs["source"] == "review_requests.search"
        assert kwargs["request_id"] == "req-123"
        assert path == "search/issues"
        assert params == {
            "q": "repo:test/repo is:pr is:open user-review-requested:@me",
            "per_page": "100",
        }
        return 200, {
            "items": [
                {
                    "number": 42,
                    "title": "Review me",
                    "html_url": "https://github.com/test/repo/pull/42",
                    "repository_url": "https://api.github.com/repos/test/repo",
                    "pull_request": {},
                    "user": {"login": "alice", "avatar_url": "avatar"},
                    "author_association": "MEMBER",
                    "labels": [{"name": "mergedog"}],
                    "updated_at": "2026-06-08T10:00:00Z",
                },
            ],
        }

    monkeypatch.setattr(github_proxy, "get_token", lambda: "token")
    monkeypatch.setattr(github_proxy, "get_client", lambda: "client")
    monkeypatch.setattr(github_proxy, "_github_get_json", fake_github_get_json)

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/github/rest/review-requests",
            "headers": [],
            "ghinbox_request_id": "req-123",
        }
    )
    result = asyncio.run(
        github_proxy.review_requests(request, owner="test", repo="repo")
    )

    assert result["notifications"][0]["id"] == "review-request:test/repo#42"
    assert result["notifications"][0]["repository"]["full_name"] == "test/repo"
    assert result["notifications"][0]["labels"] == [{"name": "mergedog"}]
    assert result["notifications"][0]["author_association"] == "MEMBER"
