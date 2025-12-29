"""
Anchor Tracking flow - explores how GitHub updates notification link anchors.

This flow tests the hypothesis that the anchor in notification URLs
(e.g., #issuecomment-12345) indicates the first unread comment and
updates after you view the issue page.

Revised test sequence (based on observation that anchors appear after partial reads):
1. B creates issue
2. A reads it (views issue page) - marks as read
3. A marks notification as done
4. B adds a comment - triggers new notification
5. Capture notification - should now have anchor pointing to new comment
6. A reads it again
7. B adds another comment
8. Capture notification - anchor should point to newest comment
"""

from __future__ import annotations

import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, Page

from ghinbox.flows.base import BaseFlow
from ghinbox.github_api import save_response, RESPONSES_DIR
from ghinbox.parser.notifications import parse_notifications_html


class AnchorTrackingFlow(BaseFlow):
    """Track how notification link anchors change with read state."""

    name = "anchor_tracking"
    description = "Track notification anchor changes to understand read state"

    def run(self) -> bool:
        """Run the anchor tracking test."""
        if not self.validate_prerequisites():
            return False

        try:
            if not self.setup_test_repo():
                return False

            # Step 1: B creates issue
            print(f"\n{'=' * 60}")
            print("Step 1: B creates issue")
            print(f"{'=' * 60}")

            issue = self.create_test_issue()
            issue_number = issue.get("number")
            if not isinstance(issue_number, int):
                print("ERROR: Issue number missing")
                return False

            # Wait for notification
            notification = self.wait_for_notification()
            if not notification:
                print("ERROR: Notification not found")
                return False

            # Capture initial state (no anchor expected)
            anchor_1 = self._capture_notification_anchor("step1_initial")

            # Step 2: A reads it (views issue page)
            print(f"\n{'=' * 60}")
            print("Step 2: A reads notification (visiting issue page)")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._visit_issue_page(page, issue_number)

                if context.browser:
                    context.browser.close()

            time.sleep(3)
            anchor_2 = self._capture_notification_anchor("step2_after_read")

            # Step 3: A marks notification as done
            print(f"\n{'=' * 60}")
            print("Step 3: A marks notification as DONE")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._mark_as_done(page)

                if context.browser:
                    context.browser.close()

            time.sleep(3)
            anchor_3 = self._capture_notification_anchor("step3_after_done")

            # Step 4: B adds a comment - should trigger notification with anchor
            print(f"\n{'=' * 60}")
            print("Step 4: B adds first comment (after A marked done)")
            print(f"{'=' * 60}")

            assert self.trigger_api is not None
            comment1 = self.trigger_api.create_issue_comment(
                self.owner_username,
                self.repo_name,
                issue_number,
                f"First comment after done - {datetime.now(timezone.utc).isoformat()}",
            )
            print(f"Comment 1 ID: {comment1.get('id')}")

            # Wait for notification to reappear via API
            print("Waiting for notification to reappear...")
            self._wait_for_notification_reappear()

            # This is the key capture - should have anchor!
            anchor_4 = self._capture_notification_anchor("step4_after_comment1")

            # Step 5: A reads it again
            print(f"\n{'=' * 60}")
            print("Step 5: A reads notification again")
            print(f"{'=' * 60}")

            with sync_playwright() as p:
                context = self.create_browser_context(p)
                if context is None:
                    print("Failed to create browser context")
                    return False

                page = context.new_page()
                self._visit_issue_page(page, issue_number)

                if context.browser:
                    context.browser.close()

            time.sleep(3)
            anchor_5 = self._capture_notification_anchor("step5_after_read2")

            # Step 6: B adds another comment
            print(f"\n{'=' * 60}")
            print("Step 6: B adds second comment")
            print(f"{'=' * 60}")

            comment2 = self.trigger_api.create_issue_comment(
                self.owner_username,
                self.repo_name,
                issue_number,
                f"Second comment - {datetime.now(timezone.utc).isoformat()}",
            )
            print(f"Comment 2 ID: {comment2.get('id')}")
            time.sleep(5)

            anchor_6 = self._capture_notification_anchor("step6_after_comment2")

            # Analysis
            print(f"\n{'=' * 60}")
            print("ANALYSIS: Anchor Progression")
            print(f"{'=' * 60}")

            self._analyze_anchors(
                [
                    ("1. Initial (issue created)", anchor_1),
                    ("2. After A reads", anchor_2),
                    ("3. After A marks done", anchor_3),
                    ("4. After B adds comment1 (KEY)", anchor_4),
                    ("5. After A reads again", anchor_5),
                    ("6. After B adds comment2", anchor_6),
                ],
                [comment1.get("id"), comment2.get("id")],
            )

            return True

        finally:
            self.cleanup_test_repo()

    def _capture_notification_anchor(self, label: str) -> dict[str, Any]:
        """Capture the notification HTML and extract the anchor."""
        with sync_playwright() as p:
            context = self.create_browser_context(p)
            if context is None:
                return {"error": "Failed to create browser context"}

            page = context.new_page()
            RESPONSES_DIR.mkdir(parents=True, exist_ok=True)

            # Try multiple views to find the notification
            views = [
                ("inbox", f"repo:{self.owner_username}/{self.repo_name}"),
                ("all", f"repo:{self.owner_username}/{self.repo_name} is:all"),
                ("unread", f"repo:{self.owner_username}/{self.repo_name} is:unread"),
            ]

            result: dict[str, Any] = {
                "label": label,
                "notification_count": 0,
                "views_checked": [],
            }

            for view_name, query in views:
                url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"
                page.goto(url, wait_until="domcontentloaded")
                page.locator(".notifications-list-item, .blankslate").first.wait_for(
                    state="attached", timeout=10000
                )
                time.sleep(1)

                html_content = page.content()

                # Parse HTML
                parsed = parse_notifications_html(
                    html=html_content,
                    owner=self.owner_username,
                    repo=self.repo_name,
                    source_url=url,
                )

                result["views_checked"].append(
                    {"view": view_name, "count": len(parsed.notifications)}
                )

                if parsed.notifications:
                    notif = parsed.notifications[0]
                    full_url = notif.subject.url
                    parsed_url = urlparse(full_url)

                    result["notification_count"] = len(parsed.notifications)
                    result["full_url"] = full_url
                    result["anchor"] = parsed_url.fragment or "(no anchor)"
                    result["unread"] = notif.unread
                    result["found_in_view"] = view_name

                    save_response(f"anchor_{label}_html", html_content, "html")
                    page.screenshot(path=str(RESPONSES_DIR / f"anchor_{label}.png"))

                    print(f"  [{label}] Found in '{view_name}' view")
                    print(f"  [{label}] URL: {full_url}")
                    print(f"  [{label}] Anchor: {result['anchor']}")
                    print(f"  [{label}] Unread: {notif.unread}")
                    break
            else:
                # Not found in any view
                result["anchor"] = "(no notification found)"
                print(f"  [{label}] No notification found in any view")
                print(f"  [{label}] Views checked: {result['views_checked']}")

            if context.browser:
                context.browser.close()

            save_response(f"anchor_{label}", result, "json")
            return result

    def _visit_issue_page(self, page: Page, issue_number: int) -> None:
        """Visit the issue page to mark notification as read."""
        issue_url = (
            f"https://github.com/{self.owner_username}/{self.repo_name}"
            f"/issues/{issue_number}"
        )
        print(f"Visiting: {issue_url}")

        page.goto(issue_url, wait_until="domcontentloaded")
        page.locator(".js-issue-title, .markdown-body").first.wait_for(
            state="attached", timeout=10000
        )

        RESPONSES_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(RESPONSES_DIR / "anchor_issue_page.png"))
        print("Issue page loaded")

    def _wait_for_notification_reappear(
        self, max_attempts: int = 10, wait_seconds: int = 3
    ) -> bool:
        """Wait for the notification to reappear after new activity."""
        assert self.owner_api is not None

        for attempt in range(max_attempts):
            if attempt > 0:
                print(f"  Attempt {attempt + 1}/{max_attempts}...")
                time.sleep(wait_seconds)

            notifications = self.owner_api.get_notifications(all_notifications=True)
            for notif in notifications:
                if notif.get("repository", {}).get("name") == self.repo_name:
                    print(f"  Notification found! Unread: {notif.get('unread')}")
                    return True

        print("  Notification did not reappear")
        return False

    def _mark_as_done(self, page: Page) -> None:
        """Mark the notification as done."""
        query = f"repo:{self.owner_username}/{self.repo_name}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        page.goto(url, wait_until="domcontentloaded")
        page.locator(".notifications-list-item, .blankslate").first.wait_for(
            state="attached", timeout=10000
        )

        # Find and click checkbox, then Done button
        notification_checkbox = page.locator(
            f'.notifications-list-item:has(a[href*="{self.repo_name}"]) input[type="checkbox"]'
        ).first

        if notification_checkbox.count() > 0:
            notification_checkbox.check()
            done_button = page.locator('button:has-text("Done")').first
            done_button.wait_for(state="visible", timeout=5000)
            done_button.click()
            page.locator(
                f'.notifications-list-item:has(a[href*="{self.repo_name}"])'
            ).wait_for(state="hidden", timeout=10000)
            print("Marked notification as done")
        else:
            print("WARNING: Could not find notification to mark as done")

    def _analyze_anchors(
        self,
        anchors: list[tuple[str, dict[str, Any]]],
        comment_ids: list[int | None],
    ) -> None:
        """Analyze the progression of anchors and validate expected behavior."""
        print("\nANCHOR PROGRESSION:")
        print("-" * 60)

        for label, data in anchors:
            anchor = data.get("anchor", "?")
            unread = data.get("unread", "?")
            found_in = data.get("found_in_view", "-")
            print(f"  {label}:")
            print(f"    Anchor: {anchor}")
            print(f"    Unread: {unread}")
            print(f"    View: {found_in}")

        print("\nCOMMENT IDs (for reference):")
        print("-" * 60)
        for i, cid in enumerate(comment_ids, 1):
            print(f"  Comment {i}: issuecomment-{cid}")

        # Validation
        print("\n" + "=" * 60)
        print("VALIDATION RESULTS")
        print("=" * 60)

        # Find the final anchor (step 6 - after second comment)
        final_data = anchors[-1][1]
        final_anchor = final_data.get("anchor", "")
        comment1_id = comment_ids[0]
        comment2_id = comment_ids[1] if len(comment_ids) > 1 else None

        expected_anchor = f"issuecomment-{comment1_id}"

        if final_anchor == expected_anchor:
            print("\n✓ PASS: Anchor correctly points to first unread comment")
            print(f"  Expected: {expected_anchor}")
            print(f"  Got:      {final_anchor}")
            print("\n  This confirms GitHub tracks read state at comment level.")
            print("  The anchor can be used to filter 'new' comments.")
        elif comment2_id and final_anchor == f"issuecomment-{comment2_id}":
            print("\n✗ FAIL: Anchor points to most recent comment, not first unread")
            print(f"  Expected: {expected_anchor}")
            print(f"  Got:      {final_anchor}")
        elif final_anchor in ("(no anchor)", "(no notification found)"):
            print("\n⚠ INCONCLUSIVE: No anchor found in final state")
            print(f"  Expected: {expected_anchor}")
            print(f"  Got:      {final_anchor}")
            print("\n  This may indicate a timing issue or behavior change.")
        else:
            print("\n? UNEXPECTED: Anchor doesn't match any known comment")
            print(f"  Expected: {expected_anchor}")
            print(f"  Got:      {final_anchor}")

        # Check unread status
        final_unread = final_data.get("unread")
        if final_unread is True:
            print("\n✓ Notification correctly marked as unread after new activity")
        elif final_unread is False:
            print("\n⚠ Notification still marked as read (unexpected)")
        else:
            print("\n⚠ Could not determine unread status")
