"""
Base class for test flows.
"""

import time
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any

from playwright.sync_api import BrowserContext

from ghsim.auth import create_authenticated_context, has_valid_auth
from ghsim.github_api import GitHubAPI
from ghsim.token import load_token


class BaseFlow(ABC):
    """Base class for notification test flows."""

    name: str = "base"
    description: str = "Base flow"

    def __init__(
        self,
        owner_account: str,
        trigger_account: str,
        headless: bool = True,
        cleanup: bool = True,
    ):
        self.owner_account = owner_account
        self.trigger_account = trigger_account
        self.headless = headless
        self.cleanup = cleanup

        # Will be set during setup
        self.owner_api: GitHubAPI | None = None
        self.trigger_api: GitHubAPI | None = None
        self.owner_username: str = ""
        self.trigger_username: str = ""
        self.repo_name: str = ""
        self.created_repo: Any = None

    def validate_prerequisites(self) -> bool:
        """Validate that required auth and tokens exist."""
        for account in [self.owner_account, self.trigger_account]:
            if not has_valid_auth(account):
                print(
                    f"Missing auth for '{account}'. Run: python -m ghsim.auth {account}"
                )
                return False

        owner_token = load_token(self.owner_account)
        trigger_token = load_token(self.trigger_account)

        if not owner_token:
            print(f"Missing API token for '{self.owner_account}'.")
            print(f"Run: python -m ghsim.token {self.owner_account}")
            return False

        if not trigger_token:
            print(f"Missing API token for '{self.trigger_account}'.")
            print(f"Run: python -m ghsim.token {self.trigger_account}")
            return False

        self.owner_api = GitHubAPI(owner_token)
        self.trigger_api = GitHubAPI(trigger_token)
        self.owner_username = self.owner_api.get_username()
        self.trigger_username = self.trigger_api.get_username()

        print(f"Owner account: {self.owner_username}")
        print(f"Trigger account: {self.trigger_username}")
        return True

    def setup_test_repo(self) -> bool:
        """Create a test repository and set up watching."""
        assert self.owner_api is not None, "Must call validate_prerequisites first"

        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        self.repo_name = f"ghsim-test-{timestamp}"

        print(f"\n{'=' * 60}")
        print("Setup: Creating test repository")
        print(f"{'=' * 60}")

        self.created_repo = self.owner_api.create_repo(self.repo_name, private=False)
        print(f"Created repo: {self.created_repo['full_name']}")
        print(f"URL: {self.created_repo['html_url']}")

        time.sleep(2)

        # Add collaborator with push permissions so they can create branches/PRs.
        self.owner_api.add_collaborator(
            self.owner_username,
            self.repo_name,
            self.trigger_username,
            permission="push",
        )
        print(f"Added {self.trigger_username} as collaborator")

        # Watch the repo
        self.owner_api.watch_repo(self.owner_username, self.repo_name)
        print(f"Now watching {self.owner_username}/{self.repo_name}")

        return True

    def create_test_issue(self) -> Any:
        """Create a test issue from the trigger account."""
        assert self.trigger_api is not None, "Must call validate_prerequisites first"

        print(f"\n{'=' * 60}")
        print("Creating test issue")
        print(f"{'=' * 60}")

        issue_title = f"Test issue from ghsim - {datetime.now().isoformat()}"
        issue_body = "This is a test issue created by ghsim to trigger a notification."

        issue = self.trigger_api.create_issue(
            self.owner_username, self.repo_name, issue_title, issue_body
        )
        print(f"Created issue: {issue['title']}")
        print(f"Issue URL: {issue['html_url']}")
        return issue

    def wait_for_notification(
        self, max_attempts: int = 6, wait_seconds: int = 5
    ) -> Any:
        """Wait for a notification to appear for our test repo."""
        assert self.owner_api is not None, "Must call validate_prerequisites first"

        print(f"\n{'=' * 60}")
        print("Waiting for notification via API")
        print(f"{'=' * 60}")

        found_notification = None

        for attempt in range(max_attempts):
            if attempt > 0:
                print(f"Retry {attempt}/{max_attempts - 1}, waiting {wait_seconds}s...")
                time.sleep(wait_seconds)

            api_notifications = self.owner_api.get_notifications(all_notifications=True)
            print(f"Found {len(api_notifications)} total notifications")

            for notif in api_notifications:
                notif_repo = notif.get("repository", {}).get("name", "unknown")
                if notif_repo == self.repo_name:
                    found_notification = notif
                    print("Found notification for our repo!")
                    print(f"  ID: {notif.get('id')}")
                    print(f"  Type: {notif.get('subject', {}).get('type')}")
                    print(f"  Title: {notif.get('subject', {}).get('title')}")
                    print(f"  Reason: {notif.get('reason')}")
                    print(f"  Unread: {notif.get('unread')}")
                    break

            if found_notification:
                break

        return found_notification

    def cleanup_test_repo(self) -> None:
        """Delete the test repository."""
        if self.cleanup and self.created_repo and self.owner_api is not None:
            print(f"\n{'=' * 60}")
            print("Cleanup: Deleting test repository")
            print(f"{'=' * 60}")
            try:
                self.owner_api.delete_repo(self.owner_username, self.repo_name)
                print(f"Deleted repo: {self.owner_username}/{self.repo_name}")
            except Exception as e:
                print(f"Failed to delete repo: {e}")
                print(
                    f"Please manually delete: https://github.com/{self.owner_username}/{self.repo_name}"
                )
                raise

    def create_browser_context(self, playwright) -> BrowserContext | None:
        """Create an authenticated browser context for the owner account."""
        return create_authenticated_context(
            playwright, self.owner_account, headless=self.headless
        )

    @abstractmethod
    def run(self) -> bool:
        """Run the test flow. Returns True if test passed."""
        pass
