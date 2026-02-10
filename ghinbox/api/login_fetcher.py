"""
Headless GitHub login automation using Playwright.

This module handles the actual browser automation for logging into GitHub,
detecting page states (login form, 2FA, success, error), and submitting credentials.

Uses Playwright's async API to work properly with FastAPI's asyncio event loop.
"""

import asyncio
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

from ghinbox.auth import (
    AUTH_STATE_DIR,
    get_auth_state_path,
    save_username,
)

logger = logging.getLogger(__name__)


class PageState(Enum):
    """Detected state of the current page."""

    LOGIN_FORM = "login_form"  # On the login page with username/password form
    TWOFA_APP = "twofa_app"  # 2FA page for authenticator app
    TWOFA_SMS = "twofa_sms"  # 2FA page for SMS code
    TWOFA_MOBILE = "twofa_mobile"  # 2FA page for GitHub mobile app approval
    TWOFA_SECURITY_KEY = "twofa_security_key"  # 2FA page for security key (unsupported)
    LOGGED_IN = "logged_in"  # Successfully logged in
    LOGIN_ERROR = "login_error"  # Login failed (wrong credentials)
    CAPTCHA = "captcha"  # CAPTCHA challenge detected
    UNKNOWN = "unknown"  # Unable to determine page state


@dataclass
class PageStateResult:
    """Result of detecting page state."""

    state: PageState
    error_message: str | None = None
    twofa_method: str | None = None  # 'app', 'sms', or 'mobile'
    verification_code: str | None = None  # Digits to confirm on mobile device


async def extract_username_async(page: Page) -> str | None:
    """
    Extract the GitHub username from an authenticated page (async version).

    Args:
        page: A Playwright page that is logged into GitHub

    Returns:
        The username or None if it couldn't be extracted
    """
    # Method 1: Look for the username in the user menu button
    user_button = page.locator('button[aria-label="Open user navigation menu"]')
    if await user_button.count() > 0:
        # The username is often in the image alt or nearby elements
        img = user_button.locator("img")
        if await img.count() > 0:
            alt = await img.get_attribute("alt")
            if alt and alt.startswith("@"):
                return alt[1:]  # Remove the @ prefix

    # Method 2: Navigate to profile and extract from URL
    await page.goto("https://github.com/settings/profile")
    await page.wait_for_load_state("domcontentloaded")

    # Method 3: Get it from the meta tag or page content
    # GitHub has a meta tag with the user login
    meta = page.locator('meta[name="user-login"]')
    if await meta.count() > 0:
        content = await meta.get_attribute("content")
        if content:
            return content

    # Method 4: Parse from the profile URL link
    profile_link = page.locator('a[href^="/"]:has-text("Your profile")')
    if await profile_link.count() > 0:
        href = await profile_link.get_attribute("href")
        if href and href.startswith("/"):
            return href[1:]  # Remove the leading /

    return None


