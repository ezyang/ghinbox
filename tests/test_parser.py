"""
Unit tests for the HTML notifications parser.
"""

from pathlib import Path

import pytest

from ghinbox.parser.notifications import (
    SessionExpiredError,
    extract_authenticity_token,
    is_login_page,
    parse_notifications_html,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def pagination_page1_html() -> str:
    """Load the pagination page 1 fixture."""
    return (FIXTURES_DIR / "pagination_page1.html").read_text()


@pytest.fixture
def pagination_page2_html() -> str:
    """Load the pagination page 2 fixture."""
    return (FIXTURES_DIR / "pagination_page2.html").read_text()


@pytest.fixture
def notification_before_done_html() -> str:
    """Load the notification before done fixture (read state)."""
    return (FIXTURES_DIR / "notification_before_done.html").read_text()


@pytest.fixture
def notifications_inbox_html() -> str:
    """Load the notifications inbox fixture."""
    return (FIXTURES_DIR / "notifications_inbox.html").read_text()


@pytest.fixture
def notifications_inline_code_html() -> str:
    """Load the notifications inline code fixture."""
    return (FIXTURES_DIR / "notifications_inline_code.html").read_text()


class TestParseNotificationsHtml:
    """Tests for the main parse_notifications_html function."""

    def test_parses_pagination_page1(self, pagination_page1_html: str) -> None:
        """Test parsing the first page of paginated notifications."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        # Should have 25 notifications (page size)
        assert len(result.notifications) == 25

        # Check repository info
        assert result.repository.owner == "ezyang0"
        assert result.repository.name == "ghsim-test-20251225075653"
        assert result.repository.full_name == "ezyang0/ghsim-test-20251225075653"

        # Check first notification
        first = result.notifications[0]
        assert first.id.startswith("NT_")
        assert first.unread is True
        assert first.reason == "subscribed"
        assert first.subject.type == "Issue"
        assert first.subject.state == "open"
        assert first.subject.number is not None

    def test_parses_pagination_cursors(self, pagination_page1_html: str) -> None:
        """Test that pagination cursors are extracted correctly."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        # Page 1 should have next but not previous
        assert result.pagination.has_next is True
        assert result.pagination.has_previous is False
        assert result.pagination.after_cursor is not None
        assert result.pagination.before_cursor is None

        # The cursor should be the expected format
        assert result.pagination.after_cursor == "Y3Vyc29yOjI1"

    def test_parses_pagination_page2(self, pagination_page2_html: str) -> None:
        """Test parsing the second page of paginated notifications."""
        result = parse_notifications_html(
            html=pagination_page2_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        # Page 2 should have remaining notifications (5 of 30)
        assert len(result.notifications) == 5

        # Page 2 should have previous but not next
        assert result.pagination.has_previous is True
        assert result.pagination.has_next is False
        assert result.pagination.before_cursor is not None

    def test_parses_read_notification(self, notification_before_done_html: str) -> None:
        """Test parsing a read (not unread) notification."""
        result = parse_notifications_html(
            html=notification_before_done_html,
            owner="ezyang0",
            repo="ghsim-test-20251224224001",
        )

        # Should have at least one notification
        assert len(result.notifications) >= 1

        # Find a read notification
        read_notifications = [n for n in result.notifications if not n.unread]
        assert len(read_notifications) > 0, "Expected to find read notifications"

        read_notif = read_notifications[0]
        assert read_notif.unread is False

    def test_preserves_inline_code_spacing(
        self, notifications_inline_code_html: str
    ) -> None:
        """Ensure inline code in titles keeps backticks and spacing."""
        result = parse_notifications_html(
            html=notifications_inline_code_html,
            owner="test",
            repo="repo",
        )
        assert result.notifications[0].subject.title == (
            "autograd.function with `setup_context` has a number of issues with `torch.compile`"
        )

    def test_extracts_actors(self, pagination_page1_html: str) -> None:
        """Test that actor information is extracted."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        # At least some notifications should have actors
        notifications_with_actors = [n for n in result.notifications if n.actors]
        assert len(notifications_with_actors) > 0

        # Check actor format
        actor = notifications_with_actors[0].actors[0]
        assert actor.login != ""
        assert actor.avatar_url != ""

    def test_extracts_subject_url(self, pagination_page1_html: str) -> None:
        """Test that subject URLs are properly extracted and preserved."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        first = result.notifications[0]

        # URL should preserve query params from the HTML.
        assert "?foo=bar" in first.subject.url
        assert first.subject.url.startswith("https://github.com/")
        assert "/issues/" in first.subject.url or "/pull/" in first.subject.url

    def test_extracts_updated_at(self, pagination_page1_html: str) -> None:
        """Test that updated_at timestamps are extracted."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        first = result.notifications[0]

        # Should have a valid datetime
        assert first.updated_at is not None
        assert first.updated_at.year == 2025

    def test_source_url_default(self, pagination_page1_html: str) -> None:
        """Test that source_url is generated correctly."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="testowner",
            repo="testrepo",
        )

        assert (
            result.source_url
            == "https://github.com/notifications?query=repo:testowner/testrepo"
        )

    def test_source_url_custom(self, pagination_page1_html: str) -> None:
        """Test that custom source_url is preserved."""
        custom_url = "https://github.com/notifications?query=repo:foo/bar&after=xyz"
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="foo",
            repo="bar",
            source_url=custom_url,
        )

        assert result.source_url == custom_url

    def test_generated_at_is_recent(self, pagination_page1_html: str) -> None:
        """Test that generated_at is a recent timestamp."""
        from datetime import datetime, timedelta

        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="test",
            repo="test",
        )

        # Should be within the last minute
        now = datetime.now()
        assert result.generated_at <= now
        assert result.generated_at >= now - timedelta(minutes=1)


