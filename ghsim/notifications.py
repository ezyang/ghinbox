"""
Notification trigger test script.

This script tests GitHub notification behavior by:
1. Creating a fresh test repository
2. Watching it with account1
3. Having account2 create an issue
4. Verifying notification appears for account1
5. Cleaning up (deleting the repo)

Uses GitHub API for repo/issue operations and Playwright for notification UI.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, Page, BrowserContext

from ghsim.auth import create_authenticated_context, has_valid_auth
from ghsim.token import load_token


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

    def add_collaborator(self, owner: str, repo: str, username: str) -> None:
        """Add a collaborator to a repository."""
        self.put(f"/repos/{owner}/{repo}/collaborators/{username}")

    def get_notifications(self, all_notifications: bool = False) -> list[Any]:
        """Get notifications via API."""
        endpoint = "/notifications"
        if all_notifications:
            endpoint += "?all=true"
        result = self.get(endpoint)
        return result if isinstance(result, list) else []


def save_response(name: str, data: Any, format: str = "json") -> Path:
    """
    Save a response to the responses directory.

    Args:
        name: Base name for the file
        data: Data to save (dict/list for json, str for html)
        format: 'json' or 'html'

    Returns:
        Path to the saved file
    """
    RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{name}_{timestamp}.{format}"
    filepath = RESPONSES_DIR / filename

    if format == "json":
        filepath.write_text(json.dumps(data, indent=2))
    else:
        filepath.write_text(data if isinstance(data, str) else str(data))

    print(f"Saved response to: {filepath}")
    return filepath


def fetch_notifications_page(
    context: BrowserContext,
    query: str = "",
    save: bool = True,
) -> tuple[str, list[dict]]:
    """
    Fetch the notifications page using Playwright.

    Args:
        context: Authenticated browser context
        query: Optional query string (e.g., 'repo:owner/name')
        save: Whether to save the response

    Returns:
        Tuple of (html_content, parsed_notifications)
    """
    page = context.new_page()

    url = "https://github.com/notifications"
    if query:
        url += f"?query={urllib.parse.quote(query)}"

    print(f"Fetching notifications page: {url}")
    page.goto(url, wait_until="domcontentloaded")

    # Wait for notifications list or empty state to be visible
    page.locator(".notifications-list-item, .blankslate").first.wait_for(
        state="attached", timeout=10000
    )

    # Get the HTML content
    html_content = page.content()

    # Parse notifications from the page
    notifications = _parse_notifications_page(page)

    if save:
        save_response("notifications_html", html_content, "html")
        save_response("notifications_parsed", notifications, "json")

    page.close()
    return html_content, notifications


def _parse_notifications_page(page: Page) -> list[dict]:
    """
    Parse notifications from the GitHub notifications page.

    Returns a list of notification objects with available info.
    """
    notifications = []

    # GitHub's notification list items
    # The structure may vary, so we try multiple selectors
    notification_items = page.locator(
        ".notifications-list-item, [data-notification-id], .notification"
    )

    count = notification_items.count()
    print(f"Found {count} notification items on page")

    for i in range(count):
        item = notification_items.nth(i)
        try:
            text_content = item.text_content() or ""
            notification: dict[str, Any] = {
                "index": i,
                "text": text_content.strip()[:200],  # First 200 chars
                "html": item.inner_html()[:500],  # First 500 chars of HTML
            }

            # Try to extract specific attributes
            notification_id = item.get_attribute("data-notification-id")
            if notification_id:
                notification["id"] = notification_id

            # Try to get the notification type/reason
            type_el = item.locator("[data-notification-reason]").first
            if type_el.count() > 0:
                reason = type_el.get_attribute("data-notification-reason")
                if reason:
                    notification["reason"] = reason

            # Try to get repo name
            repo_link = item.locator('a[href*="/"]').first
            if repo_link.count() > 0:
                repo_url = repo_link.get_attribute("href")
                if repo_url:
                    notification["repo_url"] = repo_url

            notifications.append(notification)
        except Exception as e:
            print(f"Error parsing notification {i}: {e}")

    return notifications


def intercept_api_responses(page: Page, responses: list[dict]) -> None:
    """Set up response interception to capture API responses."""

    def handle_response(response):
        if "api.github.com" in response.url or "/notifications" in response.url:
            try:
                responses.append(
                    {
                        "url": response.url,
                        "status": response.status,
                        "headers": dict(response.headers),
                    }
                )
            except Exception:
                pass

    page.on("response", handle_response)


def run_notification_test(
    owner_account: str,
    trigger_account: str,
    repo_name: str | None = None,
    cleanup: bool = True,
    headless: bool = True,
) -> bool:
    """
    Run the full notification test workflow.

    Args:
        owner_account: Account that owns the repo and receives notifications
        trigger_account: Account that creates the issue
        repo_name: Optional custom repo name (default: ghsim-test-{timestamp})
        cleanup: Whether to delete the repo after the test
        headless: Whether to run browsers in headless mode

    Returns:
        True if test passed, False otherwise
    """
    # Validate prerequisites
    for account in [owner_account, trigger_account]:
        if not has_valid_auth(account):
            print(f"Missing auth for '{account}'. Run: python -m ghsim.auth {account}")
            return False

    owner_token = load_token(owner_account)
    trigger_token = load_token(trigger_account)

    if not owner_token:
        print(f"Missing API token for '{owner_account}'.")
        print(f"Run: python -m ghsim.token {owner_account}")
        return False

    if not trigger_token:
        print(f"Missing API token for '{trigger_account}'.")
        print(f"Run: python -m ghsim.token {trigger_account}")
        return False

    # Set up API clients
    owner_api = GitHubAPI(owner_token)
    trigger_api = GitHubAPI(trigger_token)

    owner_username = owner_api.get_username()
    trigger_username = trigger_api.get_username()

    print(f"Owner account: {owner_username}")
    print(f"Trigger account: {trigger_username}")

    # Generate repo name if not provided
    if repo_name is None:
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        repo_name = f"ghsim-test-{timestamp}"

    created_repo = None

    try:
        # Step 1: Create repository
        print(f"\n{'=' * 60}")
        print("Step 1: Creating test repository")
        print(f"{'=' * 60}")

        created_repo = owner_api.create_repo(repo_name, private=False)
        print(f"Created repo: {created_repo['full_name']}")
        print(f"URL: {created_repo['html_url']}")

        # Give GitHub a moment to set up the repo
        time.sleep(2)

        # Step 2: Add trigger account as collaborator (needed to create issues)
        print(f"\n{'=' * 60}")
        print("Step 2: Adding collaborator")
        print(f"{'=' * 60}")

        owner_api.add_collaborator(owner_username, repo_name, trigger_username)
        print(f"Added {trigger_username} as collaborator")

        # Step 3: Watch the repository (explicit subscription)
        print(f"\n{'=' * 60}")
        print("Step 3: Watching repository")
        print(f"{'=' * 60}")

        owner_api.watch_repo(owner_username, repo_name)
        print(f"Now watching {owner_username}/{repo_name}")

        # Step 4: Create an issue from the trigger account
        print(f"\n{'=' * 60}")
        print("Step 4: Creating issue from trigger account")
        print(f"{'=' * 60}")

        issue_title = f"Test issue from ghsim - {datetime.now().isoformat()}"
        issue_body = "This is a test issue created by ghsim to trigger a notification."

        issue = trigger_api.create_issue(
            owner_username, repo_name, issue_title, issue_body
        )
        print(f"Created issue: {issue['title']}")
        print(f"Issue URL: {issue['html_url']}")

        # Step 5: Check notifications via API (with retry)
        print(f"\n{'=' * 60}")
        print("Step 5: Checking notifications via API")
        print(f"{'=' * 60}")

        # Retry logic - GitHub can be slow to generate notifications
        found_notification = None
        max_attempts = 6
        wait_seconds = 5

        for attempt in range(max_attempts):
            if attempt > 0:
                print(f"Retry {attempt}/{max_attempts - 1}, waiting {wait_seconds}s...")
                time.sleep(wait_seconds)

            api_notifications = owner_api.get_notifications(all_notifications=True)
            print(f"Found {len(api_notifications)} total notifications via API")
            print(f"Looking for repo: {repo_name}")

            # Look for our notification
            for notif in api_notifications:
                notif_repo = notif.get("repository", {}).get("name", "unknown")
                if notif_repo == repo_name:
                    found_notification = notif
                    print("Found notification for our repo!")
                    print(f"  Type: {notif.get('subject', {}).get('type')}")
                    print(f"  Title: {notif.get('subject', {}).get('title')}")
                    print(f"  Reason: {notif.get('reason')}")
                    print(f"  Unread: {notif.get('unread')}")
                    break
                else:
                    print(f"  Skipping notification for: {notif_repo}")

            if found_notification:
                break

        # Save final state
        save_response("notifications_api", api_notifications, "json")

        # Step 6: Check notifications via web UI (Playwright)
        print(f"\n{'=' * 60}")
        print("Step 6: Checking notifications via web UI")
        print(f"{'=' * 60}")

        with sync_playwright() as p:
            context = create_authenticated_context(p, owner_account, headless=headless)
            if context is None:
                print("Failed to create authenticated context")
                return False

            # Fetch the notifications page
            query = f"repo:{owner_username}/{repo_name}"
            html_content, parsed_notifications = fetch_notifications_page(
                context, query=query, save=True
            )

            # Also fetch without query to see all notifications
            _, all_notifications = fetch_notifications_page(
                context, query="", save=True
            )

            print(f"Found {len(parsed_notifications)} notifications for repo query")
            print(f"Found {len(all_notifications)} total notifications")

            # Take a screenshot
            page = context.new_page()
            page.goto(
                f"https://github.com/notifications?query={urllib.parse.quote(query)}",
                wait_until="domcontentloaded",
            )
            # Wait for notifications list or empty state to be visible
            page.locator(".notifications-list-item, .blankslate").first.wait_for(
                state="attached", timeout=10000
            )
            screenshot_path = RESPONSES_DIR / "notifications_screenshot.png"
            RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshot_path), full_page=True)
            print(f"Screenshot saved to: {screenshot_path}")

            if context.browser:
                context.browser.close()

        # Summary
        print(f"\n{'=' * 60}")
        print("Test Summary")
        print(f"{'=' * 60}")
        print(f"Repository: {owner_username}/{repo_name}")
        print(f"Issue created: {issue['html_url']}")
        print(f"API notifications found: {len(api_notifications)}")
        print(f"Our notification found via API: {found_notification is not None}")
        print(f"Responses saved to: {RESPONSES_DIR}")

        return found_notification is not None

    except Exception as e:
        print(f"\nError during test: {e}")
        import traceback

        traceback.print_exc()
        return False

    finally:
        if cleanup and created_repo:
            print(f"\n{'=' * 60}")
            print("Cleanup: Deleting test repository")
            print(f"{'=' * 60}")
            try:
                owner_api.delete_repo(owner_username, repo_name)
                print(f"Deleted repo: {owner_username}/{repo_name}")
            except Exception as e:
                print(f"Failed to delete repo: {e}")
                print(
                    f"Please manually delete: https://github.com/{owner_username}/{repo_name}"
                )


def main():
    parser = argparse.ArgumentParser(description="Test GitHub notification triggering")
    parser.add_argument(
        "owner_account",
        help="Account that owns the repo (receives notifications)",
    )
    parser.add_argument(
        "trigger_account",
        help="Account that triggers notifications (creates issues)",
    )
    parser.add_argument(
        "--repo-name",
        "-r",
        help="Custom repository name (default: ghsim-test-{timestamp})",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Don't delete the test repo after the test",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in headed mode (visible)",
    )

    args = parser.parse_args()

    success = run_notification_test(
        owner_account=args.owner_account,
        trigger_account=args.trigger_account,
        repo_name=args.repo_name,
        cleanup=not args.no_cleanup,
        headless=not args.headed,
    )

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
