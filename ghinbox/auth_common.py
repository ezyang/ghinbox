"""
Shared GitHub authentication helpers.

This module is the single source of truth for GitHub auth selectors, username
extraction, and Playwright storage-state persistence across sync and async
callers.
"""

from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from playwright.async_api import BrowserContext as AsyncBrowserContext
from playwright.async_api import Page as AsyncPage
from playwright.sync_api import BrowserContext as SyncBrowserContext
from playwright.sync_api import Page as SyncPage


AUTH_STATE_DIR = Path("auth_state")

# Special account name for the default/primary user
DEFAULT_ACCOUNT = "default"

USER_MENU_SELECTOR = 'button[aria-label="Open user navigation menu"]'
USER_LOGIN_META_SELECTOR = 'meta[name="user-login"]'
USER_LOGIN_PRESENT_SELECTOR = 'meta[name="user-login"][content]:not([content=""])'
PROFILE_LINK_SELECTOR = 'a[href^="/"]:has-text("Your profile")'
PROFILE_SETTINGS_LINK_SELECTOR = 'a[href*="/settings/profile"]'
PROFILE_SETTINGS_URL = "https://github.com/settings/profile"

GITHUB_LOGGED_IN_SELECTORS: tuple[str, ...] = (
    USER_MENU_SELECTOR,
    "img.avatar.circle",
    USER_LOGIN_PRESENT_SELECTOR,
    PROFILE_SETTINGS_LINK_SELECTOR,
)

NOTIFICATIONS_LIST_ITEM_SELECTOR = ".notifications-list-item"
NOTIFICATIONS_BLANKSLATE_SELECTOR = ".blankslate"
LOGGED_OUT_BODY_SELECTOR = "body.logged-out"
SESSION_AUTHENTICATION_SELECTOR = ".session-authentication"
AUTHENTICATION_HEADER_SELECTOR = ".authentication-header"
AUTH_FORM_SELECTOR = ".auth-form"
LOGIN_ROUTE_META_SELECTOR = 'meta[name="route-pattern"][content*="/login"]'
EMPTY_USER_LOGIN_META_SELECTOR = 'meta[name="user-login"][content=""]'

GITHUB_LOGIN_PAGE_READY_SELECTORS: tuple[str, ...] = (
    LOGGED_OUT_BODY_SELECTOR,
    SESSION_AUTHENTICATION_SELECTOR,
    AUTH_FORM_SELECTOR,
    LOGIN_ROUTE_META_SELECTOR,
    EMPTY_USER_LOGIN_META_SELECTOR,
)
GITHUB_PAGE_READY_SELECTORS: tuple[str, ...] = (
    NOTIFICATIONS_LIST_ITEM_SELECTOR,
    NOTIFICATIONS_BLANKSLATE_SELECTOR,
    *GITHUB_LOGIN_PAGE_READY_SELECTORS,
)
GITHUB_PAGE_READY_SELECTOR = ", ".join(GITHUB_PAGE_READY_SELECTORS)

GITHUB_LOGIN_AUTHENTICATION_SELECTORS: tuple[str, ...] = (
    SESSION_AUTHENTICATION_SELECTOR,
    AUTHENTICATION_HEADER_SELECTOR,
)
GITHUB_LOGIN_AUTHENTICATION_SELECTOR = ", ".join(GITHUB_LOGIN_AUTHENTICATION_SELECTORS)


def get_auth_state_path(account: str) -> Path:
    """Get the path to the auth state file for a given account."""
    return AUTH_STATE_DIR / f"{account}.json"


def get_username_path(account: str) -> Path:
    """Get the path to the username file for a given account."""
    return AUTH_STATE_DIR / f"{account}.username"


def save_username(account: str, username: str) -> Path:
    """Save the username for an account."""
    AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
    username_path = get_username_path(account)
    username_path.write_text(username)
    return username_path


def load_username(account: str) -> str | None:
    """Load the username for an account if it exists."""
    username_path = get_username_path(account)
    if username_path.exists():
        return username_path.read_text().strip()
    return None


def save_auth_state(context: SyncBrowserContext, account: str) -> Path:
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


async def save_auth_state_async(context: AsyncBrowserContext, account: str) -> Path:
    """
    Save the async browser authentication state to a file.

    Args:
        context: The Playwright browser context
        account: The account identifier for this auth state

    Returns:
        Path to the saved auth state file
    """
    AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
    auth_path = get_auth_state_path(account)
    await context.storage_state(path=str(auth_path))
    return auth_path