class TestIconStateMapping:
    """Tests for icon class to state mapping."""

    def test_issue_opened_maps_to_open(self, pagination_page1_html: str) -> None:
        """Test that octicon-issue-opened maps to Issue/open state."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="ezyang0",
            repo="ghsim-test-20251225075653",
        )

        # All issues in this fixture are open
        for notif in result.notifications:
            assert notif.subject.type == "Issue"
            assert notif.subject.state == "open"


class TestUIState:
    """Tests for UI-specific state extraction."""

    def test_saved_state_default_false(self, pagination_page1_html: str) -> None:
        """Test that saved defaults to false."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="test",
            repo="test",
        )

        for notif in result.notifications:
            # Most notifications should not be saved by default
            assert isinstance(notif.ui.saved, bool)

    def test_done_state_false_in_inbox(self, pagination_page1_html: str) -> None:
        """Test that done is false for inbox view."""
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="test",
            repo="test",
        )

        for notif in result.notifications:
            # Done is always false in inbox view
            assert notif.ui.done is False


class TestEmptyPage:
    """Tests for handling empty or invalid HTML."""

    def test_empty_html(self) -> None:
        """Test parsing empty HTML returns empty notifications."""
        result = parse_notifications_html(
            html="<html><body></body></html>",
            owner="test",
            repo="test",
        )

        assert len(result.notifications) == 0
        assert result.pagination.has_next is False
        assert result.pagination.has_previous is False

    def test_no_notifications_list(self) -> None:
        """Test parsing HTML without notification list."""
        result = parse_notifications_html(
            html="<html><body><div>No notifications</div></body></html>",
            owner="test",
            repo="test",
        )

        assert len(result.notifications) == 0


class TestExtractAuthenticityToken:
    """Tests for extracting authenticity_token from HTML."""

    def test_extracts_token_from_fixture(
        self, notification_before_done_html: str
    ) -> None:
        """Test that token is extracted from real fixture."""
        token = extract_authenticity_token(notification_before_done_html)

        assert token is not None
        # Tokens are base64-ish strings, usually around 86 chars
        assert len(token) > 50
        # Should not contain spaces or newlines
        assert " " not in token
        assert "\n" not in token

    def test_tokens_stable_across_fixtures(
        self, notification_before_done_html: str
    ) -> None:
        """Test that the undo form token is consistent across page loads.

        notification_before_done.html and notification_after_done.html are from
        the same session, so their unarchive form tokens should match.
        """
        token_before = extract_authenticity_token(notification_before_done_html)

        notification_after_done_html = (
            FIXTURES_DIR / "notification_after_done.html"
        ).read_text()
        token_after = extract_authenticity_token(notification_after_done_html)

        assert token_before is not None
        assert token_after is not None
        # Same session = same bulk form token
        assert token_before == token_after

    def test_returns_none_for_empty_html(self) -> None:
        """Test returns None when no forms present."""
        token = extract_authenticity_token("<html><body>No forms</body></html>")
        assert token is None

    def test_returns_none_for_form_without_token(self) -> None:
        """Test returns None when form lacks authenticity_token input."""
        html = """
        <html><body>
        <form action="/notifications/beta/archive" method="post">
            <button type="submit">Submit</button>
        </form>
        </body></html>
        """
        token = extract_authenticity_token(html)
        assert token is None


class TestSessionExpired:
    """Tests for session expired detection."""

    def test_detects_logged_out_class(self) -> None:
        """Test that logged-out body class triggers detection."""
        from bs4 import BeautifulSoup

        html = '<html><body class="logged-out"></body></html>'
        soup = BeautifulSoup(html, "lxml")
        assert is_login_page(soup) is True

    def test_detects_login_route_pattern(self) -> None:
        """Test that /login route pattern triggers detection."""
        from bs4 import BeautifulSoup

        html = '<html><head><meta name="route-pattern" content="/login"></head><body></body></html>'
        soup = BeautifulSoup(html, "lxml")
        assert is_login_page(soup) is True

    def test_detects_empty_user_login_with_auth_header(self) -> None:
        """Test detection via empty user-login + authentication header."""
        from bs4 import BeautifulSoup

        html = """
        <html>
        <head><meta name="user-login" content=""></head>
        <body>
            <div class="session-authentication">Login form here</div>
        </body>
        </html>
        """
        soup = BeautifulSoup(html, "lxml")
        assert is_login_page(soup) is True

    def test_does_not_detect_normal_page(self) -> None:
        """Test that normal logged-in page is not flagged."""
        from bs4 import BeautifulSoup

        html = """
        <html>
        <head><meta name="user-login" content="ezyang"></head>
        <body class="logged-in">
            <div class="notifications-list">...</div>
        </body>
        </html>
        """
        soup = BeautifulSoup(html, "lxml")
        assert is_login_page(soup) is False

    def test_parse_notifications_raises_on_login_page(self) -> None:
        """Test that parse_notifications_html raises SessionExpiredError."""
        html = '<html><body class="logged-out"></body></html>'

        with pytest.raises(SessionExpiredError) as exc_info:
            parse_notifications_html(html=html, owner="test", repo="test")

        assert "session has expired" in str(exc_info.value).lower()

    def test_parse_notifications_succeeds_on_normal_page(
        self, pagination_page1_html: str
    ) -> None:
        """Test that parse_notifications_html works for valid pages."""
        # Should not raise SessionExpiredError
        result = parse_notifications_html(
            html=pagination_page1_html,
            owner="test",
            repo="test",
        )
        assert len(result.notifications) > 0
