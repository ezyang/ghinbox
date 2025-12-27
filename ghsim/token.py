"""
GitHub API token provisioning script.

This script uses Playwright to automate the creation of GitHub Personal Access Tokens
(classic) through the web UI. It requires prior authentication via auth.py.
"""

import argparse
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, Page

from ghsim.auth import (
    has_valid_auth,
    create_authenticated_context,
)


TOKEN_DIR = Path("auth_state")

# Scopes for test accounts (can create/delete repos)
TEST_SCOPES = ["repo", "notifications", "delete_repo"]

# Scopes for prod accounts (read-only, no destructive operations)
PROD_SCOPES = ["repo", "notifications"]


def get_token_path(account: str) -> Path:
    """Get the path to the token file for a given account."""
    return TOKEN_DIR / f"{account}.token"


def has_token(account: str) -> bool:
    """Check if a token already exists for this account."""
    return get_token_path(account).exists()


def load_token(account: str) -> str | None:
    """Load the token for an account if it exists."""
    token_path = get_token_path(account)
    if token_path.exists():
        return token_path.read_text().strip()
    return None


def save_token(account: str, token: str) -> Path:
    """Save a token to file."""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    token_path = get_token_path(account)
    token_path.write_text(token)
    # Set restrictive permissions
    token_path.chmod(0o600)
    return token_path


def provision_token(
    account: str,
    token_name: str | None = None,
    force: bool = False,
    headless: bool = False,
    prod: bool = False,
) -> str | None:
    """
    Provision a new GitHub Personal Access Token (classic).

    This navigates to GitHub's token settings and creates a new classic
    personal access token with the required scopes for notification management.

    Args:
        account: The account identifier
        token_name: Name for the token (default: ghsim-{account}-{timestamp})
        force: If True, create new token even if one exists
        headless: If True, run browser in headless mode
        prod: If True, use reduced scopes (no delete_repo)

    Returns:
        The token string or None if provisioning failed
    """
    if not has_valid_auth(account):
        print(f"No valid auth state for '{account}'. Run login first:")
        print(f"  python -m ghsim.auth {account}")
        return None

    existing_token = load_token(account)
    if existing_token and not force:
        print(f"Token already exists for '{account}'")
        print("Use --force to create a new token")
        return existing_token

    if token_name is None:
        timestamp = int(time.time())
        token_name = f"ghsim-{account}-{timestamp}"

    scopes = PROD_SCOPES if prod else TEST_SCOPES

    print(f"\n{'=' * 60}")
    print(f"Provisioning GitHub API Token (classic) for: {account}")
    print(f"Token name: {token_name}")
    print(f"Mode: {'PROD (reduced scopes)' if prod else 'TEST (full scopes)'}")
    print(f"Scopes: {', '.join(scopes)}")
    print(f"{'=' * 60}\n")

    with sync_playwright() as p:
        context = create_authenticated_context(p, account, headless=headless)
        if context is None:
            return None

        page = context.new_page()

        try:
            token = _create_classic_token(page, token_name, scopes)

            if token:
                saved_path = save_token(account, token)
                print(f"\nToken saved to: {saved_path}")
                print("Token value (copy this, it won't be shown again):")
                print(f"  {token}")
                return token
            else:
                print("Failed to extract token from page")
                return None

        except Exception as e:
            print(f"Error during token provisioning: {e}")
            import traceback

            traceback.print_exc()
            # Take a screenshot for debugging
            page.screenshot(path=f"token_error_{account}.png")
            print(f"Screenshot saved to token_error_{account}.png")
            return None

        finally:
            if context.browser:
                context.browser.close()