def _username_from_signals(
    *,
    avatar_alt: str | None = None,
    user_login_meta: str | None = None,
    profile_href: str | None = None,
) -> str | None:
    """Apply the shared username extraction policy to Playwright page facts."""
    if avatar_alt and avatar_alt.startswith("@"):
        return avatar_alt[1:]
    if user_login_meta:
        return user_login_meta
    if profile_href and profile_href.startswith("/"):
        return profile_href[1:]
    return None


def extract_username(page: SyncPage) -> str | None:
    """
    Extract the GitHub username from an authenticated page.

    Args:
        page: A Playwright page that is logged into GitHub

    Returns:
        The username or None if it couldn't be extracted
    """
    user_button = page.locator(USER_MENU_SELECTOR)
    if user_button.count() > 0:
        img = user_button.locator("img")
        if img.count() > 0:
            username = _username_from_signals(avatar_alt=img.get_attribute("alt"))
            if username:
                return username

    page.goto(PROFILE_SETTINGS_URL)
    page.wait_for_load_state("domcontentloaded")

    meta = page.locator(USER_LOGIN_META_SELECTOR)
    user_login_meta = meta.get_attribute("content") if meta.count() > 0 else None

    profile_link = page.locator(PROFILE_LINK_SELECTOR)
    profile_href = (
        profile_link.get_attribute("href") if profile_link.count() > 0 else None
    )

    return _username_from_signals(
        user_login_meta=user_login_meta,
        profile_href=profile_href,
    )


async def extract_username_async(page: AsyncPage) -> str | None:
    """
    Extract the GitHub username from an authenticated page.

    Args:
        page: A Playwright page that is logged into GitHub

    Returns:
        The username or None if it couldn't be extracted
    """
    user_button = page.locator(USER_MENU_SELECTOR)
    if await user_button.count() > 0:
        img = user_button.locator("img")
        if await img.count() > 0:
            username = _username_from_signals(avatar_alt=await img.get_attribute("alt"))
            if username:
                return username

    await page.goto(PROFILE_SETTINGS_URL)
    await page.wait_for_load_state("domcontentloaded")

    meta = page.locator(USER_LOGIN_META_SELECTOR)
    user_login_meta = (
        await meta.get_attribute("content") if await meta.count() > 0 else None
    )

    profile_link = page.locator(PROFILE_LINK_SELECTOR)
    profile_href = (
        await profile_link.get_attribute("href")
        if await profile_link.count() > 0
        else None
    )

    return _username_from_signals(
        user_login_meta=user_login_meta,
        profile_href=profile_href,
    )


def is_github_login_page(soup: BeautifulSoup) -> bool:
    """
    Detect if the HTML is a GitHub login page (session expired).

    Checks for telltale signs that GitHub redirected to the login page:
    - Body has 'logged-out' class
    - Route pattern is '/login'
    - User-login meta tag is empty on an authentication page
    """
    body = soup.find("body")
    if body:
        classes = body.get("class")
        if classes is None:
            classes = []
        if isinstance(classes, list) and "logged-out" in classes:
            return True
        if isinstance(classes, str) and "logged-out" in classes:
            return True

    route_meta = soup.find("meta", {"name": "route-pattern"})
    if route_meta:
        content = route_meta.get("content", "")
        if isinstance(content, str) and "/login" in content:
            return True

    user_meta = soup.find("meta", {"name": "user-login"})
    if user_meta:
        content = user_meta.get("content", "")
        if content == "" and soup.select_one(GITHUB_LOGIN_AUTHENTICATION_SELECTOR):
            return True

    return False


def selector_count(counts: dict[str, int], selector: str) -> int:
    """Read a selector count with a zero default."""
    return counts.get(selector, 0)


def first_present_selector(
    counts: dict[str, int],
    selectors: tuple[str, ...],
) -> str | None:
    """Return the first selector with at least one match."""
    for selector in selectors:
        if selector_count(counts, selector) > 0:
            return selector
    return None


def normalize_github_href(href: str) -> str:
    """Build a full GitHub URL from an absolute or root-relative href."""
    if href.startswith("/"):
        return f"https://github.com{href}"
    return href


def compact_text(value: Any) -> str:
    """Normalize optional Playwright text content to a stripped string."""
    return str(value or "").strip()
