"""
E2E tests for the FastAPI notifications API.
"""

from pathlib import Path
import asyncio
import os
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from ghinbox.api.app import app
from ghinbox.api.fetcher import ActionResult, FetchResult
from ghinbox.api import github_proxy, login_routes
from ghinbox.api.rate_governor import get_rate_governor

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


@pytest.fixture
def fixture_file_test_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Enable the fixture file query parameter for tests that need it."""
    monkeypatch.setenv("GHINBOX_TEST_MODE", "1")


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

    def test_debug_rate_governor_returns_non_secret_state(
        self,
        client: TestClient,
    ) -> None:
        """Test the rate-governor debug surface exposes current pool state."""
        get_rate_governor().update_from_headers(
            {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4500",
                "x-ratelimit-used": "500",
                "x-ratelimit-reset": "4102444800",
                "x-ratelimit-resource": "core",
            },
            observed_at=datetime(2026, 7, 6, 12, 0, tzinfo=UTC),
        )

        response = client.get("/debug/rate-governor")

        assert response.status_code == 200
        data = response.json()
        assert data["floors"] == {"background": 500, "interactive": 100}
        assert data["request_budget"] == 300
        assert data["pools"]["core"]["remaining"] == 4500
        assert data["recent_denials"] == []


class TestRateGovernorEndpoints:
    """Tests for GitHub API governor enforcement at HTTP boundaries."""

    def test_rest_proxy_governor_denial_returns_429_and_audit(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Test REST proxy denials are structured and diagnosable."""

        class FakeClient:
            async def request(self, *args, **kwargs):
                raise AssertionError("governor should deny before GitHub request")

        monkeypatch.delenv("GHINBOX_TEST_MODE", raising=False)
        monkeypatch.setattr(github_proxy, "get_token", lambda: "api-token")
        monkeypatch.setattr(github_proxy, "get_client", lambda: FakeClient())
        get_rate_governor().update_from_headers(
            {
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "50",
                "x-ratelimit-used": "4950",
                "x-ratelimit-reset": "4102444800",
                "x-ratelimit-resource": "core",
            },
            observed_at=datetime(2026, 7, 6, 12, 0, tzinfo=UTC),
        )

        clear_response = client.post("/debug/github-api-calls/clear")
        assert clear_response.status_code == 200

        response = client.get("/github/rest/user")

        assert response.status_code == 429
        request_id = response.headers["x-ghinbox-request-id"]
        detail = response.json()["detail"]
        assert detail["error"] == "github_rate_governor_denied"
        assert detail["reason"] == "remaining_below_floor"
        assert detail["pool"] == "core"
        assert detail["remaining"] == 50
        assert detail["floor"] == 100
        assert detail["reset_at"] == "2100-01-01T00:00:00Z"
        assert detail["request_id"] == request_id

        audit_response = client.get("/debug/github-api-calls")
        assert audit_response.status_code == 200
        calls = audit_response.json()["calls"]
        assert calls == [
            {
                "timestamp": calls[0]["timestamp"],
                "event": "github_api_call",
                "request_id": request_id,
                "source": "rest_proxy",
                "method": "GET",
                "endpoint": "/user",
                "status_code": 429,
                "duration_ms": 0,
                "error": "rate_governor_denied",
                "governor_denial": {
                    "error": "github_rate_governor_denied",
                    "message": detail["message"],
                    "reason": "remaining_below_floor",
                    "pool": "core",
                    "remaining": 50,
                    "floor": 100,
                    "reset_at": "2100-01-01T00:00:00Z",
                    "call_class": "interactive",
                    "request_id": request_id,
                    "request_count": 0,
                    "request_budget": 300,
                },
            }
        ]

        governor_response = client.get("/debug/rate-governor")
        assert governor_response.status_code == 200
        denials = governor_response.json()["recent_denials"]
        assert denials[-1]["request_id"] == request_id
        assert denials[-1]["source"] == "rest_proxy"
        assert denials[-1]["reason"] == "remaining_below_floor"

    def test_bulk_comments_returns_partial_results_when_rate_limited(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Test bulk comment fetches surface partial results on governor denial."""

        async def fake_fetch_bulk_comment_results(
            token: str,
            items: list[dict],
            on_progress=None,
            request_id: str | None = None,
        ) -> github_proxy.BulkCommentFetchResults:
            assert token == "api-token"
            assert items == [{"key": "one"}, {"key": "two"}]
            assert request_id
            return github_proxy.BulkCommentFetchResults(
                [("one", {"comments": [{"id": 1}]})],
                rate_limited=True,
                denial={
                    "error": "github_rate_governor_denied",
                    "reason": "request_budget_exceeded",
                    "pool": "core",
                    "remaining": 1000,
                    "floor": 500,
                    "reset_at": "2100-01-01T00:00:00Z",
                    "call_class": "background",
                    "request_budget": 300,
                    "request_count": 300,
                },
            )

        monkeypatch.setattr(github_proxy, "get_token", lambda: "api-token")
        monkeypatch.setattr(
            github_proxy,
            "fetch_bulk_comment_results",
            fake_fetch_bulk_comment_results,
        )

        response = client.post(
            "/github/rest/comments/bulk",
            json={"items": [{"key": "one"}, {"key": "two"}]},
        )

        assert response.status_code == 200
        assert response.json() == {
            "threads": {"one": {"comments": [{"id": 1}]}},
            "rate_limited": True,
            "rate_limit": {
                "error": "github_rate_governor_denied",
                "reason": "request_budget_exceeded",
                "pool": "core",
                "remaining": 1000,
                "floor": 500,
                "reset_at": "2100-01-01T00:00:00Z",
                "call_class": "background",
                "request_budget": 300,
                "request_count": 300,
            },
        }


class TestRootEndpoint:
    """Tests for the root endpoint."""

    def test_root_redirects_to_app(self, client: TestClient) -> None:
        """Test that the root endpoint redirects to the webapp."""
        response = client.get("/", follow_redirects=False)
        # Either redirects to /app/ or returns JSON message
        assert response.status_code in (200, 307)


class TestGetRepoNotifications:
    """Tests for GET /notifications/html/repo/{owner}/{repo}."""

    def test_returns_503_without_fetcher(self, client: TestClient) -> None:
        """Test that missing live fetching fails loudly instead of looking empty."""
        response = client.get("/notifications/html/repo/testowner/testrepo")

        assert response.status_code == 503
        assert "No GitHub fetcher configured" in response.json()["detail"]

    def test_returns_session_expired_without_fetcher_when_auth_refresh_is_needed(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test absent browser fetcher due auth expiry returns the structured 401."""
        monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)

        response = client.get("/notifications/html/repo/testowner/testrepo")

        assert response.status_code == 401
        detail = response.json()["detail"]
        assert detail["error"] == "session_expired"
        assert "browser session is expired" in detail["message"].lower()

    def test_fixture_param_requires_test_mode(
        self, client: TestClient, pagination_page1_path: str
    ) -> None:
        """Test fixture file parsing is not exposed outside test mode."""
        response = client.get(
            "/notifications/html/repo/ezyang0/ghsim-test-20251225075653",
            params={"fixture": pagination_page1_path},
        )

        assert response.status_code == 403
        assert "test mode" in response.json()["detail"]

    @pytest.mark.usefixtures("fixture_file_test_mode")
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

    @pytest.mark.usefixtures("fixture_file_test_mode")
    def test_returns_404_for_missing_fixture(self, client: TestClient) -> None:
        """Test that missing fixture returns 404."""
        response = client.get(
            "/notifications/html/repo/test/test",
            params={"fixture": "/nonexistent/path.html"},
        )

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    @pytest.mark.usefixtures("fixture_file_test_mode")
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

    @pytest.mark.usefixtures("fixture_file_test_mode")
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

    @pytest.mark.usefixtures("fixture_file_test_mode")
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


