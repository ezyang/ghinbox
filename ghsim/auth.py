"""
Headed login bootstrap script for GitHub authentication.

This script launches a headed browser for manual GitHub login and stores
the authentication state for later use by automated Playwright scripts.

Supports multiple accounts with separate credential stores.
"""

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, Page, BrowserContext


AUTH_STATE_DIR = Path("auth_state")


def get_auth_state_path(account: str) -> Path:
    """Get the path to the auth state file for a given account."""
    return AUTH_STATE_DIR / f"{account}.json"


def is_logged_in(page: Page) -> bool:
    """Check if the user is logged into GitHub."""
    # Check for the user avatar/menu which indicates logged-in state
    # The avatar appears in the header when logged in
    # Look for elements that only appear when logged in
    # The user menu button has a specific structure
    logged_in_indicator = page.locator('button[aria-label="Open user navigation menu"]')
    return logged_in_indicator.count() > 0


def wait_for_login(page: Page) -> bool:
    """
    Wait for the user to complete the login process.

    Args:
        page: The Playwright page object

    Returns:
        True if login was successful, False otherwise
    """
    print("Waiting for login to complete...")
    print("Please log in to GitHub in the browser window.")
    # Wait for the user navigation menu to appear (indicates logged in)
    page.wait_for_selector(
        'button[aria-label="Open user navigation menu"]',
        timeout=0,
        state="visible",
    )
    return True


def save_auth_state(context: BrowserContext, account: str) -> Path:
    """
    Save the browser authentication state to a file.

    Args:
        context: The Playwright browser context
        account: The account identifier for this auth state

    Returns:
        Path to the saved auth state file
    """
    AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
    auth_path = get_auth_state_path(account)
    context.storage_state(path=str(auth_path))
    return auth_path


def load_auth_state(account: str) -> dict | None:
    """
    Load the auth state for an account if it exists.

    Args:
        account: The account identifier

    Returns:
        The storage state dict or None if not found
    """
    auth_path = get_auth_state_path(account)
    if auth_path.exists():
        import json

        return json.loads(auth_path.read_text())
    return None


def has_valid_auth(account: str) -> bool:
    """Check if an account has stored auth state."""
    return get_auth_state_path(account).exists()


def login_interactive(account: str, force: bool = False) -> bool:
    """
    Perform interactive login for a GitHub account.

    Args:
        account: The account identifier (e.g., 'account1', 'account2')
        force: If True, force re-login even if auth state exists

    Returns:
        True if login was successful, False otherwise
    """
    auth_path = get_auth_state_path(account)

    if auth_path.exists() and not force:
        print(f"Auth state already exists for '{account}' at {auth_path}")
        print("Use --force to re-login")
        return True

    print(f"\n{'=' * 60}")
    print(f"GitHub Login for account: {account}")
    print(f"{'=' * 60}\n")

    with sync_playwright() as p:
        # Launch headed browser for manual login
        browser = p.chromium.launch(
            headless=False,
            args=["--start-maximized"],
        )

        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            # Start fresh without any existing state
        )

        page = context.new_page()

        # Navigate to GitHub login
        print("Navigating to GitHub login page...")
        page.goto("https://github.com/login")

        # Check if already logged in (from previous session cookies)
        if is_logged_in(page):
            print("Already logged in!")
        else:
            # Wait for manual login
            if not wait_for_login(page):
                print("Login failed or timed out.")
                browser.close()
                return False

        print("Login successful!")

        # Navigate to home to ensure we have full session
        page.goto("https://github.com")

        # Save the authentication state
        saved_path = save_auth_state(context, account)
        print(f"\nAuth state saved to: {saved_path}")

        browser.close()

    return True


def create_authenticated_context(
    playwright, account: str, headless: bool = True
) -> BrowserContext | None:
    """
    Create a browser context with stored authentication.

    Args:
        playwright: The Playwright instance
        account: The account identifier
        headless: Whether to run in headless mode

    Returns:
        An authenticated BrowserContext or None if auth state doesn't exist
    """
    auth_path = get_auth_state_path(account)

    if not auth_path.exists():
        print(f"No auth state found for '{account}'. Run login first.")
        return None

    browser = playwright.chromium.launch(headless=headless)
    context = browser.new_context(
        storage_state=str(auth_path),
        viewport={"width": 1280, "height": 800},
    )

    return context


def verify_auth(account: str) -> bool:
    """
    Verify that stored auth state is still valid.

    Args:
        account: The account identifier

    Returns:
        True if auth is valid, False otherwise
    """
    if not has_valid_auth(account):
        print(f"No auth state found for '{account}'")
        return False

    print(f"Verifying auth state for '{account}'...")

    with sync_playwright() as p:
        context = create_authenticated_context(p, account, headless=True)
        if context is None:
            return False

        page = context.new_page()
        page.goto("https://github.com")

        valid = is_logged_in(page)

        if valid:
            print(f"Auth state for '{account}' is valid!")
        else:
            print(f"Auth state for '{account}' is invalid or expired.")

        if context.browser:
            context.browser.close()

    return valid


def main():
    parser = argparse.ArgumentParser(
        description="GitHub login bootstrap for Playwright automation"
    )
    parser.add_argument(
        "account",
        help="Account identifier (e.g., 'account1', 'account2')",
    )
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Force re-login even if auth state exists",
    )
    parser.add_argument(
        "--verify",
        "-v",
        action="store_true",
        help="Verify existing auth state without logging in",
    )
    parser.add_argument(
        "--list",
        "-l",
        action="store_true",
        help="List all stored auth states",
    )

    args = parser.parse_args()

    if args.list:
        if AUTH_STATE_DIR.exists():
            states = list(AUTH_STATE_DIR.glob("*.json"))
            if states:
                print("Stored auth states:")
                for state in states:
                    account = state.stem
                    print(f"  - {account}")
            else:
                print("No auth states found.")
        else:
            print("No auth states found.")
        return 0

    if args.verify:
        success = verify_auth(args.account)
        return 0 if success else 1

    success = login_interactive(args.account, force=args.force)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
