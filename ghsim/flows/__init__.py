"""
Test flows for GitHub notification behavior verification.

Each flow tests a specific aspect of GitHub's notification system.
"""

from ghsim.flows.basic_notification import BasicNotificationFlow
from ghsim.flows.comment_fetch_marks_read import CommentFetchMarksReadFlow
from ghsim.flows.comment_prefetch_validation import CommentPrefetchValidationFlow
from ghsim.flows.notification_timestamps import NotificationTimestampsFlow
from ghsim.flows.pagination import PaginationFlow
from ghsim.flows.parser_validation import ParserValidationFlow
from ghsim.flows.prod_notifications_snapshot import ProdNotificationsSnapshotFlow
from ghsim.flows.read_vs_done import ReadVsDoneFlow

__all__ = [
    "BasicNotificationFlow",
    "CommentFetchMarksReadFlow",
    "CommentPrefetchValidationFlow",
    "NotificationTimestampsFlow",
    "PaginationFlow",
    "ParserValidationFlow",
    "ProdNotificationsSnapshotFlow",
    "ReadVsDoneFlow",
]
