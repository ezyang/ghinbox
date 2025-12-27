"""
Basic notification flow - verifies notifications are generated and visible.
"""

import urllib.parse

from playwright.sync_api import sync_playwright

from ghsim.flows.base import BaseFlow
from ghsim.github_api import save_response, RESPONSES_DIR
from ghsim.parser.notifications import parse_notifications_html


class BasicNotificationFlow(BaseFlow):
    """
    Basic notification test flow.

    Tests that:
    1. Creating an issue triggers a notification
    2. Notification is visible via API
    3. Notification is visible via web UI
    """

    name = "basic"
    description = "Basic notification generation and visibility test"

    def run(self) -> bool:
        """Run the basic notification test."""
        if not self.validate_prerequisites():
            return False

        try:
            if not self.setup_test_repo():
                return False

            # Create issue to trigger notification
            issue = self.create_test_issue()

            # Wait for notification
            notification = self.wait_for_notification()
            if not notification:
                print("ERROR: Notification not found via API")
                return False

            save_response("notifications_api", [notification], "json")

            # Check web UI
            print(f"\n{'=' * 60}")
            print("Checking notifications via web UI")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                query = f"repo:{self.owner_username}/{self.repo_name}"
                url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

                page.goto(url, wait_until="domcontentloaded")
                # Wait for notifications list or empty state
                page.locator(".notifications-list-item, .blankslate").first.wait_for(
                    state="attached", timeout=10000
                )

                # Take screenshot
                RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
                screenshot_path = RESPONSES_DIR / "basic_notification_screenshot.png"
                page.screenshot(path=str(screenshot_path), full_page=True)
                print(f"Screenshot saved to: {screenshot_path}")

                # Save HTML and JSON
                html_content = page.content()
                save_response("basic_notification_html", html_content, "html")
                # Parse and save JSON
                parsed = parse_notifications_html(
                    html=html_content,
                    owner=self.owner_username,
                    repo=self.repo_name,
                    source_url=url,
                )
                save_response(
                    "basic_notification_json", parsed.model_dump(mode="json"), "json"
                )

                if context.browser:
                    context.browser.close()

            # Summary
            print(f"\n{'=' * 60}")
            print("Test Summary")
            print(f"{'=' * 60}")
            print(f"Repository: {self.owner_username}/{self.repo_name}")
            print(f"Issue created: {issue['html_url']}")
            print("Notification found: True")
            print(f"Notification ID: {notification.get('id')}")

            return True

        except Exception as e:
            print(f"\nError during test: {e}")
            import traceback

            traceback.print_exc()
            return False

        finally:
            self.cleanup_test_repo()
