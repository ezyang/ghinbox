import pytest

from ghinbox.api.archive_api import _subject_key_from_url


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "https://api.github.com/repos/octo/repo/issues/12",
            ("octo", "repo", "issues", "12"),
        ),
        (
            "https://github.com/octo/repo/pull/34",
            ("octo", "repo", "pulls", "34"),
        ),
        (
            "https://api.github.com/repos/octo/repo/discussions/56",
            ("octo", "repo", "discussions", "56"),
        ),
        (
            "https://github.com/octo/repo/commit/deadbeef",
            ("octo", "repo", "commits", "deadbeef"),
        ),
        (
            "https://api.github.com/repos/octo/repo/check-suites/78",
            ("octo", "repo", "check-suites", "78"),
        ),
        (
            "https://api.github.com/repos/octo/repo/dependabot/alerts/90",
            ("octo", "repo", "repository-vulnerability-alerts", "90"),
        ),
    ],
)
def test_subject_key_from_url_supports_github_notification_subject_kinds(
    url: str,
    expected: tuple[str, str, str, str],
) -> None:
    assert _subject_key_from_url(url) == expected


def test_release_subject_key_uses_node_database_id_for_html_tag_url() -> None:
    notification_id = (
        "NT_kwHNNPzaACdSZXBvc2l0b3J5OzExOTY2MTQyNzM7UmVsZWFzZTszNTQ2MzgxMzc"
    )

    assert _subject_key_from_url(
        "https://github.com/meta-pytorch/spmd_types/releases/tag/v0.2.2",
        notification_id=notification_id,
    ) == ("meta-pytorch", "spmd_types", "releases", "354638137")


def test_subject_key_returns_none_for_unknown_subject_kind() -> None:
    assert _subject_key_from_url("https://github.com/octo/repo/wiki/Page") is None
