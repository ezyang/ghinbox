"""
Comment fetch marks read flow - checks if fetching issue comments marks notification read.

This flow:
1. Creates an issue to generate a notification
2. Captures initial notification/thread state
3. Fetches issue comments via API as the notification owner
4. Captures notification/thread state again to see if it became read
"""

from __future__ import annotations

import time
from typing import Any

from ghsim.flows.base import BaseFlow
from ghsim.github_api import save_response


class CommentFetchMarksReadFlow(BaseFlow):
    """Test whether fetching issue comments marks the notification as read."""

    name = "comment_fetch_marks_read"
    description = "Check if API comment fetch flips notification read state"

    def run(self) -> bool:
        if not self.validate_prerequisites():
            return False

        try:
            if not self.setup_test_repo():
                return False

            issue = self.create_test_issue()
            issue_number = issue.get("number")
            if not isinstance(issue_number, int):
                print("ERROR: Issue number missing from API response")
                return False

            notification = self.wait_for_notification()
            if not notification:
                print("ERROR: Notification not found via API")
                return False

            thread_id = notification.get("id")
            if not isinstance(thread_id, str):
                print("ERROR: Notification thread ID missing")
                return False

            print(f"\nNotification thread ID: {thread_id}")

            print(f"\n{'=' * 60}")
            print("Snapshot 1: Before fetching comments")
            print(f"{'=' * 60}")
            before = self._capture_state("before", thread_id)
            self._print_state_summary("before", before)

            print(f"\n{'=' * 60}")
            print("Fetching issue comments via API")
            print(f"{'=' * 60}")
            assert self.owner_api is not None, "Must call validate_prerequisites first"
            comments = self.owner_api.list_issue_comments(
                self.owner_username, self.repo_name, issue_number
            )
            print(f"Fetched {len(comments)} issue comments")

            time.sleep(2)

            print(f"\n{'=' * 60}")
            print("Snapshot 2: After fetching comments")
            print(f"{'=' * 60}")
            after = self._capture_state("after", thread_id)
            self._print_state_summary("after", after)

            print(f"\n{'=' * 60}")
            print("ANALYSIS: Read state change")
            print(f"{'=' * 60}")
            before_unread = self._get_notification_unread(before)
            after_unread = self._get_notification_unread(after)
            print(f"Unread before: {before_unread}")
            print(f"Unread after:  {after_unread}")

            return True
        finally:
            self.cleanup_test_repo()

    def _capture_state(self, label: str, thread_id: str) -> dict[str, Any]:
        assert self.owner_api is not None, "Must call validate_prerequisites first"

        notifications_all = self.owner_api.get_notifications(all_notifications=True)
        our_notification = next(
            (
                notif
                for notif in notifications_all
                if notif.get("repository", {}).get("name") == self.repo_name
            ),
            None,
        )
        thread = self.owner_api.get_notification_thread(thread_id)

        snapshot = {
            "label": label,
            "notification": our_notification,
            "thread": thread,
            "notifications_all_count": len(notifications_all),
        }
        save_response(f"comment_fetch_marks_read_{label}", snapshot, "json")
        return snapshot

    def _get_notification_unread(self, snapshot: dict[str, Any]) -> Any:
        notification = snapshot.get("notification") or {}
        return notification.get("unread")

    def _print_state_summary(self, label: str, snapshot: dict[str, Any]) -> None:
        notification = snapshot.get("notification") or {}
        thread = snapshot.get("thread") or {}
        print(f"State ({label}):")
        print(f"  notification.unread: {notification.get('unread')}")
        print(f"  notification.last_read_at: {notification.get('last_read_at')}")
        print(f"  notification.updated_at: {notification.get('updated_at')}")
        print(f"  thread.last_read_at: {thread.get('last_read_at')}")
        print(f"  thread.updated_at: {thread.get('updated_at')}")
