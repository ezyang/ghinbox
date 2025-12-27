"""
Server CLI for the HTML notifications API.

Usage:
    python -m ghsim.api.server --account your_account

This starts the API server with live GitHub fetching enabled,
using the specified account's authenticated session.
"""

import argparse
import sys

import uvicorn

from ghsim.auth import has_valid_auth


def main() -> int:
    """Main entry point for the API server."""
    parser = argparse.ArgumentParser(
        description="Start the GitHub HTML Notifications API server",
    )
    parser.add_argument(
        "--account",
        "-a",
        help="ghsim account name for live GitHub fetching. "
        "Must have valid auth (run: python -m ghsim.auth ACCOUNT). "
        "Required unless --test is specified.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        "-p",
        type=int,
        default=8000,
        help="Port to bind to (default: 8000)",
    )
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="Disable auto-reload on code changes",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in headed mode (visible window)",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Test mode: skip account validation (for E2E tests with mocked APIs)",
    )

    args = parser.parse_args()

    # Set env vars so the app can recreate fetcher after reload
    import os

    if args.test:
        print("Starting server in TEST MODE (no live fetching)")
        # Don't set GHSIM_ACCOUNT - app will run without fetcher
    else:
        # Require account in non-test mode
        if not args.account:
            parser.error("--account is required (or use --test for testing)")

        # Validate account
        if not has_valid_auth(args.account):
            print(f"ERROR: No valid auth for account '{args.account}'")
            print(f"Run: python -m ghsim.auth {args.account}")
            return 1

        print(f"Starting server with account: {args.account}")
        os.environ["GHSIM_ACCOUNT"] = args.account
        os.environ["GHSIM_HEADLESS"] = "0" if args.headed else "1"

    print(f"Server: http://{args.host}:{args.port}")
    print(f"API docs: http://{args.host}:{args.port}/docs")
    print()

    uvicorn.run(
        "ghsim.api.app:app",
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
