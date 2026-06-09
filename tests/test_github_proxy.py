"""Tests for GitHub API proxy helpers."""

import asyncio
from typing import Any, cast

import pytest

from ghinbox.api import github_proxy


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
