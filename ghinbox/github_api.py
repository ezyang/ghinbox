"""
GitHub API client and common utilities.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from ghinbox.github_headers import github_graphql_headers, github_rest_headers

RESPONSES_DIR = Path("responses")


class GitHubAPI:
    """Simple GitHub API client using urllib (no external deps)."""

    BASE_URL = "https://api.github.com"

    def __init__(self, token: str):
        self.token = token
        self._user_cache: Any = None

    def _request(
        self,
        method: str,
        endpoint: str,
        data: dict | None = None,
    ) -> dict | list | None:
        """Make an API request."""
        url = f"{self.BASE_URL}{endpoint}"
        headers = github_rest_headers(self.token)

        body = None
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(request) as response:
                if response.status == 204:  # No content
                    return None
                body = response.read()
                if not body:
                    return None
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else ""
            print(f"API Error {e.code}: {e.reason}")
            print(f"  URL: {url}")
            print(f"  Body: {error_body}")
            raise

    def _with_params(self, endpoint: str, params: dict[str, str]) -> str:
        if not params:
            return endpoint
        return f"{endpoint}?{urllib.parse.urlencode(params)}"

    def get(self, endpoint: str) -> dict | list | None:
        return self._request("GET", endpoint)

    def post(self, endpoint: str, data: dict) -> Any:
        return self._request("POST", endpoint, data)

    def delete(self, endpoint: str) -> None:
        self._request("DELETE", endpoint)

    def put(self, endpoint: str, data: dict | None = None) -> Any:
        return self._request("PUT", endpoint, data or {})

    def patch(self, endpoint: str, data: dict | None = None) -> Any:
        return self._request("PATCH", endpoint, data or {})

    def get_user(self) -> Any:
        """Get the authenticated user."""
        if self._user_cache is None:
            self._user_cache = self.get("/user")
        return self._user_cache

    def get_username(self) -> str:
        """Get the authenticated user's username."""
        return self.get_user()["login"]

    def create_repo(self, name: str, private: bool = True) -> Any:
        """Create a new repository."""
        return self.post(
            "/user/repos",
            {
                "name": name,
                "private": private,
                "auto_init": True,  # Create with README
                "description": "Temporary test repo for ghinbox",
            },
        )

    def delete_repo(self, owner: str, name: str) -> None:
        """Delete a repository."""
        self.delete(f"/repos/{owner}/{name}")

    def watch_repo(self, owner: str, name: str) -> Any:
        """Watch a repository (subscribe to notifications)."""
        return self.put(
            f"/repos/{owner}/{name}/subscription",
            {"subscribed": True, "ignored": False},
        )

    def create_issue(self, owner: str, repo: str, title: str, body: str) -> Any:
        """Create an issue in a repository."""
        return self.post(
            f"/repos/{owner}/{repo}/issues",
            {"title": title, "body": body},
        )

    def add_collaborator(
        self,
        owner: str,
        repo: str,
        username: str,
        permission: str | None = None,
    ) -> None:
        """Add a collaborator to a repository."""
        payload = {"permission": permission} if permission else None
        self.put(f"/repos/{owner}/{repo}/collaborators/{username}", payload)

    def get_repository_invitations(self) -> list[Any]:
        """List repository invitations for the authenticated user."""
        result = self.get("/user/repository_invitations")
        return result if isinstance(result, list) else []

    def accept_repository_invitation(self, invitation_id: int) -> None:
        """Accept a repository invitation by ID."""
        self.patch(f"/user/repository_invitations/{invitation_id}")

    def get_notifications(
        self,
        all_notifications: bool = False,
        participating: bool = False,
        since: str | None = None,
    ) -> list[Any]:
        """Get notifications via API."""
        params: dict[str, str] = {}
        if all_notifications:
            params["all"] = "true"
        if participating:
            params["participating"] = "true"
        if since:
            params["since"] = since

        endpoint = self._with_params("/notifications", params)

        result = self.get(endpoint)
        return result if isinstance(result, list) else []

    def get_notification_thread(self, thread_id: str) -> Any:
        """Get a specific notification thread."""
        return self.get(f"/notifications/threads/{thread_id}")

    def mark_notification_read(self, thread_id: str) -> None:
        """Mark a notification thread as read."""
        self.patch(f"/notifications/threads/{thread_id}")

    def get_issue(self, owner: str, repo: str, number: int) -> Any:
        """Get a single issue."""
        return self.get(f"/repos/{owner}/{repo}/issues/{number}")

    def list_issue_events(
        self, owner: str, repo: str, number: int, per_page: int = 100
    ) -> list[Any]:
        """List events for a single issue."""
        endpoint = self._with_params(
            f"/repos/{owner}/{repo}/issues/{number}/events",
            {"per_page": str(per_page)},
        )
        result = self.get(endpoint)
        return result if isinstance(result, list) else []

    def list_issue_timeline(
        self,
        owner: str,
        repo: str,
        number: int,
        since: str | None = None,
        per_page: int = 100,
    ) -> list[Any]:
        """List timeline events for an issue."""
        params = {"per_page": str(per_page)}
        if since:
            params["since"] = since
        endpoint = self._with_params(
            f"/repos/{owner}/{repo}/issues/{number}/timeline", params
        )
        result = self.get(endpoint)
        return result if isinstance(result, list) else []

    def list_issue_comments(
        self,
        owner: str,
        repo: str,
        number: int,
        since: str | None = None,
        per_page: int = 100,
    ) -> list[Any]:
        """List issue comments."""
        params = {"per_page": str(per_page)}
        if since:
            params["since"] = since
        endpoint = self._with_params(
            f"/repos/{owner}/{repo}/issues/{number}/comments", params
        )
        result = self.get(endpoint)
        return result if isinstance(result, list) else []

    def create_issue_comment(
        self, owner: str, repo: str, number: int, body: str
    ) -> Any:
        """Create a comment on an issue."""
        return self.post(
            f"/repos/{owner}/{repo}/issues/{number}/comments", {"body": body}
        )

    def close_issue(self, owner: str, repo: str, number: int) -> Any:
        """Close an issue."""
        return self.patch(f"/repos/{owner}/{repo}/issues/{number}", {"state": "closed"})

    def graphql(self, query: str, variables: dict | None = None) -> Any:
        """Execute a GraphQL query."""
        url = "https://api.github.com/graphql"
        headers = github_graphql_headers(self.token)

        payload: dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables

        body = json.dumps(payload).encode("utf-8")

        request = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else ""
            print(f"GraphQL Error {e.code}: {e.reason}")
            print(f"  Body: {error_body}")
            raise


def save_response(name: str, data: Any, fmt: str = "json") -> Path:
    """
    Save a response to the responses directory.

    Args:
        name: Base name for the file
        data: Data to save (dict/list for json, str for html)
        fmt: 'json' or 'html'

    Returns:
        Path to the saved file
    """
    RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{name}_{timestamp}.{fmt}"
    filepath = RESPONSES_DIR / filename

    if fmt == "json":
        filepath.write_text(json.dumps(data, indent=2))
    else:
        filepath.write_text(data if isinstance(data, str) else str(data))

    print(f"Saved response to: {filepath}")
    return filepath