class TestGetQueryNotifications:
    """Tests for GET /notifications/html/query."""

    def test_returns_session_expired_without_fetcher_when_auth_refresh_is_needed(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test query fetches also surface missing auth as session_expired."""
        monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)

        response = client.get(
            "/notifications/html/query",
            params={"query": "repo:testowner/testrepo"},
        )

        assert response.status_code == 401
        detail = response.json()["detail"]
        assert detail["error"] == "session_expired"
        assert "browser session is expired" in detail["message"].lower()


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

    def test_submit_action_returns_session_expired_when_fetcher_reports_it(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test stale form submissions become structured session-expired 401s."""

        class FakeFetcher:
            def submit_notification_action(
                self,
                action: str,
                notification_ids: list[str],
                authenticity_token: str,
            ) -> ActionResult:
                assert action == "archive"
                assert notification_ids == ["notif-1"]
                assert authenticity_token == "stale-form-token"
                return ActionResult(
                    status="session_expired",
                    error="GitHub returned 422 while submitting notification action.",
                    github_status_code=422,
                )

        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": ["notif-1"],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 401
        detail = response.json()["detail"]
        assert detail["error"] == "session_expired"
        assert "422" in detail["message"]
        assert os.environ["GHINBOX_NEEDS_AUTH"] == "1"

    def test_submit_action_archives_with_token_backed_rest_api(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test legacy Mark Done IDs can use the GitHub API token directly."""
        calls: list[dict[str, object]] = []

        class FakeResponse:
            status_code = 205
            text = ""

        class FakeClient:
            async def request(
                self,
                method: str,
                url: str,
                headers: dict[str, str],
            ) -> FakeResponse:
                calls.append({"method": method, "url": url, "headers": headers})
                return FakeResponse()

        monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_token",
            lambda: "api-token",
            raising=False,
        )
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_client",
            lambda: FakeClient(),
            raising=False,
        )

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": ["NT_kwDOAZShobQyMTUwNzkzMzkyMToyNjUxNzkyMQ"],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [
            {
                "method": "DELETE",
                "url": "https://api.github.com/notifications/threads/21507933921",
                "headers": {
                    "Authorization": "Bearer api-token",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            }
        ]

    @pytest.mark.parametrize(
        ("action", "expected_payload"),
        [
            ("subscribe", {"subscribed": True, "ignored": False}),
            ("unsubscribe", {"subscribed": False, "ignored": True}),
        ],
    )
    def test_submit_action_uses_rest_for_thread_subscriptions(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        action: str,
        expected_payload: dict[str, bool],
    ) -> None:
        calls: list[dict[str, object]] = []

        class FakeResponse:
            status_code = 200
            text = ""
            headers: dict[str, str] = {}

        class FakeClient:
            async def request(
                self,
                method: str,
                url: str,
                headers: dict[str, str],
                **kwargs: object,
            ) -> FakeResponse:
                calls.append({"method": method, "url": url, "json": kwargs.get("json")})
                return FakeResponse()

        monkeypatch.setattr(
            "ghinbox.api.routes.get_fetcher",
            lambda: pytest.fail(f"{action} must not use the browser fetcher"),
        )
        monkeypatch.setattr("ghinbox.api.archive_api.get_token", lambda: "api-token")
        monkeypatch.setattr("ghinbox.api.archive_api.get_client", lambda: FakeClient())

        response = client.post(
            "/notifications/html/action",
            json={
                "action": action,
                "notification_ids": ["NT_kwDOAZShobQyMTUwNzkzMzkyMToyNjUxNzkyMQ"],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [
            {
                "method": "PUT",
                "url": (
                    "https://api.github.com/notifications/threads/"
                    "21507933921/subscription"
                ),
                "json": expected_payload,
            }
        ]

    def test_submit_action_prunes_archived_ids_from_stored_snapshot(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A successful archive removes those IDs from the stored SQLite snapshot
        so an open tab can pick up the change via Server Refresh (no GitHub sync).
        """
        from ghinbox.api import snapshot_store

        archived_id = "NT_kwDOAZShobQyMTUwNzkzMzkyMToyNjUxNzkyMQ"
        kept_id = "NT_kwDOAZShobQyMTUwNzkzMzkyMToyNjUxNzkyMg"
        snapshot_store.save_snapshot(
            "pytorch/pytorch",
            [
                {"id": archived_id, "subject": {"title": "Archived"}},
                {"id": kept_id, "subject": {"title": "Kept"}},
            ],
        )

        class FakeResponse:
            status_code = 205
            text = ""

        class FakeClient:
            async def request(
                self, method: str, url: str, headers: dict[str, str]
            ) -> FakeResponse:
                return FakeResponse()

        monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_token", lambda: "api-token", raising=False
        )
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_client", lambda: FakeClient(), raising=False
        )

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": [archived_id],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}

        snapshot = snapshot_store.get_snapshot("pytorch/pytorch")
        assert snapshot is not None
        remaining_ids = [n["id"] for n in snapshot["notifications"]]
        assert remaining_ids == [kept_id]

    @pytest.mark.parametrize(
        ("action", "expected_remaining_ids"),
        [
            ("archive", ["kept-id"]),
            ("unsubscribe", ["kept-id"]),
            ("unarchive", ["acted-id", "kept-id"]),
            ("subscribe", ["acted-id", "kept-id"]),
        ],
    )
    def test_submit_action_snapshot_prune_policy_enumerates_supported_actions(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        action: str,
        expected_remaining_ids: list[str],
    ) -> None:
        """Only inbox-removing actions prune the stored snapshot."""
        from ghinbox.api import snapshot_store

        calls: list[dict[str, object]] = []
        snapshot_store.save_snapshot(
            "pytorch/pytorch",
            [
                {"id": "acted-id", "subject": {"title": "Acted on"}},
                {"id": "kept-id", "subject": {"title": "Kept"}},
            ],
        )

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

        monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())
        monkeypatch.setattr("ghinbox.api.routes.get_token", lambda: None, raising=False)

        response = client.post(
            "/notifications/html/action",
            json={
                "action": action,
                "notification_ids": ["acted-id"],
                "authenticity_token": "form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [
            {
                "action": action,
                "notification_ids": ["acted-id"],
                "authenticity_token": "form-token",
            }
        ]

        snapshot = snapshot_store.get_snapshot("pytorch/pytorch")
        assert snapshot is not None
        assert [n["id"] for n in snapshot["notifications"]] == expected_remaining_ids

    def test_submit_action_maps_current_html_ids_to_rest_threads(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test current GitHub HTML IDs are mapped to REST notification threads."""
        current_html_id = (
            "NT_kwHNNPzaACRSZXBvc2l0b3J5OzY1NjAwOTc1O0lzc3VlOzQ3MjMzNjQ2Njc"
        )
        calls: list[dict[str, object]] = []

        class FakeResponse:
            def __init__(
                self,
                status_code: int,
                payload: object | None = None,
                headers: dict[str, str] | None = None,
                text: str = "",
            ) -> None:
                self.status_code = status_code
                self.payload = payload
                self.headers = headers or {}
                self.text = text

            def json(self) -> object:
                return self.payload

        class FakeClient:
            async def get(
                self,
                url: str,
                headers: dict[str, str],
            ) -> FakeResponse:
                calls.append({"method": "GET", "url": url, "headers": headers})
                return FakeResponse(
                    200,
                    [
                        {
                            "id": "24335693536",
                            "subject": {
                                "url": "https://api.github.com/repos/pytorch/pytorch/pulls/187924"
                            },
                        }
                    ],
                )

            async def request(
                self,
                method: str,
                url: str,
                headers: dict[str, str],
            ) -> FakeResponse:
                calls.append({"method": method, "url": url, "headers": headers})
                return FakeResponse(205)

        monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)
        monkeypatch.setattr("ghinbox.api.archive_api.get_token", lambda: "api-token")
        monkeypatch.setattr("ghinbox.api.archive_api.get_client", lambda: FakeClient())
        monkeypatch.setattr(
            "ghinbox.api.archive_api.list_snapshot_repos",
            lambda: ["pytorch/pytorch"],
        )
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_snapshot",
            lambda repo: {
                "notifications": [
                    {
                        "id": current_html_id,
                        "subject": {
                            "url": (
                                "https://github.com/pytorch/pytorch/pull/187924"
                                f"?notification_referrer_id={current_html_id}"
                            )
                        },
                    }
                ]
            },
        )

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": [current_html_id],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [
            {
                "method": "GET",
                "url": "https://api.github.com/repos/pytorch/pytorch/notifications?all=true&per_page=100",
                "headers": {
                    "Authorization": "Bearer api-token",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            },
            {
                "method": "DELETE",
                "url": "https://api.github.com/notifications/threads/24335693536",
                "headers": {
                    "Authorization": "Bearer api-token",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            },
        ]

    def test_submit_action_maps_release_html_id_to_rest_thread(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Release tag URLs use the database ID encoded in the HTML node ID."""
        release_id = (
            "NT_kwHNNPzaACdSZXBvc2l0b3J5OzExOTY2MTQyNzM7UmVsZWFzZTszNTQ2MzgxMzc"
        )
        calls: list[tuple[str, str]] = []

        class FakeResponse:
            status_code = 200
            text = ""
            headers: dict[str, str] = {}

            def __init__(self, payload: object | None = None) -> None:
                self.payload = payload

            def json(self) -> object | None:
                return self.payload

        class FakeClient:
            async def get(self, url: str, headers: dict[str, str]) -> FakeResponse:
                calls.append(("GET", url))
                return FakeResponse(
                    [
                        {
                            "id": "25463813700",
                            "subject": {
                                "url": (
                                    "https://api.github.com/repos/meta-pytorch/"
                                    "spmd_types/releases/354638137"
                                )
                            },
                        }
                    ]
                )

            async def request(
                self, method: str, url: str, headers: dict[str, str]
            ) -> FakeResponse:
                calls.append((method, url))
                return FakeResponse()

        monkeypatch.setattr(
            "ghinbox.api.routes.get_fetcher",
            lambda: pytest.fail("Release archive must not use the browser fetcher"),
        )
        monkeypatch.setattr("ghinbox.api.archive_api.get_token", lambda: "api-token")
        monkeypatch.setattr("ghinbox.api.archive_api.get_client", lambda: FakeClient())
        monkeypatch.setattr(
            "ghinbox.api.archive_api.list_snapshot_repos", lambda: ["profile:pytorch"]
        )
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_snapshot",
            lambda repo: {
                "notifications": [
                    {
                        "id": release_id,
                        "subject": {
                            "type": "Release",
                            "url": (
                                "https://github.com/meta-pytorch/spmd_types/"
                                "releases/tag/v0.2.2"
                            ),
                        },
                    }
                ]
            },
        )

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": [release_id],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "error": None}
        assert calls == [
            (
                "GET",
                "https://api.github.com/repos/meta-pytorch/spmd_types/"
                "notifications?all=true&per_page=100",
            ),
            (
                "DELETE",
                "https://api.github.com/notifications/threads/25463813700",
            ),
        ]

    def test_submit_action_archives_resolvable_ids_without_browser_fallback(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """One unsupported ID must not poison resolvable IDs in the batch."""
        from ghinbox.api import snapshot_store

        resolvable_id = "NT_kwDOAZShobQyMTUwNzkzMzkyMToyNjUxNzkyMQ"
        unsupported_id = "unsupported-notification-id"
        calls: list[str] = []
        snapshot_store.save_snapshot(
            "profile:pytorch",
            [
                {"id": resolvable_id, "subject": {"title": "Resolvable"}},
                {"id": unsupported_id, "subject": {"title": "Unsupported"}},
            ],
        )

        class FakeResponse:
            status_code = 205
            text = ""
            headers: dict[str, str] = {}

        class FakeClient:
            async def request(
                self, method: str, url: str, headers: dict[str, str]
            ) -> FakeResponse:
                calls.append(url)
                return FakeResponse()

        monkeypatch.setenv("GHINBOX_NEEDS_AUTH", "1")
        monkeypatch.setattr(
            "ghinbox.api.routes.get_fetcher",
            lambda: pytest.fail(
                "Partial REST archive must not use the browser fetcher"
            ),
        )
        monkeypatch.setattr("ghinbox.api.archive_api.get_token", lambda: "api-token")
        monkeypatch.setattr("ghinbox.api.archive_api.get_client", lambda: FakeClient())
        monkeypatch.setattr("ghinbox.api.archive_api.list_snapshot_repos", lambda: [])

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": [resolvable_id, unsupported_id],
                "authenticity_token": "stale-form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {
            "status": "partial",
            "error": "Archived 1 of 2 notifications; 1 could not be resolved by REST.",
            "successful_notification_ids": [resolvable_id],
            "unresolved_notification_ids": [unsupported_id],
        }
        assert calls == ["https://api.github.com/notifications/threads/21507933921"]
        snapshot = snapshot_store.get_snapshot("profile:pytorch")
        assert snapshot is not None
        assert [item["id"] for item in snapshot["notifications"]] == [unsupported_id]

    def test_submit_action_records_github_api_rate_limit_audit(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test internal GitHub API calls are logged with sanitized rate-limit data."""
        current_html_id = (
            "NT_kwHNNPzaACRSZXBvc2l0b3J5OzY1NjAwOTc1O0lzc3VlOzQ3MjMzNjQ2Njc"
        )

        class FakeResponse:
            def __init__(
                self,
                status_code: int,
                payload: object | None = None,
                headers: dict[str, str] | None = None,
                text: str = "",
            ) -> None:
                self.status_code = status_code
                self.payload = payload
                self.headers = headers or {}
                self.text = text

            def json(self) -> object:
                return self.payload

        class FakeClient:
            async def get(
                self,
                url: str,
                headers: dict[str, str],
            ) -> FakeResponse:
                return FakeResponse(
                    200,
                    [
                        {
                            "id": "24335693536",
                            "subject": {
                                "url": "https://api.github.com/repos/pytorch/pytorch/pulls/187924"
                            },
                        }
                    ],
                    headers={
                        "X-RateLimit-Limit": "5000",
                        "X-RateLimit-Remaining": "4998",
                        "X-RateLimit-Used": "2",
                        "X-RateLimit-Reset": "1782317623",
                        "X-RateLimit-Resource": "core",
                    },
                )

            async def request(
                self,
                method: str,
                url: str,
                headers: dict[str, str],
            ) -> FakeResponse:
                return FakeResponse(
                    205,
                    headers={
                        "X-RateLimit-Limit": "5000",
                        "X-RateLimit-Remaining": "4997",
                        "X-RateLimit-Used": "3",
                        "X-RateLimit-Reset": "1782317623",
                        "X-RateLimit-Resource": "core",
                    },
                )

        monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: None)
        monkeypatch.setattr("ghinbox.api.archive_api.get_token", lambda: "api-token")
        monkeypatch.setattr("ghinbox.api.archive_api.get_client", lambda: FakeClient())
        monkeypatch.setattr(
            "ghinbox.api.archive_api.list_snapshot_repos",
            lambda: ["pytorch/pytorch"],
        )
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_snapshot",
            lambda repo: {
                "notifications": [
                    {
                        "id": current_html_id,
                        "subject": {
                            "url": (
                                "https://github.com/pytorch/pytorch/pull/187924"
                                f"?notification_referrer_id={current_html_id}"
                            )
                        },
                    }
                ]
            },
        )

        clear_response = client.post("/debug/github-api-calls/clear")
        assert clear_response.status_code == 200

        action_response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": [current_html_id],
                "authenticity_token": "stale-form-token",
            },
        )

        assert action_response.status_code == 200
        request_id = action_response.headers["x-ghinbox-request-id"]

        audit_response = client.get("/debug/github-api-calls")
        assert audit_response.status_code == 200
        calls = audit_response.json()["calls"]
        assert calls == [
            {
                "timestamp": calls[0]["timestamp"],
                "event": "github_api_call",
                "request_id": request_id,
                "source": "archive.thread_lookup",
                "method": "GET",
                "endpoint": "/repos/pytorch/pytorch/notifications",
                "status_code": 200,
                "duration_ms": calls[0]["duration_ms"],
                "query_keys": ["all", "per_page"],
                "rate_limit": {
                    "limit": "5000",
                    "remaining": "4998",
                    "used": "2",
                    "reset": "1782317623",
                    "resource": "core",
                },
            },
            {
                "timestamp": calls[1]["timestamp"],
                "event": "github_api_call",
                "request_id": request_id,
                "source": "archive.thread_delete",
                "method": "DELETE",
                "endpoint": "/notifications/threads/24335693536",
                "status_code": 205,
                "duration_ms": calls[1]["duration_ms"],
                "rate_limit": {
                    "limit": "5000",
                    "remaining": "4997",
                    "used": "3",
                    "reset": "1782317623",
                    "resource": "core",
                },
            },
        ]
        assert "api-token" not in str(calls)
        assert current_html_id not in str(calls)

    def test_submit_action_caps_current_html_id_rest_lookup(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A capped REST lookup reports the ID without falling back to browser."""
        current_html_id = (
            "NT_kwHNNPzaACRSZXBvc2l0b3J5OzY1NjAwOTc1O0lzc3VlOzQ3MjMzNjQ2Njc"
        )
        lookup_calls: list[dict[str, object]] = []
        fallback_calls: list[list[str]] = []

        class FakeResponse:
            status_code = 200
            text = ""

            def __init__(self, page: int) -> None:
                self.headers = (
                    {
                        "link": (
                            "<https://api.github.com/repos/pytorch/pytorch/"
                            f'notifications?page={page + 1}>; rel="next"'
                        )
                    }
                    if page < 3
                    else {}
                )

            def json(self) -> object:
                return []

        class FakeClient:
            async def get(
                self,
                url: str,
                headers: dict[str, str],
            ) -> FakeResponse:
                lookup_calls.append({"url": url})
                return FakeResponse(len(lookup_calls))

        class FakeFetcher:
            def submit_notification_action(
                self,
                action: str,
                notification_ids: list[str],
                authenticity_token: str,
            ) -> ActionResult:
                assert action == "archive"
                assert authenticity_token == "form-token"
                fallback_calls.append(notification_ids)
                return ActionResult(status="ok", github_status_code=200)

        monkeypatch.delenv("GHINBOX_NEEDS_AUTH", raising=False)
        monkeypatch.setattr("ghinbox.api.archive_api.MAX_REST_THREAD_LOOKUP_PAGES", 2)
        monkeypatch.setattr("ghinbox.api.routes.get_fetcher", lambda: FakeFetcher())
        monkeypatch.setattr("ghinbox.api.archive_api.get_token", lambda: "api-token")
        monkeypatch.setattr("ghinbox.api.archive_api.get_client", lambda: FakeClient())
        monkeypatch.setattr(
            "ghinbox.api.archive_api.list_snapshot_repos",
            lambda: ["pytorch/pytorch"],
        )
        monkeypatch.setattr(
            "ghinbox.api.archive_api.get_snapshot",
            lambda repo: {
                "notifications": [
                    {
                        "id": current_html_id,
                        "subject": {
                            "url": (
                                "https://github.com/pytorch/pytorch/pull/187924"
                                f"?notification_referrer_id={current_html_id}"
                            )
                        },
                    }
                ]
            },
        )

        response = client.post(
            "/notifications/html/action",
            json={
                "action": "archive",
                "notification_ids": [current_html_id],
                "authenticity_token": "form-token",
            },
        )

        assert response.status_code == 200
        assert response.json() == {
            "status": "error",
            "error": "Archived 0 of 1 notifications; 1 could not be resolved by REST.",
            "successful_notification_ids": [],
            "unresolved_notification_ids": [current_html_id],
        }
        assert len(lookup_calls) == 2
        assert fallback_calls == []

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
        assert "/notifications/html/parse" not in paths

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

    @pytest.mark.usefixtures("fixture_file_test_mode")
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