def _create_classic_token(page: Page, token_name: str, scopes: list[str]) -> str | None:
    """
    Create a classic personal access token with specified scopes.

    Args:
        page: Playwright page
        token_name: Name for the token
        scopes: List of scope names to enable
    """
    # Navigate to classic token creation page
    print("Navigating to classic token creation page...")
    page.goto("https://github.com/settings/tokens/new", wait_until="domcontentloaded")
    # Wait for the token form to be ready
    page.locator(
        "#oauth_access_token_description, "
        'input[name="oauth_access[description]"], '
        'input[name="description"]'
    ).first.wait_for(state="visible", timeout=30000)

    # Take a debug screenshot
    page.screenshot(path="token_page_loaded.png")
    print("Screenshot saved to token_page_loaded.png")

    # Check if we need to re-authenticate (sudo mode)
    # GitHub may redirect to password confirmation
    if (
        "Confirm access" in page.content()
        or "password" in page.url.lower()
        or "sudo" in page.url.lower()
        or page.locator('input[type="password"]').count() > 0
    ):
        print("\n" + "=" * 60)
        print("GitHub requires password confirmation (sudo mode)")
        print("Please enter your password in the browser window")
        print("=" * 60 + "\n")

        # Wait for navigation back to tokens page after password entry
        page.wait_for_url(
            "**/settings/tokens/new",
            timeout=120000,  # 2 minutes to enter password
        )
        # Wait for the form to be ready again
        page.locator(
            "#oauth_access_token_description, "
            'input[name="oauth_access[description]"], '
            'input[name="description"]'
        ).first.wait_for(state="visible", timeout=30000)

    # Fill in token note/name - try multiple selectors
    print("Filling in token details...")
    note_input = page.locator(
        "#oauth_access_token_description, "
        'input[name="oauth_access[description]"], '
        'input[name="description"], '
        'input[placeholder*="Note"], '
        'input[aria-label*="Note"]'
    ).first
    note_input.wait_for(state="visible", timeout=30000)
    note_input.fill(token_name)

    # Set expiration - select "No expiration" or a long duration
    # The expiration dropdown has id "oauth_access_token_expires_at"
    expiration_select = page.locator("#oauth_access_token_expires_at")
    if expiration_select.count() > 0:
        # Try to select 90 days, or no expiration
        try:
            expiration_select.select_option("90")
            print("  Set expiration to 90 days")
        except Exception:
            # If 90 days not available, try other options
            try:
                expiration_select.select_option("none")
                print("  Set expiration to no expiration")
            except Exception:
                print("  Could not set expiration, using default")

    # Select scopes
    print("Selecting scopes...")
    for scope in scopes:
        checkbox = page.locator(f'input[type="checkbox"][value="{scope}"]')
        if checkbox.count() > 0:
            if not checkbox.is_checked():
                checkbox.check()
                print(f"  Checked scope: {scope}")
            else:
                print(f"  Scope already checked: {scope}")
        else:
            # Try by id
            checkbox = page.locator(f"#oauth_access_token_scopes_{scope}")
            if checkbox.count() > 0:
                if not checkbox.is_checked():
                    checkbox.check()
                    print(f"  Checked scope: {scope}")
            else:
                print(f"  Warning: Could not find scope checkbox for '{scope}'")

    # Take a screenshot before submission for verification
    page.screenshot(path="token_before_submit.png")
    print("Screenshot saved to token_before_submit.png")

    # Submit the form - look for the "Generate token" button
    print("Submitting token creation form...")
    generate_button = page.locator('button:has-text("Generate token")').first
    if generate_button.count() == 0:
        generate_button = page.locator('button[type="submit"]').first

    generate_button.click()

    # Wait for the token to be generated - look for token display elements
    page.locator(
        '#new-oauth-token, input[readonly][value^="ghp_"], code:has-text("ghp_")'
    ).first.wait_for(state="visible", timeout=30000)

    # Classic tokens start with "ghp_"
    token = None

    # Method 1: Look for the token in a code/input element
    token_element = page.locator("#new-oauth-token")
    if token_element.count() > 0:
        token = token_element.get_attribute("value")

    # Method 2: Look for readonly input with token value
    if not token:
        copy_input = page.locator('input[readonly][value^="ghp_"]')
        if copy_input.count() > 0:
            token = copy_input.get_attribute("value")

    # Method 3: Look in the page content for ghp_ pattern
    if not token:
        content = page.content()
        match = re.search(r"(ghp_[A-Za-z0-9]+)", content)
        if match:
            token = match.group(1)

    # Method 4: Check code elements
    if not token:
        code_elements = page.locator("code")
        for i in range(code_elements.count()):
            text = code_elements.nth(i).text_content()
            if text and text.startswith("ghp_"):
                token = text
                break

    # Take a screenshot of the result
    page.screenshot(path="token_result.png")
    print("Screenshot saved to token_result.png")

    return token


def main():
    parser = argparse.ArgumentParser(
        description="Provision GitHub API tokens via Playwright automation"
    )
    parser.add_argument(
        "account",
        help="Account identifier (must have auth state from login)",
    )
    parser.add_argument(
        "--name",
        "-n",
        help="Custom name for the token",
    )
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Create new token even if one exists",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in headed mode (visible)",
    )
    parser.add_argument(
        "--prod",
        action="store_true",
        help="Use reduced scopes for production (no delete_repo)",
    )
    parser.add_argument(
        "--show",
        "-s",
        action="store_true",
        help="Show the stored token for this account",
    )

    args = parser.parse_args()

    if args.show:
        token = load_token(args.account)
        if token:
            print(f"Token for '{args.account}':")
            print(f"  {token}")
        else:
            print(f"No token found for '{args.account}'")
        return 0

    token = provision_token(
        args.account,
        token_name=args.name,
        force=args.force,
        headless=not args.headed,
        prod=args.prod,
    )

    return 0 if token else 1


if __name__ == "__main__":
    sys.exit(main())
