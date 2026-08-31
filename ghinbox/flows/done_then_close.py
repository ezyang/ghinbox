"""
Done Then Close flow - tests timestamp behavior when notification returns after being marked done.

This flow tests the specific scenario:
1. Second account creates an issue and posts a comment (triggers notification)
2. First account marks the notification as DONE
3. Second account closes the issue
4. Verify that the notification shows up with timestamp indicating only the closure is "new"

The hypothesis being tested: When a notification comes back after being marked done,
does the timestamp correctly reflect only the new activity (the closure), or does it
incorrectly pull all previous activity (including old comments)?
"""

from __future__ import annotations

import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from playwright.sync_api import sync_playwright, Page

from ghinbox.flows.base import BaseFlow
from ghinbox.github_api import save_response, RESPONSES_DIR
from ghinbox.parser.notifications import parse_notifications_html


class DoneThenCloseFlow(BaseFlow):
    """Test timestamp behavior when a notification returns after being marked done."""

    name = "done_then_close"
    description = "Test timestamp behavior: done notification returns after issue close"

    def run(self) -> bool:
        """Run the done-then-close timestamp test."""
        if not self.validate_prerequisites():
            return False

        try:
            if not self.setup_test_repo():
                return False

            # Step 1: Create issue and add a comment
            print(f"\n{'=' * 60}")
            print("Step 1: Creating issue and adding comment")
            print(f"{'=' * 60}")

            issue = self.create_test_issue()
            issue_number = issue.get("number")
            if not isinstance(issue_number, int):
                print("ERROR: Issue number missing from API response")
                return False

            # Add a comment from trigger account
            assert self.trigger_api is not None
            comment_body = (
                f"Initial comment at {datetime.now(timezone.utc).isoformat()}"
            )
            self.trigger_api.create_issue_comment(
                self.owner_username, self.repo_name, issue_number, comment_body
            )
            print(f"Added comment to issue #{issue_number}")

            # Wait for notification
            notification = self.wait_for_notification()
            if not notification:
                print("ERROR: Notification not found via API")
                return False

            thread_id = notification.get("id")
            if not isinstance(thread_id, str):
                print("ERROR: Notification thread ID missing")
                return False

            print(f"Notification thread ID: {thread_id}")

            # Capture initial state (before read)
            print(f"\n{'=' * 60}")
            print("Snapshot 1: Before any action (unread)")
            print(f"{'=' * 60}")
            snapshot_before_read = self._capture_full_snapshot(
                label="before_read",
                thread_id=thread_id,
                issue_number=issue_number,
            )

            # Step 2: Explicitly READ by navigating to issue page
            print(f"\n{'=' * 60}")
            print("Step 2: Reading notification (navigating to issue page)")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._read_notification_via_ui(page, issue_number)

                if context.browser:
                    context.browser.close()

            time.sleep(3)  # Let GitHub process the read state

            # Capture state after read
            print(f"\n{'=' * 60}")
            print("Snapshot 2: After reading (before done)")
            print(f"{'=' * 60}")
            snapshot_after_read = self._capture_full_snapshot(
                label="after_read",
                thread_id=thread_id,
                issue_number=issue_number,
            )

            # Step 3: Mark as DONE via web UI
            print(f"\n{'=' * 60}")
            print("Step 3: Marking notification as DONE")
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

            time.sleep(3)  # Let GitHub process the done state

            # Capture state after done
            print(f"\n{'=' * 60}")
            print("Snapshot 3: After marking as done")
            print(f"{'=' * 60}")
            snapshot_after_done = self._capture_full_snapshot(
                label="after_done",
                thread_id=thread_id,
                issue_number=issue_number,
            )

            # Record the time just before closing
            pre_close_time = datetime.now(timezone.utc).isoformat()
            print(f"Pre-close time: {pre_close_time}")

            # Step 4: Close the issue from trigger account
            print(f"\n{'=' * 60}")
            print("Step 4: Closing the issue")
            print(f"{'=' * 60}")

            self.trigger_api.close_issue(
                self.owner_username, self.repo_name, issue_number
            )
            print(f"Closed issue #{issue_number}")

            # Wait for notification to reappear
            print(f"\n{'=' * 60}")
            print("Waiting for notification to reappear after close")
            print(f"{'=' * 60}")

            notification_after_close = self._wait_for_notification_update(
                thread_id=thread_id,
                previous_updated_at=snapshot_after_done.get("notification_updated_at"),
            )

            if not notification_after_close:
                print("WARNING: Notification did not reappear or update after close")
                # Still capture state even if notification didn't update
            else:
                print("Notification updated after issue close")

            # Capture final state
            print(f"\n{'=' * 60}")
            print("Snapshot 4: After issue close")
            print(f"{'=' * 60}")
            snapshot_after_close = self._capture_full_snapshot(
                label="after_close",
                thread_id=thread_id,
                issue_number=issue_number,
            )

            # Also capture HTML state to see what the UI shows
            print(f"\n{'=' * 60}")
            print("Capturing HTML notification state")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._capture_html_state(page)

                if context.browser:
                    context.browser.close()

            # Analysis
            print(f"\n{'=' * 60}")
            print("ANALYSIS: Timestamp Behavior")
            print(f"{'=' * 60}")
            self._analyze_timestamps(
                snapshot_before_read,
                snapshot_after_read,
                snapshot_after_done,
                snapshot_after_close,
                pre_close_time,
            )

            return True

        finally:
            self.cleanup_test_repo()

    def _capture_full_snapshot(
        self,
        label: str,
        thread_id: str,
        issue_number: int,
    ) -> dict[str, Any]:
        """Capture comprehensive snapshot of notification and issue state."""
        assert self.owner_api is not None

        # Get notification from API
        notifications_all = self.owner_api.get_notifications(all_notifications=True)
        our_notification = next(
            (
                n
                for n in notifications_all
                if n.get("repository", {}).get("name") == self.repo_name
            ),
            None,
        )

        # Get thread details
        thread = self.owner_api.get_notification_thread(thread_id)

        # Get issue details
        issue = self.owner_api.get_issue(
            self.owner_username, self.repo_name, issue_number
        )

        # Get comments
        comments = self.owner_api.list_issue_comments(
            self.owner_username, self.repo_name, issue_number
        )

        # Get timeline events
        timeline = self.owner_api.list_issue_timeline(
            self.owner_username, self.repo_name, issue_number
        )

        snapshot = {
            "label": label,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "notification": our_notification,
            "notification_updated_at": (
                our_notification.get("updated_at") if our_notification else None
            ),
            "notification_unread": (
                our_notification.get("unread") if our_notification else None
            ),
            "thread": thread,
            "thread_updated_at": thread.get("updated_at") if thread else None,
            "thread_last_read_at": thread.get("last_read_at") if thread else None,
            "issue": issue,
            "issue_state": issue.get("state") if issue else None,
            "issue_updated_at": issue.get("updated_at") if issue else None,
            "comments": comments,
            "comments_count": len(comments),
            "timeline": timeline,
            "timeline_count": len(timeline),
        }

        # Print summary
        print(f"Snapshot '{label}':")
        print(f"  Notification present: {our_notification is not None}")
        if our_notification:
            print(f"  Notification updated_at: {our_notification.get('updated_at')}")
            print(f"  Notification unread: {our_notification.get('unread')}")
        if thread:
            print(f"  Thread updated_at: {thread.get('updated_at')}")
            print(f"  Thread last_read_at: {thread.get('last_read_at')}")
        if issue:
            print(f"  Issue state: {issue.get('state')}")
            print(f"  Issue updated_at: {issue.get('updated_at')}")
        print(f"  Comments: {len(comments)}")
        print(f"  Timeline events: {len(timeline)}")

        # Save snapshot
        save_response(f"done_then_close_{label}", snapshot, "json")

        return snapshot

    def _wait_for_notification_update(
        self,
        thread_id: str,
        previous_updated_at: str | None,
        max_attempts: int = 10,
        wait_seconds: int = 3,
    ) -> dict[str, Any] | None:
        """Wait for the notification to update after closing the issue."""
        assert self.owner_api is not None

        for attempt in range(max_attempts):
            if attempt > 0:
                print(
                    f"  Attempt {attempt + 1}/{max_attempts}, waiting {wait_seconds}s..."
                )
                time.sleep(wait_seconds)

            # Check both unread notifications and all notifications
            notifications = self.owner_api.get_notifications(all_notifications=True)

            for notif in notifications:
                if notif.get("repository", {}).get("name") == self.repo_name:
                    current_updated_at = notif.get("updated_at")
                    if previous_updated_at is None:
                        return notif
                    if current_updated_at and current_updated_at != previous_updated_at:
                        return notif

        return None

    def _read_notification_via_ui(self, page: Page, issue_number: int) -> None:
        """Read the notification by navigating to the issue page."""
        issue_url = f"https://github.com/{self.owner_username}/{self.repo_name}/issues/{issue_number}"
        print(f"Navigating to issue page: {issue_url}")

        page.goto(issue_url, wait_until="domcontentloaded")
        # Wait for issue content to load
        page.locator(
            '[data-testid="issue-title"], .markdown-body, .comment-body, .js-issue-title'
        ).first.wait_for(state="attached", timeout=10000)

        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(RESPONSES_DIR / "done_then_close_issue_page.png"))
        print("Screenshot saved: done_then_close_issue_page.png")
        print("Issue page loaded - notification should now be marked as read")

    def _mark_as_done_via_ui(self, page: Page) -> None:
        """Mark the notification as done using the Done button."""
        query = f"repo:{self.owner_username}/{self.repo_name}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        page.goto(url, wait_until="domcontentloaded")
        page.locator(".notifications-list-item, .blankslate").first.wait_for(
            state="attached", timeout=10000
        )

        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(RESPONSES_DIR / "done_then_close_before_done.png"))
        print("Screenshot saved: done_then_close_before_done.png")

        # Find and click checkbox, then Done button
        notification_checkbox = page.locator(
            f'.notifications-list-item:has(a[href*="{self.repo_name}"]) input[type="checkbox"]'
        ).first

        if notification_checkbox.count() > 0:
            notification_checkbox.check()
            done_button = page.locator('button:has-text("Done")').first
            done_button.wait_for(state="visible", timeout=5000)
            print("Selected notification checkbox")
            done_button.click()
            page.locator(
                f'.notifications-list-item:has(a[href*="{self.repo_name}"])'
            ).wait_for(state="hidden", timeout=10000)
            print("Clicked Done button")
        else:
            # Try hover approach
            notification_row = page.locator(
                f'.notifications-list-item:has(a[href*="{self.repo_name}"])'
            ).first
            if notification_row.count() > 0:
                notification_row.hover()
                done_icon = notification_row.locator('button[aria-label*="Done"]').first
                done_icon.wait_for(state="visible", timeout=5000)
                done_icon.click()
                notification_row.wait_for(state="hidden", timeout=10000)
                print("Clicked Done icon on row")
            else:
                print("WARNING: Could not find notification to mark as done")

        page.screenshot(path=str(RESPONSES_DIR / "done_then_close_after_done.png"))
        print("Screenshot saved: done_then_close_after_done.png")

    def _capture_html_state(self, page: Page) -> None:
        """Capture the HTML state of notifications after the close event."""
        query = f"repo:{self.owner_username}/{self.repo_name}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        page.goto(url, wait_until="domcontentloaded")
        time.sleep(2)  # Give time for notifications to load

        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(RESPONSES_DIR / "done_then_close_final_state.png"))
        print("Screenshot saved: done_then_close_final_state.png")

        html_content = page.content()
        save_response("done_then_close_final_html", html_content, "html")

        # Parse the HTML
        parsed = parse_notifications_html(
            html=html_content,
            owner=self.owner_username,
            repo=self.repo_name,
            source_url=url,
        )
        save_response(
            "done_then_close_final_parsed", parsed.model_dump(mode="json"), "json"
        )

        # Report what we found
        print(f"Found {len(parsed.notifications)} notifications in HTML")
        for notif in parsed.notifications:
            print(f"  - {notif.subject.title}")
            print(f"    updated_at: {notif.updated_at}")
            print(f"    state: {notif.subject.state}")

    def _analyze_timestamps(
        self,
        before_read: dict[str, Any],
        after_read: dict[str, Any],
        after_done: dict[str, Any],
        after_close: dict[str, Any],
        pre_close_time: str,
    ) -> None:
        """Analyze timestamp behavior across the four snapshots."""
        print("\n" + "=" * 60)
        print("TIMESTAMP COMPARISON")
        print("=" * 60)

        print("\n1. NOTIFICATION TIMESTAMPS:")
        print(f"   Before read:  {before_read.get('notification_updated_at')}")
        print(f"   After read:   {after_read.get('notification_updated_at')}")
        print(f"   After done:   {after_done.get('notification_updated_at')}")
        print(f"   After close:  {after_close.get('notification_updated_at')}")

        print("\n2. THREAD last_read_at (KEY FIELD):")
        print(f"   Before read:  {before_read.get('thread_last_read_at')}")
        print(f"   After read:   {after_read.get('thread_last_read_at')}")
        print(f"   After done:   {after_done.get('thread_last_read_at')}")
        print(f"   After close:  {after_close.get('thread_last_read_at')}")

        print("\n3. THREAD updated_at:")
        print(f"   Before read:  {before_read.get('thread_updated_at')}")
        print(f"   After read:   {after_read.get('thread_updated_at')}")
        print(f"   After done:   {after_done.get('thread_updated_at')}")
        print(f"   After close:  {after_close.get('thread_updated_at')}")

        print("\n4. ISSUE TIMESTAMPS:")
        print(f"   Before read:  {before_read.get('issue_updated_at')}")
        print(f"   After read:   {after_read.get('issue_updated_at')}")
        print(f"   After done:   {after_done.get('issue_updated_at')}")
        print(f"   After close:  {after_close.get('issue_updated_at')}")

        print(f"\n5. PRE-CLOSE REFERENCE TIME: {pre_close_time}")

        # Key analysis
        print("\n" + "=" * 60)
        print("KEY FINDINGS")
        print("=" * 60)

        # Check if reading sets last_read_at
        last_read_before = before_read.get("thread_last_read_at")
        last_read_after_read = after_read.get("thread_last_read_at")
        last_read_after_done = after_done.get("thread_last_read_at")
        last_read_after_close = after_close.get("thread_last_read_at")

        print("\n** last_read_at behavior (critical for filtering) **")
        if last_read_before is None and last_read_after_read is not None:
            print("✓ Reading the issue page SETS last_read_at")
            print(f"  Value: {last_read_after_read}")
        elif last_read_before is None and last_read_after_read is None:
            print("✗ Reading the issue page does NOT set last_read_at")
        else:
            print(f"  Before read: {last_read_before}")
            print(f"  After read:  {last_read_after_read}")

        if last_read_after_read is not None and last_read_after_done is not None:
            if last_read_after_read == last_read_after_done:
                print("✓ Marking as done PRESERVES last_read_at")
            else:
                print("⚠ Marking as done CHANGES last_read_at")
                print(f"  After read: {last_read_after_read}")
                print(f"  After done: {last_read_after_done}")
        elif last_read_after_read is not None and last_read_after_done is None:
            print("✗ Marking as done CLEARS last_read_at")

        if last_read_after_done is not None and last_read_after_close is not None:
            if last_read_after_done == last_read_after_close:
                print("✓ New activity (close) PRESERVES last_read_at")
            else:
                print("⚠ New activity (close) CHANGES last_read_at")
        elif last_read_after_done is not None and last_read_after_close is None:
            print("✗ New activity (close) CLEARS last_read_at")

        # Check unread status progression
        print("\n** Unread status progression **")
        print(f"   Before read: {before_read.get('notification_unread')}")
        print(f"   After read:  {after_read.get('notification_unread')}")
        print(f"   After done:  {after_done.get('notification_unread')}")
        print(f"   After close: {after_close.get('notification_unread')}")

        # Compare notification updated_at with pre_close_time
        after_close_updated = after_close.get("notification_updated_at")
        if after_close_updated:
            print("\n** Notification updated_at after close **")
            print(f"   Notification: {after_close_updated}")
            print(f"   Pre-close:    {pre_close_time}")

        # Comments and timeline analysis
        print("\n** Activity counts **")
        print(f"   Comments before: {before_read.get('comments_count')}")
        print(f"   Comments after:  {after_close.get('comments_count')}")
        print(f"   Timeline before: {before_read.get('timeline_count')}")
        print(f"   Timeline after:  {after_close.get('timeline_count')}")

        print("\n" + "=" * 60)
        print("IMPLICATIONS FOR COMMENT FETCHING")
        print("=" * 60)

        if last_read_after_close is not None:
            print(f"\n✓ last_read_at is available: {last_read_after_close}")
            print("  You can use this as a 'since' filter to get only new activity.")
            print("  Comments/events with created_at > last_read_at are 'new'.")
        else:
            print("\n✗ last_read_at is None after the close event.")
            print("  No timestamp is available to filter 'new' activity.")
            print("  All comments would be fetched when notification returns.")
