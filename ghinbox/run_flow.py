"""
Runner for test flows.

Usage:
    python -m ghinbox.run_flow <flow_name> <owner_account> <trigger_account> [options]

Run with --help to list the available flows (derived from the FLOWS registry).
"""

import argparse
import sys

from ghinbox.flows import (
    AnchorTrackingFlow,
    BasicNotificationFlow,
    CommentFetchMarksReadFlow,
    CommentPrefetchValidationFlow,
    DoneThenCloseFlow,
    NotificationTimestampsFlow,
    PaginationFlow,
    ParserValidationFlow,
    ProdNotificationsSnapshotFlow,
    ProdUndoFlow,
    ReadVsDoneFlow,
)


FLOWS = {
    "anchor_tracking": AnchorTrackingFlow,
    "basic": BasicNotificationFlow,
    "comment_fetch_marks_read": CommentFetchMarksReadFlow,
    "comment_prefetch_validation": CommentPrefetchValidationFlow,
    "done_then_close": DoneThenCloseFlow,
    "notification_timestamps": NotificationTimestampsFlow,
    "pagination": PaginationFlow,
    "read_vs_done": ReadVsDoneFlow,
    "parser_validation": ParserValidationFlow,
    "prod_notifications_snapshot": ProdNotificationsSnapshotFlow,
    "prod_undo": ProdUndoFlow,
}


def _flows_epilog() -> str:
    width = max(len(name) for name in FLOWS)
    lines = [
        f"  {name:<{width}}  {flow_class.description}"
        for name, flow_class in sorted(FLOWS.items())
    ]
    return "Available flows:\n" + "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Run GitHub notification test flows",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_flows_epilog(),
    )
    parser.add_argument(
        "flow",
        choices=list(FLOWS.keys()),
        help="Flow to run",
    )
    parser.add_argument(
        "owner_account",
        help="Account that owns the repo (receives notifications)",
    )
    parser.add_argument(
        "trigger_account",
        help="Account that triggers notifications (creates issues)",
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
    parser.add_argument(
        "--num-issues",
        type=int,
        default=30,
        help="Number of issues to create (pagination flow only, default: 30)",
    )
    parser.add_argument(
        "--repo",
        help="Repository to snapshot (owner/repo, prod_notifications_snapshot only)",
    )
    parser.add_argument(
        "--pages",
        type=int,
        default=1,
        help="Pages of notifications to capture (prod_notifications_snapshot only)",
    )

    args = parser.parse_args()

    flow_class = FLOWS[args.flow]

    # Build kwargs based on flow type
    kwargs = {
        "owner_account": args.owner_account,
        "trigger_account": args.trigger_account,
        "headless": not args.headed,
        "cleanup": not args.no_cleanup,
    }

    # Add flow-specific arguments
    if args.flow == "pagination":
        kwargs["num_issues"] = args.num_issues
    if args.flow == "prod_notifications_snapshot":
        kwargs["repo"] = args.repo
        kwargs["pages"] = args.pages

    flow = flow_class(**kwargs)

    print(f"Running flow: {flow.name}")
    print(f"Description: {flow.description}")
    print()

    success = flow.run()
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
