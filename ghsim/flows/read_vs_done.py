"""
Read vs Done flow - tests whether API can distinguish read from done notifications.

This flow:
1. Creates a notification
2. Marks it as READ (by clicking into it in the web UI)
3. Captures API state
4. Marks it as DONE (by clicking Done button in web UI)
5. Captures API state again
6. Compares the two states to see if there's any difference
"""

import json
import time
import urllib.parse
from typing import Any

from playwright.sync_api import sync_playwright, Page

from ghsim.flows.base import BaseFlow
from ghsim.github_api import save_response, RESPONSES_DIR


class ReadVsDoneFlow(BaseFlow):
    """
    Test flow to verify read vs done notification state visibility via API.

    Hypothesis: The GitHub Notifications API cannot distinguish between
    "read" and "done" notifications - both become invisible in the standard
    notifications listing.
    """

    name = "read_vs_done"
    description = "Test read vs done notification state in API"

    def run(self) -> bool:
        """Run the read vs done test."""
        if not self.validate_prerequisites():
            return False

        try:
            if not self.setup_test_repo():
                return False

            # Create issue to trigger notification
            self.create_test_issue()

            # Wait for notification
            notification = self.wait_for_notification()
            if not notification:
                print("ERROR: Notification not found via API")
                return False

            thread_id = notification.get("id")
            print(f"\nNotification thread ID: {thread_id}")

            # Capture initial state
            print(f"\n{'=' * 60}")
            print("State 1: UNREAD notification")
            print(f"{'=' * 60}")
            state_unread = self._capture_notification_state("unread")

            # Mark as READ via web UI (click into the notification)
            print(f"\n{'=' * 60}")
            print("Marking notification as READ (clicking into it)")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._mark_as_read_via_ui(page)

                if context.browser:
                    context.browser.close()

            time.sleep(2)  # Let GitHub process the read state

            # Capture READ state
            print(f"\n{'=' * 60}")
            print("State 2: READ notification")
            print(f"{'=' * 60}")
            state_read = self._capture_notification_state("read")

            # Mark as DONE via web UI (click Done button)
            print(f"\n{'=' * 60}")
            print("Marking notification as DONE (clicking Done button)")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._mark_as_done_via_ui(page)

                if context.browser:
                    context.browser.close()

            time.sleep(2)  # Let GitHub process the done state

            # Capture DONE state
            print(f"\n{'=' * 60}")
            print("State 3: DONE notification")
            print(f"{'=' * 60}")
            state_done = self._capture_notification_state("done")

            # Also try GraphQL
            print(f"\n{'=' * 60}")
            print("Checking GraphQL API")
            print(f"{'=' * 60}")
            graphql_result = self._check_graphql_notifications()

            # Compare and analyze
            print(f"\n{'=' * 60}")
            print("ANALYSIS: Read vs Done State Comparison")
            print(f"{'=' * 60}")

            self._analyze_states(state_unread, state_read, state_done, graphql_result)

            return True

        except Exception as e:
            print(f"\nError during test: {e}")
            import traceback

            traceback.print_exc()
            return False

        finally:
            self.cleanup_test_repo()

    def _capture_notification_state(self, label: str) -> dict[str, Any]:
        """Capture the current notification state from various API endpoints."""
        assert self.owner_api is not None, "Must call validate_prerequisites first"

        state: dict[str, Any] = {}

        # Standard notifications endpoint
        state["notifications_default"] = self.owner_api.get_notifications()
        print(f"  /notifications: {len(state['notifications_default'])} items")

        # With all=true
        state["notifications_all"] = self.owner_api.get_notifications(
            all_notifications=True
        )
        print(f"  /notifications?all=true: {len(state['notifications_all'])} items")

        # With participating=true
        state["notifications_participating"] = self.owner_api.get_notifications(
            participating=True
        )
        print(
            f"  /notifications?participating=true: {len(state['notifications_participating'])} items"
        )

        # Check if our repo's notification is in each
        for key, notifs in state.items():
            if key.startswith("notifications_"):
                found = any(
                    n.get("repository", {}).get("name") == self.repo_name
                    for n in notifs
                )
                print(f"    Our notification present: {found}")

        # Find our specific notification and capture its details
        our_notif = None
        for notif in state["notifications_all"]:
            if notif.get("repository", {}).get("name") == self.repo_name:
                our_notif = notif
                break

        state["our_notification"] = our_notif
        if our_notif:
            print("  Our notification details:")
            print(f"    unread: {our_notif.get('unread')}")
            print(f"    reason: {our_notif.get('reason')}")
            print(f"    updated_at: {our_notif.get('updated_at')}")
            print(f"    last_read_at: {our_notif.get('last_read_at')}")

        # Save state
        save_response(f"state_{label}", state, "json")

        return state

    def _mark_as_read_via_ui(self, page: Page) -> None:
        """Mark the notification as read by clicking into it."""
        query = f"repo:{self.owner_username}/{self.repo_name}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        page.goto(url, wait_until="domcontentloaded")
        # Wait for notifications list or empty state
        page.locator(".notifications-list-item, .blankslate").first.wait_for(
            state="attached", timeout=10000
        )

        # Screenshot before
        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(RESPONSES_DIR / "before_read.png"))
        print("Screenshot saved: before_read.png")

        # Click on the notification to mark it as read
        # The notification link usually goes to the issue
        notification_link = page.locator(f'a[href*="{self.repo_name}/issues"]').first
        if notification_link.count() > 0:
            notification_link.click()
            # Wait for navigation to the issue page
            page.wait_for_url(f"**/{self.repo_name}/issues/**", timeout=10000)
            # Wait for issue content to load
            page.locator('[data-testid="issue-title"], .markdown-body, .comment-body').first.wait_for(
                state="attached", timeout=10000
            )
            print("Clicked notification link - marked as read")

            # Screenshot the issue page
            page.screenshot(path=str(RESPONSES_DIR / "issue_page.png"))
            print("Screenshot saved: issue_page.png")
        else:
            print("WARNING: Could not find notification link to click")

    def _mark_as_done_via_ui(self, page: Page) -> None:
        """Mark the notification as done using the Done button."""
        query = f"repo:{self.owner_username}/{self.repo_name}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        page.goto(url, wait_until="domcontentloaded")
        # Wait for notifications list or empty state
        page.locator(".notifications-list-item, .blankslate").first.wait_for(
            state="attached", timeout=10000
        )

        # Screenshot before
        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(RESPONSES_DIR / "before_done.png"))
        print("Screenshot saved: before_done.png")
        save_response("html_before_done", page.content(), "html")

        # Find the notification row and select it, then click Done
        # The notification has a checkbox we need to click first

        # Find the checkbox for our notification row
        notification_checkbox = page.locator(
            f'.notifications-list-item:has(a[href*="{self.repo_name}"]) input[type="checkbox"]'
        ).first

        if notification_checkbox.count() > 0:
            # Check the checkbox to select the notification
            notification_checkbox.check()
            # Wait for the bulk action bar with Done button to appear
            done_button = page.locator('button:has-text("Done")').first
            done_button.wait_for(state="visible", timeout=5000)
            print("Selected notification checkbox")

            # Click the Done button
            done_button.click()
            # Wait for the notification to be removed from the list
            page.locator(
                f'.notifications-list-item:has(a[href*="{self.repo_name}"])'
            ).wait_for(state="hidden", timeout=10000)
            print("Clicked Done button in action bar")
        else:
            # Try alternative: find the row and hover to reveal actions
            notification_row = page.locator(
                f'.notifications-list-item:has(a[href*="{self.repo_name}"])'
            ).first

            if notification_row.count() > 0:
                # Hover over the row to reveal action buttons
                notification_row.hover()
                # Wait for Done button to appear
                done_icon = notification_row.locator('button[aria-label*="Done"]').first
                done_icon.wait_for(state="visible", timeout=5000)

                # Click Done button
                done_icon.click()
                # Wait for the notification to be removed from the list
                notification_row.wait_for(state="hidden", timeout=10000)
                print("Clicked Done icon on row")
            else:
                print("WARNING: Could not find notification row")

        # Screenshot after
        page.screenshot(path=str(RESPONSES_DIR / "after_done.png"))
        print("Screenshot saved: after_done.png")
        save_response("html_after_done", page.content(), "html")

    def _check_graphql_notifications(self) -> dict[str, Any]:
        """Try to query notifications via GraphQL."""
        assert self.owner_api is not None, "Must call validate_prerequisites first"

        # GraphQL query to get notification info
        # Note: GitHub's GraphQL API has limited notification support
        query = """
        query {
          viewer {
            login
            notificationThreads: notifications(first: 10) {
              totalCount
            }
          }
        }
        """

        try:
            result = self.owner_api.graphql(query)
            print(f"GraphQL result: {json.dumps(result, indent=2)}")
            save_response("graphql_notifications", result, "json")
            return result
        except Exception as e:
            print(f"GraphQL query failed: {e}")
            # Try alternative queries
            return self._try_alternative_graphql_queries()

    def _try_alternative_graphql_queries(self) -> dict[str, Any]:
        """Try alternative GraphQL queries to find notification data."""
        assert self.owner_api is not None, "Must call validate_prerequisites first"

        results: dict[str, Any] = {}

        # Try querying the issue directly to see if there's notification state
        query_issue = """
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              id
              title
              viewerSubscription
              viewerCanSubscribe
            }
          }
        }
        """

        try:
            result = self.owner_api.graphql(
                query_issue,
                {
                    "owner": self.owner_username,
                    "repo": self.repo_name,
                    "number": 1,
                },
            )
            print(f"Issue subscription state: {json.dumps(result, indent=2)}")
            results["issue_subscription"] = result
        except Exception as e:
            print(f"Issue GraphQL query failed: {e}")

        save_response("graphql_alternatives", results, "json")
        return results

    def _analyze_states(
        self,
        state_unread: dict,
        state_read: dict,
        state_done: dict,
        graphql_result: dict,
    ) -> None:
        """Analyze the captured states and print conclusions."""
        print("\n" + "=" * 60)
        print("FINDINGS")
        print("=" * 60)

        # Check presence in each state
        unread_present = state_unread.get("our_notification") is not None
        read_present = state_read.get("our_notification") is not None
        done_present = state_done.get("our_notification") is not None

        print("\nNotification visible in API (all=true):")
        print(f"  UNREAD state: {unread_present}")
        print(f"  READ state:   {read_present}")
        print(f"  DONE state:   {done_present}")

        # Check 'unread' field changes
        if state_unread.get("our_notification"):
            print(
                f"\n'unread' field in UNREAD state: {state_unread['our_notification'].get('unread')}"
            )
        if state_read.get("our_notification"):
            print(
                f"'unread' field in READ state: {state_read['our_notification'].get('unread')}"
            )
        if state_done.get("our_notification"):
            print(
                f"'unread' field in DONE state: {state_done['our_notification'].get('unread')}"
            )

        # Conclusion
        print("\n" + "-" * 60)
        print("CONCLUSION:")
        print("-" * 60)

        if done_present:
            print("DONE notifications ARE visible via API with all=true")
            print("There may be a way to distinguish read from done.")
        else:
            if read_present:
                print("READ notifications are visible, but DONE notifications are NOT.")
                print("This confirms: The API cannot retrieve DONE notifications.")
                print("Only the web UI can show DONE notifications.")
            else:
                print("Both READ and DONE notifications are NOT visible via API.")
                print("The API may only show UNREAD notifications.")

        print("\n" + "-" * 60)
        print("API ENDPOINTS TESTED:")
        print("-" * 60)
        print("  - GET /notifications")
        print("  - GET /notifications?all=true")
        print("  - GET /notifications?participating=true")
        print("  - GraphQL viewer.notifications (if available)")
