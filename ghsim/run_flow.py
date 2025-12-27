"""
Runner for test flows.

Usage:
    python -m ghsim.run_flow <flow_name> <owner_account> <trigger_account> [options]

Available flows:
    basic             - Basic notification generation test
    comment_fetch_marks_read - Check if API comment fetch flips read state
    notification_timestamps - Probe notification timestamp meaning and event loading
    pagination        - Generate 26+ notifications to test pagination
    read_vs_done      - Test read vs done state visibility in API
    parser_validation - Validate HTML parser against API notifications
"""

import argparse
import sys

from ghsim.flows import (
    BasicNotificationFlow,
    CommentFetchMarksReadFlow,
    NotificationTimestampsFlow,
    PaginationFlow,
    ParserValidationFlow,
    ReadVsDoneFlow,
)


FLOWS = {
    "basic": BasicNotificationFlow,
    "comment_fetch_marks_read": CommentFetchMarksReadFlow,
    "notification_timestamps": NotificationTimestampsFlow,
    "pagination": PaginationFlow,
    "read_vs_done": ReadVsDoneFlow,
    "parser_validation": ParserValidationFlow,
}


def main():
    parser = argparse.ArgumentParser(
        description="Run GitHub notification test flows",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Available flows:
  basic             - Basic notification generation and visibility test
  comment_fetch_marks_read - Check if API comment fetch flips read state
  notification_timestamps - Probe notification timestamp meaning and event loading
  pagination        - Generate 26+ notifications to test pagination
  read_vs_done      - Test whether API can distinguish read from done notifications
  parser_validation - Validate HTML parser against API notifications
        """,
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

    flow = flow_class(**kwargs)

    print(f"Running flow: {flow.name}")
    print(f"Description: {flow.description}")
    print()

    success = flow.run()
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
