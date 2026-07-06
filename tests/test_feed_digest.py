import importlib.util
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
