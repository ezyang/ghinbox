"""
E2E tests for the FastAPI notifications API.
"""

from pathlib import Path
import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from ghinbox.api.app import app
from ghinbox.api.fetcher import ActionResult, FetchResult
from ghinbox.api import login_routes

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


class TestSnapshotEndpoints:
    """Tests for server-owned snapshot endpoints."""

    def test_snapshot_returns_empty_without_sync(self, client: TestClient) -> None:
        """Test that unknown repos return an empty snapshot envelope."""
        response = client.get("/api/snapshots/testowner/testrepo")

        assert response.status_code == 200
        data = response.json()
        assert data["repository"]["full_name"] == "testowner/testrepo"
        assert data["snapshot"] is None
        assert data["sync"]["status"] == "idle"

    def test_start_sync_requires_live_fetcher(self, client: TestClient) -> None:
        """Test that background sync fails fast without a configured fetcher."""
        response = client.post(
            "/api/snapshots/testowner/testrepo/sync",
            json={"mode": "full"},
        )

        assert response.status_code == 503
        assert "No GitHub fetcher configured" in response.json()["detail"]


class TestDebugEndpoints:
    """Tests for local observability endpoints."""

    def test_debug_state_returns_non_secret_state(self, client: TestClient) -> None:
        """Test that debug state exposes safe server metadata."""
        response = client.get("/debug/state")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "live_fetching" in data
        assert "site_auth_enabled" in data
        assert "request_log_enabled" in data
        assert "GHINBOX_SITE_PASSWORD" not in data

    def test_recent_requests_records_request_metadata(self, client: TestClient) -> None:
        """Test that recent requests include method, path, status, and request ID."""
        clear_response = client.post("/debug/requests/clear")
        assert clear_response.status_code == 200

        health_response = client.get("/health")
        assert health_response.status_code == 200
        assert health_response.headers["x-ghinbox-request-id"]

        response = client.get("/debug/requests")
        assert response.status_code == 200
        data = response.json()

        health_entries = [
            entry for entry in data["requests"] if entry["path"] == "/health"
        ]
        assert health_entries
        assert health_entries[-1]["method"] == "GET"
        assert health_entries[-1]["status_code"] == 200
        assert (
            health_entries[-1]["request_id"]
            == health_response.headers["x-ghinbox-request-id"]
        )
        assert "duration_ms" in health_entries[-1]


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
        assert os.environ["GHINBOX_NEEDS_AUTH"] == "1"


class TestNotificationActions:
    """Tests for POST /notifications/html/action."""

    def test_submit_action_reports_session_expired_when_auth_refresh_is_needed(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test action failures point at login when the browser fetcher is absent due auth."""
        monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": ["notif-1"],
                "authenticity_token": "token-123",
            },
        )

        assert response.status_code == 401
        detail = response.json()["detail"]
        assert detail["error"] == "session_expired"
        assert "browser session is expired" in detail["message"].lower()

    def test_submit_action_accepts_batched_notification_ids(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test that batched Mark done requests are passed to the fetcher intact."""
        calls: list[dict[str, object]] = []

        class FakeFetcher:
            def submit_notification_action(
                self,
                action: str,
                notification_ids: list[str],
                authenticity_token: str,
            ) -> ActionResult:
                calls.append(
                    {
                        "action": action,
                        "notification_ids": notification_ids,
                        "authenticity_token": authenticity_token,
                    }
                )
                return ActionResult(status="ok")

        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": ["notif-1", "notif-3", "notif-5"],
                "authenticity_token": "token-123",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [
            {
                "action": "archive",
                "notification_ids": ["notif-1", "notif-3", "notif-5"],
                "authenticity_token": "token-123",
            }
        ]

    def test_submit_action_chunks_large_batches_for_github(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test large Mark done requests are split before posting to GitHub."""
        calls: list[list[str]] = []

        class FakeFetcher:
            def submit_notification_action(
                self,
                action: str,
                notification_ids: list[str],
                authenticity_token: str,
            ) -> ActionResult:
                assert action == "archive"
                assert authenticity_token == "token-123"
                calls.append(notification_ids)
                return ActionResult(status="ok", github_status_code=200)

        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())

        notification_ids = [f"notif-{index}" for index in range(41)]
        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": notification_ids,
                "authenticity_token": "token-123",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [notification_ids[:25], notification_ids[25:]]

    def test_submit_action_records_sanitized_audit_event(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test that action logging records IDs without exposing the token."""

        class FakeFetcher:
            def submit_notification_action(
                self,
                action: str,
                notification_ids: list[str],
                authenticity_token: str,
            ) -> ActionResult:
                assert authenticity_token == "secret-token-123"
                return ActionResult(status="ok", github_status_code=200)

        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())

        clear_response = client.post("/debug/notification-actions/clear")
        assert clear_response.status_code == 200

        action_response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": ["notif-1", "notif-3"],
                "authenticity_token": "secret-token-123",
            },
        )
        assert action_response.status_code == 200
        request_id = action_response.headers["x-ghinbox-request-id"]

        audit_response = client.get("/debug/notification-actions")
        assert audit_response.status_code == 200
        actions = audit_response.json()["actions"]

        assert actions == [
            {
                "timestamp": actions[0]["timestamp"],
                "event": "notification_action",
                "request_id": request_id,
                "action": "archive",
                "notification_count": 2,
                "notification_ids": actions[0]["notification_ids"],
                "token_present": True,
                "status": "ok",
                "error": None,
                "github_status_code": 200,
                "duration_ms": actions[0]["duration_ms"],
            }
        ]
        assert actions[0]["notification_ids"][0]["prefix"] == "notif-1"
        assert actions[0]["notification_ids"][0]["suffix"] == "notif-1"
        assert len(actions[0]["notification_ids"][0]["sha256"]) == 64
        assert "secret-token-123" not in str(actions[0])


class TestLoginRefresh:
    """Tests for refreshing GitHub browser-session auth."""

    def test_initialize_fetcher_stops_old_fetcher_in_worker(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test refresh avoids calling Playwright sync APIs on the event loop."""
        calls: list[str] = []

        class OldFetcher:
            def stop(self) -> None:
                raise AssertionError("stop must be called through run_fetcher_call")

        class NewFetcher:
            def __init__(self, account: str, headless: bool) -> None:
                calls.append(f"new:{account}:{headless}")

        async def fake_run_fetcher_call(func, *args, **kwargs):
            assert func == old_fetcher.stop
            calls.append("worker-stop")

        stored_fetcher = OldFetcher()
        old_fetcher = stored_fetcher

        def fake_get_fetcher():
            return stored_fetcher

        def fake_set_fetcher(fetcher):
            calls.append(f"set:{type(fetcher).__name__ if fetcher else None}")

        monkeypatch.setattr(login_routes, "get_fetcher", fake_get_fetcher)
        monkeypatch.setattr(login_routes, "set_fetcher", fake_set_fetcher)
        monkeypatch.setattr(login_routes, "NotificationsFetcher", NewFetcher)
        monkeypatch.setattr(login_routes, "run_fetcher_call", fake_run_fetcher_call)

        result = asyncio.run(login_routes._initialize_fetcher_after_login("default"))

        assert result is True
        assert calls == [
            "worker-stop",
            "set:None",
            "new:default:True",
            "set:NewFetcher",
        ]


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
