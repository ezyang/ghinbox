"""
E2E tests for the FastAPI notifications API.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ghinbox.api.app import app
from ghinbox.api.fetcher import FetchResult

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def client() -> TestClient:
    """Create a test client for the FastAPI app."""
    return TestClient(app)


@pytest.fixture
def pagination_page1_path() -> str:
    """Get the path to the pagination page 1 fixture."""
    return str(FIXTURES_DIR / "pagination_page1.html")


@pytest.fixture
def pagination_page2_path() -> str:
    """Get the path to the pagination page 2 fixture."""
    return str(FIXTURES_DIR / "pagination_page2.html")


class TestHealthEndpoint:
    """Tests for the health check endpoint."""

    def test_health_returns_ok(self, client: TestClient) -> None:
        """Test that the health endpoint returns ok."""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "live_fetching" in data
        assert "account" in data


class TestRootEndpoint:
    """Tests for the root endpoint."""

    def test_root_redirects_to_app(self, client: TestClient) -> None:
        """Test that the root endpoint redirects to the webapp."""
        response = client.get("/", follow_redirects=False)
        # Either redirects to /app/ or returns JSON message
        assert response.status_code in (200, 307)


class TestGetRepoNotifications:
    """Tests for GET /notifications/html/repo/{owner}/{repo}."""

    def test_returns_empty_without_fixture(self, client: TestClient) -> None:
        """Test that endpoint returns empty response without fixture."""
        response = client.get("/notifications/html/repo/testowner/testrepo")

        assert response.status_code == 200
        data = response.json()

        assert data["repository"]["owner"] == "testowner"
        assert data["repository"]["name"] == "testrepo"
        assert data["notifications"] == []

    def test_parses_fixture_file(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test parsing a fixture file."""
        response = client.get(
            "/notifications/html/repo/ezyang0/ghsim-test-20251225075653",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 200
        data = response.json()

        assert len(data["notifications"]) == 25
        assert data["repository"]["owner"] == "ezyang0"
        assert data["repository"]["name"] == "ghsim-test-20251225075653"

    def test_returns_404_for_missing_fixture(self, client: TestClient) -> None:
        """Test that missing fixture returns 404."""
        response = client.get(
            "/notifications/html/repo/test/test",
            params={"fixture": "/nonexistent/path.html"},
        )

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_pagination_cursors_in_response(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test that pagination cursors are in the response."""
        response = client.get(
            "/notifications/html/repo/ezyang0/ghsim-test",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 200
        data = response.json()

        assert data["pagination"]["has_next"] is True
        assert data["pagination"]["has_previous"] is False
        assert data["pagination"]["after_cursor"] is not None

    def test_notification_fields(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test that notification fields are correctly structured."""
        response = client.get(
            "/notifications/html/repo/test/test",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 200
        data = response.json()

        notif = data["notifications"][0]

        # Required fields
        assert "id" in notif
        assert "unread" in notif
        assert "reason" in notif
        assert "updated_at" in notif
        assert "subject" in notif
        assert "actors" in notif
        assert "ui" in notif

        # Subject fields
        subject = notif["subject"]
        assert "title" in subject
        assert "url" in subject
        assert "type" in subject

        # UI fields
        ui = notif["ui"]
        assert "saved" in ui
        assert "done" in ui

    def test_source_url_includes_pagination_params(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test that source_url includes pagination params when provided."""
        response = client.get(
            "/notifications/html/repo/test/test",
            params={
                "fixture": pagination_page1_path,
                "after": "cursor123",
            },
        )

        assert response.status_code == 200
        data = response.json()

        assert "after=cursor123" in data["source_url"]

    def test_live_fetch_session_expired_returns_401(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test live fetch login redirects surface as session_expired."""

        class FakeFetcher:
            def fetch_repo_notifications(
                self,
                owner: str,
                repo: str,
                before: str | None = None,
                after: str | None = None,
            ) -> FetchResult:
                return FetchResult(
                    html="<html><title>Unicorn! - GitHub</title></html>",
                    url=f"https://github.com/notifications?query=repo:{owner}/{repo}",
                    status="session_expired",
                    error="GitHub redirected notifications request to login.",
                )

        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())

        response = client.get("/notifications/html/repo/testowner/testrepo")

        assert response.status_code == 401
        detail = response.json()["detail"]
        assert detail["error"] == "session_expired"
        assert "redirected" in detail["message"]


class TestParseEndpoint:
    """Tests for GET /notifications/html/parse."""

    def test_parses_fixture_directly(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test parsing fixture via /parse endpoint."""
        response = client.get(
            "/notifications/html/parse",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 200
        data = response.json()

        assert len(data["notifications"]) == 25

    def test_uses_provided_owner_repo(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test that owner/repo params are used in response."""
        response = client.get(
            "/notifications/html/parse",
            params={
                "fixture": pagination_page1_path,
                "owner": "customowner",
                "repo": "customrepo",
            },
        )

        assert response.status_code == 200
        data = response.json()

        assert data["repository"]["owner"] == "customowner"
        assert data["repository"]["name"] == "customrepo"

    def test_defaults_to_unknown(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test that owner/repo default to 'unknown'."""
        response = client.get(
            "/notifications/html/parse",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 200
        data = response.json()

        assert data["repository"]["owner"] == "unknown"
        assert data["repository"]["name"] == "unknown"


class TestOpenAPISpec:
    """Tests for OpenAPI specification."""

    def test_openapi_json_available(self, client: TestClient) -> None:
        """Test that OpenAPI JSON is available."""
        response = client.get("/openapi.json")

        assert response.status_code == 200
        data = response.json()

        assert "openapi" in data
        assert "info" in data
        assert "paths" in data

    def test_openapi_has_notification_endpoints(self, client: TestClient) -> None:
        """Test that OpenAPI includes notification endpoints."""
        response = client.get("/openapi.json")

        assert response.status_code == 200
        data = response.json()

        paths = data["paths"]
        assert "/notifications/html/repo/{owner}/{repo}" in paths
        assert "/notifications/html/parse" in paths

    def test_openapi_has_schemas(self, client: TestClient) -> None:
        """Test that OpenAPI includes response schemas."""
        response = client.get("/openapi.json")

        assert response.status_code == 200
        data = response.json()

        schemas = data["components"]["schemas"]
        assert "NotificationsResponse" in schemas
        assert "Notification" in schemas
        assert "Subject" in schemas
        assert "Actor" in schemas
        assert "Pagination" in schemas


class TestResponseSchema:
    """Tests for response schema validation."""

    def test_response_matches_spec(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test that response matches the unified proposal spec."""
        response = client.get(
            "/notifications/html/repo/ezyang0/ghsim-test",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 200
        data = response.json()

        # Top-level fields per spec
        assert "source_url" in data
        assert "generated_at" in data
        assert "repository" in data
        assert "notifications" in data
        assert "pagination" in data

        # Repository fields per spec
        repo = data["repository"]
        assert "owner" in repo
        assert "name" in repo
        assert "full_name" in repo

        # Pagination fields per spec
        pagination = data["pagination"]
        assert "before_cursor" in pagination
        assert "after_cursor" in pagination
        assert "has_previous" in pagination
        assert "has_next" in pagination

        # Notification fields per spec
        if data["notifications"]:
            notif = data["notifications"][0]
            assert "id" in notif
            assert "unread" in notif
            assert "reason" in notif
            assert "updated_at" in notif
            assert "subject" in notif
            assert "actors" in notif
            assert "ui" in notif

            # Subject fields per spec
            subject = notif["subject"]
            assert "title" in subject
            assert "url" in subject
            assert "type" in subject
            assert "number" in subject
            assert "state" in subject
            assert "state_reason" in subject

            # UI fields per spec
            ui = notif["ui"]
            assert "saved" in ui
            assert "done" in ui
