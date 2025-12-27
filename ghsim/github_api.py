"""
GitHub API client and common utilities.
"""

import json
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


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
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

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
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else ""
            print(f"API Error {e.code}: {e.reason}")
            print(f"  URL: {url}")
            print(f"  Body: {error_body}")
            raise

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
                "description": "Temporary test repo for ghsim",
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

    def unwatch_repo(self, owner: str, name: str) -> None:
        """Unwatch a repository."""
        self.delete(f"/repos/{owner}/{name}/subscription")

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

    def get_notifications(
        self, all_notifications: bool = False, participating: bool = False
    ) -> list[Any]:
        """Get notifications via API."""
        params = []
        if all_notifications:
            params.append("all=true")
        if participating:
            params.append("participating=true")

        endpoint = "/notifications"
        if params:
            endpoint += "?" + "&".join(params)

        result = self.get(endpoint)
        return result if isinstance(result, list) else []

    def get_notification_thread(self, thread_id: str) -> Any:
        """Get a specific notification thread."""
        return self.get(f"/notifications/threads/{thread_id}")

    def mark_notification_read(self, thread_id: str) -> None:
        """Mark a notification thread as read."""
        self.patch(f"/notifications/threads/{thread_id}")

    def mark_all_notifications_read(self) -> None:
        """Mark all notifications as read."""
        self.put("/notifications")

    def graphql(self, query: str, variables: dict | None = None) -> Any:
        """Execute a GraphQL query."""
        url = "https://api.github.com/graphql"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

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
