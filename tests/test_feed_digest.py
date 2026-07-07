import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "feed_digest.py"
SPEC = importlib.util.spec_from_file_location("feed_digest_script", MODULE_PATH)
assert SPEC is not None
assert SPEC.loader is not None
feed_digest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(feed_digest)


def test_extract_output_includes_html_report_contract() -> None:
    snapshot = {
        "snapshot": {
            "authenticity_token": "token-123",
            "notifications": [
                {
                    "id": "feed-issue",
                    "reason": "mention",
                    "updated_at": "2026-07-01T12:00:00Z",
                    "subject": {
                        "title": "Ambient compiler issue",
                        "type": "Issue",
                        "number": 123,
                        "state": "open",
                        "url": "https://github.com/pytorch/pytorch/issues/123",
                    },
                    "actors": [{"login": "alice"}],
                    "labels": [{"name": "module: dynamo"}],
                },
                {
                    "id": "feed-pr",
                    "reason": "mention",
                    "updated_at": "2026-07-01T12:10:00Z",
                    "subject": {
                        "title": "Ambient compiler PR",
                        "type": "PullRequest",
                        "number": 124,
                        "state": "open",
                    },
                    "actors": [{"login": "bob"}],
                    "labels": [],
                },
                {
                    "id": "review-pr",
                    "reason": "review_requested",
                    "updated_at": "2026-07-01T12:20:00Z",
                    "subject": {
                        "title": "Needs review",
                        "type": "PullRequest",
                        "number": 125,
                        "state": "open",
                    },
                    "actors": [{"login": "carol"}],
                    "labels": [],
                },
            ],
            "comment_cache": {
                "threads": {
                    "feed-issue": {
                        "comments": [
                            {
                                "id": 1,
                                "created_at": "2026-07-01T12:00:00Z",
                                "body": "cc @ezyang for ambient awareness",
                                "isIssue": True,
                                "user": {"login": "alice"},
                            }
                        ],
                        "stateEvents": [],
                    }
                }
            },
        }
    }

    output = feed_digest.build_extract_output(snapshot, "/tmp/custom-feed.html")

    assert output["feed_count"] == 2
    assert output["reply_nature_count"] == 1
    assert output["report_path"] == "/tmp/custom-feed.html"
    assert output["authenticity_token"] == "token-123"
    assert output["feed_ids"] == ["feed-issue", "feed-pr"]
    assert output["reply_nature_ids"] == ["feed-issue"]
    assert any(
        "Open all" in instruction for instruction in output["report_instructions"]
    )

    report_items = output["report_items"]
    assert report_items[0]["url"] == "https://github.com/pytorch/pytorch/issues/123"
    assert report_items[0]["reply_nature"] is True
    assert report_items[0]["snippets"] == [
        {"author": "alice", "body": "cc @ezyang for ambient awareness"}
    ]
    assert report_items[1]["url"] == "https://github.com/pytorch/pytorch/pull/124"
    assert report_items[1]["type"] == "PR"


def test_extract_output_uses_js_review_queue_classification() -> None:
    snapshot = {
        "snapshot": {
            "authenticity_token": "token-123",
            "notifications": [
                {
                    "id": "display-review-requested",
                    "reason": "review requested",
                    "updated_at": "2026-07-01T12:00:00Z",
                    "subject": {
                        "title": "Display reason from GitHub HTML",
                        "type": "PullRequest",
                        "number": 200,
                        "state": "open",
                    },
                    "actors": [{"login": "alice"}],
                    "labels": [],
                }
            ],
            "comment_cache": {"threads": {}},
        }
    }

    output = feed_digest.build_extract_output(snapshot)

    assert output["feed_count"] == 1
    assert output["feed_ids"] == ["display-review-requested"]


def test_extract_output_uses_cached_thread_last_read_at() -> None:
    snapshot = {
        "snapshot": {
            "authenticity_token": "token-123",
            "notifications": [
                {
                    "id": "read-directed-mention",
                    "reason": "mention",
                    "updated_at": "2026-07-01T12:00:00Z",
                    "subject": {
                        "title": "Already-read directed mention",
                        "type": "PullRequest",
                        "number": 201,
                        "state": "open",
                    },
                    "actors": [{"login": "alice"}],
                    "labels": [],
                }
            ],
            "comment_cache": {
                "threads": {
                    "read-directed-mention": {
                        "lastReadAt": "2026-07-01T12:03:00Z",
                        "comments": [
                            {
                                "id": 1,
                                "created_at": "2026-07-01T12:01:00Z",
                                "body": "@claude summarize this",
                                "user": {"login": "ezyang"},
                            },
                            {
                                "id": 2,
                                "created_at": "2026-07-01T12:02:00Z",
                                "body": "Claude finished @ezyang's task.",
                                "user": {"login": "claude[bot]"},
                            },
                        ],
                        "stateEvents": [],
                    }
                }
            },
        }
    }

    output = feed_digest.build_extract_output(snapshot)

    assert output["feed_count"] == 1
    assert output["feed_ids"] == ["read-directed-mention"]


def _iso_ago(hours: float) -> str:
    return (
        datetime.now(timezone.utc) - timedelta(hours=hours)
    ).isoformat()


def test_snapshot_health_warns_when_stale() -> None:
    snapshot_data = {
        "snapshot": {
            "notifications": [{"id": "n1"}],
            "synced_at": _iso_ago(25),
        },
        "sync": {"status": "success", "notifications_count": 1, "pages_fetched": 1},
    }

    health = feed_digest.build_snapshot_health(
        snapshot_data, snapshot_data["snapshot"]["notifications"]
    )

    assert health["age_hours"] is not None and health["age_hours"] >= 24
    assert any("stale" in warning for warning in health["warnings"])


def test_snapshot_health_fresh_snapshot_has_no_warnings() -> None:
    snapshot_data = {
        "snapshot": {
            "notifications": [{"id": "n1"}, {"id": "n2"}],
            "synced_at": _iso_ago(0.5),
        },
        "sync": {"status": "success", "notifications_count": 2, "pages_fetched": 1},
    }

    health = feed_digest.build_snapshot_health(
        snapshot_data, snapshot_data["snapshot"]["notifications"]
    )

    assert health["warnings"] == []


def test_snapshot_health_does_not_warn_when_archives_shrank_stored_data() -> None:
    """A fresh snapshot whose stored count is below the last sync's fetched
    count is the normal result of archiving after a sync (the archive handler
    prunes stored ``data`` in place). This must NOT be flagged as truncated."""
    snapshot_data = {
        "snapshot": {
            "notifications": [{"id": f"n{i}"} for i in range(105)],
            "synced_at": _iso_ago(0.2),
        },
        "sync": {"status": "success", "notifications_count": 293, "pages_fetched": 8},
    }

    health = feed_digest.build_snapshot_health(
        snapshot_data, snapshot_data["snapshot"]["notifications"]
    )

    assert health["stored_count"] == 105
    assert health["synced_count"] == 293
    assert health["warnings"] == []
    assert not any("truncat" in warning.lower() for warning in health["warnings"])


def test_snapshot_health_warns_on_sync_error() -> None:
    snapshot_data = {
        "snapshot": {
            "notifications": [{"id": "n1"}],
            "synced_at": _iso_ago(0.1),
        },
        "sync": {"status": "error", "error": "GitHub session expired"},
    }

    health = feed_digest.build_snapshot_health(
        snapshot_data, snapshot_data["snapshot"]["notifications"]
    )

    assert any("session expired" in warning for warning in health["warnings"])
