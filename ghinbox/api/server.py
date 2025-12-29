"""
Server CLI for the HTML notifications API.

Usage:
    python -m ghinbox.api.server              # Uses default account (auto-setup on first run)
    python -m ghinbox.api.server --account X  # Uses specific account X

This starts the API server with live GitHub fetching enabled,
using the specified account's authenticated session.
"""

import argparse
import sys

import uvicorn

from ghinbox.auth import (
    has_valid_auth,
    verify_auth,
    login_interactive,
    load_username,
    DEFAULT_ACCOUNT,
)
from ghinbox.token import has_token, provision_token, verify_token


def setup_default_account(headed: bool = False) -> tuple[bool, str | None]:
    """
    Set up the default account with authentication and token.

    Args:
        headed: Whether to run browser in headed mode for token provisioning

    Returns:
        Tuple of (success, username)
    """
    print("\n" + "=" * 60)
    print("First-time setup: Setting up default GitHub account")
    print("=" * 60 + "\n")

    # Step 1: Interactive login (always headed for login)
    if not has_valid_auth(DEFAULT_ACCOUNT):
        print("Step 1: GitHub Login")
        print("-" * 40)
        result = login_interactive(DEFAULT_ACCOUNT, save_username_flag=True)
        if isinstance(result, tuple):
            success, username = result
        else:
            success = result
            username = load_username(DEFAULT_ACCOUNT)

        if not success:
            print("ERROR: Login failed")
            return False, None
    else:
        username = load_username(DEFAULT_ACCOUNT)
        print(f"Auth already configured for: {username or 'default'}")

    # Step 2: Token provisioning
    if not has_token(DEFAULT_ACCOUNT):
        print("\nStep 2: GitHub API Token")
        print("-" * 40)
        token = provision_token(
            DEFAULT_ACCOUNT,
            force=False,
            headless=not headed,
            prod=True,  # Use reduced scopes for default account
        )
        if not token:
            print("ERROR: Token provisioning failed")
            return False, username
    else:
        print("Token already configured")

    print("\n" + "=" * 60)
    print("Setup complete!")
    print("=" * 60 + "\n")

    return True, username


def main() -> int:
    """Main entry point for the API server."""
    parser = argparse.ArgumentParser(
        description="Start the GitHub HTML Notifications API server",
    )
    parser.add_argument(
        "--account",
        "-a",
        help="ghinbox account name for live GitHub fetching. "
        "If not specified, uses the default account (auto-setup on first run).",
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help=(
            "Host to bind to (default: 0.0.0.0, listens on localhost and "
            "Tailnet 10.*.*.*)."
        ),
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
        # Set test mode flag so /health/test endpoint works
        os.environ["GHINBOX_TEST_MODE"] = "1"
    else:
        # Determine which account to use
        account = args.account or DEFAULT_ACCOUNT

        # Check if account needs setup
        if not has_valid_auth(account):
            if account == DEFAULT_ACCOUNT:
                # Auto-setup for default account
                success, username = setup_default_account(headed=args.headed)
                if not success:
                    return 1
            else:
                # Explicit account must be set up manually
                print(f"ERROR: No valid auth for account '{account}'")
                print(f"Run: python -m ghinbox.auth {account}")
                return 1
        else:
            # Account exists, check for token
            if not has_token(account):
                if account == DEFAULT_ACCOUNT:
                    # Auto-provision token for default account
                    print("Token not found, provisioning...")
                    token = provision_token(
                        account, force=False, headless=not args.headed, prod=True
                    )
                    if not token:
                        print("ERROR: Token provisioning failed")
                        return 1
                else:
                    print(f"WARNING: No token for account '{account}'")
                    print(f"Run: python -m ghinbox.token {account}")
                    print("API proxy features will not work without a token.\n")

        # Verify the token actually works
        if has_token(account):
            print("Verifying GitHub token...")
            is_valid, github_login = verify_token(account)
            if not is_valid:
                print("Token is invalid or expired.")
                if account == DEFAULT_ACCOUNT:
                    # First verify browser auth is valid (needed for token provisioning)
                    print("Checking browser authentication...")
                    if not verify_auth(account):
                        print("Browser auth is also invalid. Re-authenticating...")
                        result = login_interactive(
                            account, force=True, save_username_flag=True
                        )
                        if isinstance(result, tuple):
                            success, _ = result
                        else:
                            success = result
                        if not success:
                            print("ERROR: Browser re-authentication failed")
                            return 1

                    print("Re-provisioning token (browser window will open)...")
                    token = provision_token(
                        account, force=True, headless=False, prod=True
                    )
                    if not token:
                        print("ERROR: Token re-provisioning failed")
                        return 1
                    # Verify the new token
                    is_valid, github_login = verify_token(account)
                    if not is_valid:
                        print("ERROR: New token verification failed")
                        return 1
                    print(f"Token verified for GitHub user: {github_login}")
                else:
                    print(f"Run: python -m ghinbox.token {account} --force")
                    return 1
            else:
                print(f"Token verified for GitHub user: {github_login}")

        # Show account info
        username = load_username(account)
        if username:
            print(f"Starting server with account: {account} (GitHub: {username})")
        else:
            print(f"Starting server with account: {account}")

        os.environ["GHSIM_ACCOUNT"] = account
        os.environ["GHSIM_HEADLESS"] = "0" if args.headed else "1"

    display_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    print(f"Server: http://{display_host}:{args.port}")
    print(f"API docs: http://{display_host}:{args.port}/docs")
    print()

    uvicorn.run(
        "ghinbox.api.app:app",
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
