"""Tests for GitHub API proxy helpers."""

import asyncio
from typing import Any, cast

import pytest

from ghinbox.api import github_proxy
from ghinbox.api.notification_shapes import notification_to_bulk_comment_item


def test_bulk_comment_item_includes_close_events_for_closed_notifications(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, str] | None]] = []

    async def fake_github_get_json(client, token: str, path: str, params=None):
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
        ("repos/test/repo/issues/10/events", {"per_page": "100"}),
    ]


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


def test_review_requests_endpoint_normalizes_search_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_github_get_json(client, token: str, path: str, params=None):
        assert client == "client"
        assert token == "token"
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

    result = asyncio.run(github_proxy.review_requests(owner="test", repo="repo"))

    assert result["notifications"][0]["id"] == "review-request:test/repo#42"
    assert result["notifications"][0]["repository"]["full_name"] == "test/repo"
    assert result["notifications"][0]["labels"] == [{"name": "mergedog"}]
    assert result["notifications"][0]["author_association"] == "MEMBER"