class LoginFetcher:
    """
    Handles headless GitHub login using Playwright (async version).

    This class manages a browser session for logging into GitHub,
    handling credentials submission and 2FA verification.
    """

    def __init__(self):
        """Initialize the login fetcher."""
        self._playwright: Any = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    async def start(self) -> None:
        """Start the browser and navigate to GitHub login."""
        if self._playwright is not None:
            logger.debug("Browser already started, skipping")
            return

        logger.info("Starting headless browser for GitHub login")
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=True)
        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 800},
        )
        self._page = await self._context.new_page()
        logger.info("Navigating to https://github.com/login")
        await self._page.goto("https://github.com/login", wait_until="domcontentloaded")
        logger.info("GitHub login page loaded, current URL: %s", self._page.url)

    async def close(self) -> None:
        """Close the browser and clean up."""
        if self._page:
            try:
                await self._page.close()
            except Exception:
                pass
            self._page = None
        if self._context:
            try:
                await self._context.close()
            except Exception:
                pass
            self._context = None
        if self._browser:
            try:
                await self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception:
                pass
            self._playwright = None

    async def save_debug_screenshot(self, name: str = "debug") -> str | None:
        """Save a screenshot for debugging purposes.

        Args:
            name: Name prefix for the screenshot file

        Returns:
            Path to the saved screenshot, or None if failed
        """
        if self._page is None:
            return None
        try:
            import os
            import tempfile

            screenshot_dir = tempfile.gettempdir()
            screenshot_path = os.path.join(screenshot_dir, f"ghinbox_login_{name}.png")
            await self._page.screenshot(path=screenshot_path)
            logger.warning("Saved debug screenshot to: %s", screenshot_path)
            return screenshot_path
        except Exception as e:
            logger.warning("Failed to save debug screenshot: %s", e)
            return None

    async def _extract_mobile_verification_code(self, page: Page) -> str | None:
        """Extract the verification code digits from GitHub Mobile 2FA page.

        GitHub shows a 2-digit code that the user needs to match on their phone.

        Returns:
            The verification code string, or None if not found
        """
        try:
            # GitHub shows the verification digits in various ways
            # Try common selectors for the verification code
            code_selectors = [
                ".js-verification-code",
                "[data-target='device-verification.number']",
                ".verification-code",
                ".auth-form-body strong",
                ".Box-body strong",
                # Try finding large numbers that look like verification codes
                "div.text-center strong",
                ".flash strong",
            ]

            for selector in code_selectors:
                element = page.locator(selector)
                count = await element.count()
                if count > 0:
                    text = await element.first.text_content()
                    if text:
                        # Extract just the digits
                        digits = "".join(c for c in text if c.isdigit())
                        if len(digits) >= 2:
                            logger.debug(
                                "Found verification code '%s' using selector: %s",
                                digits,
                                selector,
                            )
                            return digits

            # Fallback: try to find any prominent number on the page
            # Look for text containing just digits (2-3 digits typical)
            body_text = await page.locator("body").text_content() or ""
            import re

            # Find standalone 2-digit numbers (typical for GitHub Mobile)
            matches = re.findall(r"\b(\d{2})\b", body_text)
            if matches:
                # Return the first match (most likely the verification code)
                logger.debug(
                    "Found potential verification code via regex: %s", matches[0]
                )
                return matches[0]

            logger.warning("Could not find verification code on mobile 2FA page")
            return None

        except Exception as e:
            logger.warning("Error extracting verification code: %s", e)
            return None

    async def detect_page_state(self) -> PageStateResult:
        """
        Detect the current page state.

        Returns:
            PageStateResult with the detected state and any error message
        """
        if self._page is None:
            logger.warning("detect_page_state called but page is None")
            return PageStateResult(state=PageState.UNKNOWN)

        page = self._page
        current_url = page.url
        logger.warning("Detecting page state, current URL: %s", current_url)

        try:
            # Check if logged in using multiple indicators
            logged_in_selectors = [
                'button[aria-label="Open user navigation menu"]',
                "img.avatar.circle",  # User avatar in header
                'meta[name="user-login"][content]:not([content=""])',  # Meta tag with username
                'a[href*="/settings/profile"]',  # Settings link only visible when logged in
            ]
            for selector in logged_in_selectors:
                count = await page.locator(selector).count()
                if count > 0:
                    logger.info("Detected LOGGED_IN state (selector: %s)", selector)
                    return PageStateResult(state=PageState.LOGGED_IN)

            # Check for CAPTCHA
            captcha_indicators = [
                'iframe[src*="captcha"]',
                'iframe[src*="recaptcha"]',
                'div[class*="captcha"]',
                "#captcha-container",
            ]
            for selector in captcha_indicators:
                count = await page.locator(selector).count()
                if count > 0:
                    logger.warning("Detected CAPTCHA (selector: %s)", selector)
                    return PageStateResult(
                        state=PageState.CAPTCHA,
                        error_message="CAPTCHA required. Use --headed-login flag to login manually.",
                    )

            # Check for 2FA pages BEFORE checking for flash-error
            # (2FA pages may have empty flash-error elements)

            # GitHub Mobile 2FA - check by URL or page elements
            if "two-factor/mobile" in current_url:
                logger.warning("Detected TWOFA_MOBILE via URL")
                # Extract the verification code (digits to confirm on device)
                verification_code = await self._extract_mobile_verification_code(page)
                if verification_code:
                    logger.warning("Mobile verification code: %s", verification_code)
                return PageStateResult(
                    state=PageState.TWOFA_MOBILE,
                    twofa_method="mobile",
                    verification_code=verification_code,
                )

            # Also check for mobile 2FA by looking for specific elements
            # GitHub mobile auth page typically has "Check your device" or similar text
            mobile_indicators = [
                "[data-target='sudo-credential-options.mobileOption']",
                "button[data-action*='mobile']",
                ".js-mobile-credential-option",
            ]
            for selector in mobile_indicators:
                count = await page.locator(selector).count()
                if count > 0:
                    logger.warning(
                        "Detected TWOFA_MOBILE via element selector: %s", selector
                    )
                    return PageStateResult(
                        state=PageState.TWOFA_MOBILE,
                        twofa_method="mobile",
                    )

            # Security key page (WebAuthn) - check by URL first
            # But also check if there's a mobile option we can switch to
            if (
                "two-factor/webauthn" in current_url
                or "two-factor/security" in current_url
            ):
                # Check if there's a link to use mobile instead
                mobile_link = page.locator("a[href*='two-factor/mobile']")
                mobile_link_count = await mobile_link.count()
                if mobile_link_count > 0:
                    # Get the href and navigate directly (more reliable than clicking)
                    href = await mobile_link.first.get_attribute("href")
                    if href:
                        # Build full URL if it's relative
                        if href.startswith("/"):
                            href = f"https://github.com{href}"
                        logger.warning(
                            "On security key page, navigating to mobile 2FA: %s", href
                        )
                        await page.goto(href, wait_until="domcontentloaded")
                        await asyncio.sleep(0.5)
                        # Re-detect the page state
                        return await self.detect_page_state()

                logger.warning("Detected TWOFA_SECURITY_KEY via URL (not supported)")
                await self.save_debug_screenshot("security_key_2fa")
                return PageStateResult(
                    state=PageState.TWOFA_SECURITY_KEY,
                    error_message="Security key 2FA not supported. Please configure authenticator app in GitHub settings.",
                    twofa_method="security_key",
                )

            # Also check by button selector
            security_key_btn = page.locator(
                'button[data-action="click:webauthn-get#start"]'
            )
            security_key_count = await security_key_btn.count()
            logger.debug("Security key button count: %d", security_key_count)
            if security_key_count > 0:
                logger.warning("Detected TWOFA_SECURITY_KEY via button (not supported)")
                return PageStateResult(
                    state=PageState.TWOFA_SECURITY_KEY,
                    error_message="Security key 2FA not supported. Please configure authenticator app in GitHub settings.",
                    twofa_method="security_key",
                )

            # Check for authenticator app 2FA
            # Look for OTP input or TOTP-related elements
            otp_input = page.locator('input[name="app_otp"], input[id="app_totp"]')
            otp_input_count = await otp_input.count()
            logger.debug("OTP input (app_otp/app_totp) count: %d", otp_input_count)
            if otp_input_count > 0:
                logger.info("Detected TWOFA_APP state")
                return PageStateResult(
                    state=PageState.TWOFA_APP,
                    twofa_method="app",
                )

            # Alternative 2FA detection via page content
            page_text = (await page.content()).lower()
            has_2fa_text = (
                "two-factor" in page_text or "authentication code" in page_text
            )
            logger.debug("Page contains 2FA text: %s", has_2fa_text)
            if has_2fa_text:
                # Check for SMS option
                sms_input = page.locator('input[name="sms_otp"]')
                sms_count = await sms_input.count()
                logger.debug("SMS OTP input count: %d", sms_count)
                if sms_count > 0:
                    logger.info("Detected TWOFA_SMS state")
                    return PageStateResult(
                        state=PageState.TWOFA_SMS,
                        twofa_method="sms",
                    )

                # Generic 2FA input
                otp_inputs = page.locator(
                    'input[type="text"][autocomplete="one-time-code"]'
                )
                generic_otp_count = await otp_inputs.count()
                logger.debug("Generic OTP input count: %d", generic_otp_count)
                if generic_otp_count > 0:
                    logger.info("Detected TWOFA_APP state (via generic OTP input)")
                    return PageStateResult(
                        state=PageState.TWOFA_APP,
                        twofa_method="app",
                    )

            # Check for login error (flash error message)
            # Only treat as error if there's actual error text
            flash_error = page.locator(".flash-error")
            flash_error_count = await flash_error.count()
            logger.debug("Flash error count: %d", flash_error_count)
            if flash_error_count > 0:
                error_text = await flash_error.first.text_content()
                error_msg = (error_text or "").strip()
                # Only treat as error if there's actual text content
                if error_msg:
                    # If we're on the main GitHub page (not login/2FA), the page might
                    # still be loading after redirect. Wait and re-check for user menu.
                    is_main_page = current_url.rstrip(
                        "/"
                    ) == "https://github.com" or current_url.startswith(
                        "https://github.com/?"
                    )
                    if is_main_page:
                        logger.warning(
                            "Flash error on main page, waiting for page to stabilize..."
                        )
                        await asyncio.sleep(1.5)
                        # Re-check for logged-in state using multiple indicators
                        for selector in logged_in_selectors:
                            recheck_count = await page.locator(selector).count()
                            if recheck_count > 0:
                                logger.info(
                                    "Logged in after wait (selector: %s) - ignoring flash error",
                                    selector,
                                )
                                return PageStateResult(state=PageState.LOGGED_IN)

                    error_html = await flash_error.first.inner_html()
                    logger.warning("Flash error HTML: %s", error_html)
                    logger.warning("Flash error text: '%s'", error_text)
                    await self.save_debug_screenshot("login_error")
                    logger.warning("Detected LOGIN_ERROR: %s", error_msg)
                    return PageStateResult(
                        state=PageState.LOGIN_ERROR,
                        error_message=error_msg,
                    )
                else:
                    logger.debug("Flash error element found but empty, ignoring")

            # Also check for other error patterns on GitHub login page
            # Sometimes errors appear in different elements
            error_selectors = [
                ".js-flash-alert",
                "#js-flash-container .flash",
            ]
            for selector in error_selectors:
                error_el = page.locator(selector)
                count = await error_el.count()
                if count > 0:
                    error_text = await error_el.first.text_content()
                    if error_text and error_text.strip():
                        logger.warning(
                            "Detected error via selector '%s': %s",
                            selector,
                            error_text.strip(),
                        )
                        return PageStateResult(
                            state=PageState.LOGIN_ERROR,
                            error_message=error_text.strip(),
                        )

            # Check if on login form
            login_input = page.locator('input[name="login"], input#login_field')
            password_input = page.locator('input[name="password"], input#password')
            login_count = await login_input.count()
            password_count = await password_input.count()
            logger.debug(
                "Login form inputs - login: %d, password: %d",
                login_count,
                password_count,
            )
            if login_count > 0 and password_count > 0:
                logger.info("Detected LOGIN_FORM state")
                return PageStateResult(state=PageState.LOGIN_FORM)

            # Unknown state - log page content for debugging
            logger.warning(
                "UNKNOWN page state. URL: %s, Title: %s",
                page.url,
                await page.title(),
            )
            # Log a snippet of the page content for debugging
            body_text = await page.locator("body").text_content()
            if body_text:
                logger.debug("Page body text (first 500 chars): %s", body_text[:500])
            await self.save_debug_screenshot("unknown_state")
            return PageStateResult(state=PageState.UNKNOWN)

        except Exception as e:
            logger.exception("Error detecting page state: %s", e)
            return PageStateResult(
                state=PageState.UNKNOWN,
                error_message=f"Error detecting page state: {e}",
            )

    async def submit_credentials(self, username: str, password: str) -> PageStateResult:
        """
        Submit username and password on the login form.

        Args:
            username: GitHub username or email
            password: GitHub password

        Returns:
            PageStateResult with the resulting state after submission
        """
        logger.info("Submitting credentials for user: %s", username)
        if self._page is None:
            logger.error("Browser not started, cannot submit credentials")
            return PageStateResult(
                state=PageState.UNKNOWN,
                error_message="Browser not started",
            )

        page = self._page
        logger.debug("Current URL before credential submission: %s", page.url)

        try:
            # Wait for and fill login form
            logger.debug("Waiting for login input field...")
            await page.wait_for_selector(
                'input[name="login"], input#login_field', timeout=10000
            )

            login_input = page.locator('input[name="login"], input#login_field').first
            password_input = page.locator(
                'input[name="password"], input#password'
            ).first

            logger.debug("Filling username field")
            await login_input.fill(username)
            logger.debug("Filling password field")
            await password_input.fill(password)

            # Submit the form
            submit_button = page.locator(
                'input[type="submit"][value="Sign in"], button[type="submit"]'
            ).first
            logger.debug("Clicking submit button")
            await submit_button.click()

            # Wait for navigation or error
            logger.debug("Waiting for page load after submission...")
            await page.wait_for_load_state("domcontentloaded", timeout=30000)
            logger.debug("Page loaded, URL after submission: %s", page.url)

            # Give the page a moment to settle
            await asyncio.sleep(0.5)

            # Detect the resulting state
            logger.debug("Detecting resulting page state...")
            result = await self.detect_page_state()
            logger.info(
                "Credential submission result: state=%s, error=%s",
                result.state.value,
                result.error_message,
            )
            return result

        except Exception as e:
            logger.exception("Error submitting credentials: %s", e)
            return PageStateResult(
                state=PageState.UNKNOWN,
                error_message=f"Error submitting credentials: {e}",
            )

    async def submit_2fa_code(self, code: str) -> PageStateResult:
        """
        Submit a 2FA code (authenticator app or SMS).

        Args:
            code: The 6-8 digit 2FA code

        Returns:
            PageStateResult with the resulting state after submission
        """
        logger.info("Submitting 2FA code (length: %d)", len(code))
        if self._page is None:
            logger.error("Browser not started, cannot submit 2FA code")
            return PageStateResult(
                state=PageState.UNKNOWN,
                error_message="Browser not started",
            )

        page = self._page
        logger.debug("Current URL before 2FA submission: %s", page.url)

        try:
            # Find the OTP input field
            otp_selectors = [
                'input[name="app_otp"]',
                'input[id="app_totp"]',
                'input[name="sms_otp"]',
                'input[type="text"][autocomplete="one-time-code"]',
            ]

            otp_input = None
            found_selector = None
            for selector in otp_selectors:
                locator = page.locator(selector)
                count = await locator.count()
                logger.debug("OTP selector '%s' count: %d", selector, count)
                if count > 0:
                    otp_input = locator.first
                    found_selector = selector
                    break

            if otp_input is None:
                logger.error("Could not find any 2FA input field")
                return PageStateResult(
                    state=PageState.UNKNOWN,
                    error_message="Could not find 2FA input field",
                )

            logger.debug("Found 2FA input using selector: %s", found_selector)

            # Fill and submit
            await otp_input.fill(code)
            logger.debug("Filled 2FA code")

            # Look for verify/submit button
            submit_button = page.locator(
                'button[type="submit"], input[type="submit"]'
            ).first
            logger.debug("Clicking 2FA submit button")
            await submit_button.click()

            # Wait for navigation
            logger.debug("Waiting for page load after 2FA submission...")
            await page.wait_for_load_state("domcontentloaded", timeout=30000)
            logger.debug("Page loaded, URL after 2FA: %s", page.url)

            # Give the page a moment to settle
            await asyncio.sleep(0.5)

            # Detect the resulting state
            result = await self.detect_page_state()
            logger.info(
                "2FA submission result: state=%s, error=%s",
                result.state.value,
                result.error_message,
            )
            return result

        except Exception as e:
            logger.exception("Error submitting 2FA code: %s", e)
            return PageStateResult(
                state=PageState.UNKNOWN,
                error_message=f"Error submitting 2FA code: {e}",
            )

    async def wait_for_mobile_approval(
        self, timeout_seconds: int = 120, poll_interval: float = 2.0
    ) -> PageStateResult:
        """
        Wait for GitHub Mobile 2FA approval.

        Polls the page state until login is successful or timeout.

        Args:
            timeout_seconds: Maximum time to wait for approval (default 2 minutes)
            poll_interval: Time between polls in seconds

        Returns:
            PageStateResult with the final state
        """
        logger.info(
            "Waiting for mobile 2FA approval (timeout: %ds, poll interval: %.1fs)",
            timeout_seconds,
            poll_interval,
        )

        if self._page is None:
            logger.error("Browser not started, cannot wait for mobile approval")
            return PageStateResult(
                state=PageState.UNKNOWN,
                error_message="Browser not started",
            )

        start_time = asyncio.get_event_loop().time()
        poll_count = 0

        while True:
            elapsed = asyncio.get_event_loop().time() - start_time
            if elapsed > timeout_seconds:
                logger.warning(
                    "Mobile 2FA approval timed out after %ds", timeout_seconds
                )
                await self.save_debug_screenshot("mobile_2fa_timeout")
                return PageStateResult(
                    state=PageState.TWOFA_MOBILE,
                    error_message=f"Mobile approval timed out after {timeout_seconds} seconds. Please try again.",
                    twofa_method="mobile",
                )

            poll_count += 1
            logger.debug("Mobile 2FA poll #%d (elapsed: %.1fs)", poll_count, elapsed)

            # Check current page state
            result = await self.detect_page_state()

            if result.state == PageState.LOGGED_IN:
                logger.info("Mobile 2FA approved - now logged in!")
                return result

            if result.state == PageState.LOGIN_ERROR:
                logger.warning("Mobile 2FA failed with error: %s", result.error_message)
                return result

            if result.state not in (PageState.TWOFA_MOBILE, PageState.UNKNOWN):
                # Unexpected state change
                logger.warning(
                    "Unexpected state during mobile 2FA wait: %s", result.state.value
                )
                return result

            # Wait before next poll
            await asyncio.sleep(poll_interval)

    async def save_auth_state(self, account: str) -> tuple[bool, str | None]:
        """
        Save the authentication state and extract username.

        Args:
            account: The account name to save the auth state under

        Returns:
            Tuple of (success, username)
        """
        logger.info("Saving auth state for account: %s", account)
        if self._context is None or self._page is None:
            logger.error("Context or page is None, cannot save auth state")
            return False, None

        try:
            # Ensure we're on a GitHub page with full session
            logger.debug("Navigating to github.com to ensure full session")
            await self._page.goto("https://github.com", wait_until="domcontentloaded")
            await asyncio.sleep(0.5)

            # Extract username
            logger.debug("Extracting username from page")
            username = await extract_username_async(self._page)
            logger.info("Extracted username: %s", username)
            if username:
                save_username(account, username)

            # Save browser storage state
            AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
            auth_path = get_auth_state_path(account)
            logger.info("Saving storage state to: %s", auth_path)
            await self._context.storage_state(path=str(auth_path))

            logger.info("Auth state saved successfully")
            return True, username

        except Exception as e:
            logger.exception("Error saving auth state: %s", e)
            return False, None

    async def __aenter__(self) -> "LoginFetcher":
        await self.start()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
