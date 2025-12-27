"""
Pagination flow - triggers enough notifications to test HTML pagination.

Creates 26+ notifications for a single repo to trigger pagination on the
per-repo notifications page (which paginates at 25 items).
"""

import time
import urllib.parse
from datetime import datetime

from playwright.sync_api import sync_playwright

from ghsim.flows.base import BaseFlow
from ghsim.github_api import save_response, RESPONSES_DIR
from ghsim.parser.notifications import parse_notifications_html


class PaginationFlow(BaseFlow):
    """
    Test flow to trigger pagination on the notifications page.

    Creates multiple issues to generate enough notifications that
    pagination is required, then captures the HTML with pagination cursors.
    """

    name = "pagination"
    description = "Generate 26+ notifications to test pagination"

    def __init__(
        self,
        owner_account: str,
        trigger_account: str,
        headless: bool = True,
        cleanup: bool = True,
        num_issues: int = 30,
    ):
        super().__init__(owner_account, trigger_account, headless, cleanup)
        self.num_issues = num_issues

    def run(self) -> bool:
        """Run the pagination test."""
        if not self.validate_prerequisites():
            return False

        try:
            if not self.setup_test_repo():
                return False

            # Create multiple issues to trigger notifications
            print(f"\n{'=' * 60}")
            print(f"Creating {self.num_issues} issues to trigger notifications")
            print(f"{'=' * 60}")

            for i in range(1, self.num_issues + 1):
                self._create_numbered_issue(i)
                if i % 10 == 0:
                    print(f"  Created {i}/{self.num_issues} issues...")

            print(f"Created all {self.num_issues} issues")

            # Wait for notifications to be processed
            print(f"\n{'=' * 60}")
            print("Waiting for notifications to be processed")
            print(f"{'=' * 60}")

            notification_count = self._wait_for_notifications(
                target_count=self.num_issues,
                max_attempts=12,
                wait_seconds=10,
            )

            print(f"Found {notification_count} notifications via API")

            # Capture HTML pages with pagination
            print(f"\n{'=' * 60}")
            print("Capturing HTML pages with pagination")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()

                # Capture page 1
                page1_data = self._capture_notifications_page(
                    page, cursor=None, page_num=1
                )

                # If there's a next page, capture it
                if page1_data.get("next_cursor"):
                    self._capture_notifications_page(
                        page,
                        cursor=page1_data["next_cursor"],
                        page_num=2,
                        cursor_param="after",
                    )

                # Also check if there's a before cursor on page 2
                if page1_data.get("prev_cursor"):
                    print("Page 1 has a previous cursor (unexpected)")

                if context.browser:
                    context.browser.close()

            # Summary
            print(f"\n{'=' * 60}")
            print("Test Summary")
            print(f"{'=' * 60}")
            print(f"Repository: {self.owner_username}/{self.repo_name}")
            print(f"Issues created: {self.num_issues}")
            print(f"Notifications found: {notification_count}")
            print(f"HTML pages captured in: {RESPONSES_DIR}")

            return True

        except Exception as e:
            print(f"\nError during test: {e}")
            import traceback

            traceback.print_exc()
            return False

        finally:
            self.cleanup_test_repo()

    def _create_numbered_issue(self, num: int) -> None:
        """Create a numbered test issue."""
        assert self.trigger_api is not None

        title = f"Test issue #{num} - {datetime.now().isoformat()}"
        body = f"Pagination test issue {num} of {self.num_issues}"

        self.trigger_api.create_issue(self.owner_username, self.repo_name, title, body)

    def _wait_for_notifications(
        self,
        target_count: int,
        max_attempts: int = 12,
        wait_seconds: int = 10,
    ) -> int:
        """Wait for notifications to appear, return count found."""
        assert self.owner_api is not None

        count = 0
        for attempt in range(max_attempts):
            if attempt > 0:
                print(
                    f"  Waiting {wait_seconds}s... (attempt {attempt + 1}/{max_attempts})"
                )
                time.sleep(wait_seconds)

            notifications = self.owner_api.get_notifications(all_notifications=True)

            # Count notifications for our repo
            count = sum(
                1
                for n in notifications
                if n.get("repository", {}).get("name") == self.repo_name
            )

            print(f"  Found {count}/{target_count} notifications for our repo")

            if count >= target_count:
                return count

        return count

    def _capture_notifications_page(
        self,
        page,
        cursor: str | None,
        page_num: int,
        cursor_param: str = "after",
    ) -> dict:
        """Capture a notifications page and extract pagination info."""
        query = f"repo:{self.owner_username}/{self.repo_name}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        if cursor:
            url += f"&{cursor_param}={urllib.parse.quote(cursor)}"

        print(f"\nCapturing page {page_num}: {url}")
        page.goto(url, wait_until="domcontentloaded")
        # Wait for notifications list or empty state
        page.locator(".notifications-list-item, .blankslate").first.wait_for(
            state="attached", timeout=10000
        )

        # Save screenshot
        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        screenshot_path = RESPONSES_DIR / f"pagination_page{page_num}.png"
        page.screenshot(path=str(screenshot_path), full_page=True)
        print(f"  Screenshot: {screenshot_path}")

        # Save HTML
        html_content = page.content()
        html_path = save_response(f"pagination_page{page_num}", html_content, "html")
        print(f"  HTML: {html_path}")

        # Parse HTML and save JSON
        parsed = parse_notifications_html(
            html=html_content,
            owner=self.owner_username,
            repo=self.repo_name,
            source_url=url,
        )
        json_path = save_response(
            f"pagination_page{page_num}",
            parsed.model_dump(mode="json"),
            "json",
        )
        print(f"  JSON: {json_path}")

        # Extract pagination cursors
        result = {
            "page_num": page_num,
            "prev_cursor": None,
            "next_cursor": None,
        }

        # Look for Prev button/link
        prev_button = page.locator('button:has-text("Prev"), a:has-text("Prev")').first
        if prev_button.count() > 0:
            href = prev_button.get_attribute("href")
            if href and "before=" in href:
                # Extract cursor from href
                import re

                match = re.search(r"before=([^&]+)", href)
                if match:
                    result["prev_cursor"] = urllib.parse.unquote(match.group(1))
                    print(f"  Prev cursor: {result['prev_cursor'][:50]}...")

        # Look for Next button/link
        next_button = page.locator('button:has-text("Next"), a:has-text("Next")').first
        if next_button.count() > 0:
            href = next_button.get_attribute("href")
            if href and "after=" in href:
                import re

                match = re.search(r"after=([^&]+)", href)
                if match:
                    result["next_cursor"] = urllib.parse.unquote(match.group(1))
                    print(f"  Next cursor: {result['next_cursor'][:50]}...")

        # Count notifications on this page
        notification_items = page.locator(".notifications-list-item")
        count = notification_items.count()
        print(f"  Notifications on page: {count}")
        result["count"] = count

        return result
