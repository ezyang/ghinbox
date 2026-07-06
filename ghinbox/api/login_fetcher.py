"""
Headless GitHub login automation using Playwright.

This module handles the actual browser automation for logging into GitHub,
detecting page states (login form, 2FA, success, error), and submitting credentials.

Uses Playwright's async API to work properly with FastAPI's asyncio event loop.
"""

import asyncio
import logging
from dataclasses import replace
from typing import Any

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

from ghinbox.api.login_page_state import (
    ALTERNATE_ERROR_SELECTORS,
    FLASH_ERROR_SELECTOR,
    MOBILE_VERIFICATION_CODE_SELECTORS,
    PAGE_STATE_SELECTORS,
    SECURITY_KEY_MOBILE_LINK_SELECTOR,
    PageState,
    PageStateFacts,
    PageStateResult,
    classify_page_state,
    extract_mobile_verification_code,
    needs_main_page_flash_recheck,
    security_key_mobile_redirect_url,
)
from ghinbox.auth_common import (
    GITHUB_LOGGED_IN_SELECTORS,
    extract_username_async,
    save_auth_state_async,
    save_username,
)

logger = logging.getLogger(__name__)


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
        """Extract the verification code digits from GitHub Mobile 2FA page."""
        try:
            selector_texts: dict[str, str | None] = {}
            for selector in MOBILE_VERIFICATION_CODE_SELECTORS:
                element = page.locator(selector)
                count = await element.count()
                if count > 0:
                    selector_texts[selector] = await element.first.text_content()
                    code = extract_mobile_verification_code(selector_texts, "")
                    if code:
                        logger.debug(
                            "Found verification code '%s' using selector: %s",
                            code,
                            selector,
                        )
                        return code

            body_text = await page.locator("body").text_content() or ""
            code = extract_mobile_verification_code({}, body_text)
            if code:
                logger.debug("Found potential verification code via regex: %s", code)
                return code

            logger.warning("Could not find verification code on mobile 2FA page")
            return None

        except Exception as e:
            logger.warning("Error extracting verification code: %s", e)
            return None

    async def _selector_counts(
        self,
        page: Page,
        selectors: tuple[str, ...],
    ) -> dict[str, int]:
        """Evaluate selector counts for page-state classification."""
        counts: dict[str, int] = {}
        for selector in selectors:
            counts[selector] = await page.locator(selector).count()
        return counts

    async def _gather_page_state_facts(self, page: Page) -> PageStateFacts:
        """Gather Playwright facts needed by the pure page-state classifier."""
        current_url = page.url
        selector_counts = await self._selector_counts(page, PAGE_STATE_SELECTORS)
        page_content_lower = (await page.content()).lower()

        flash_error_text = None
        if selector_counts.get(FLASH_ERROR_SELECTOR, 0) > 0:
            flash_error = page.locator(FLASH_ERROR_SELECTOR).first
            flash_error_text = await flash_error.text_content()

        alternate_error_texts: dict[str, str] = {}
        for selector in ALTERNATE_ERROR_SELECTORS:
            if selector_counts.get(selector, 0) > 0:
                error_text = await page.locator(selector).first.text_content()
                if error_text is not None:
                    alternate_error_texts[selector] = error_text

        security_key_mobile_href = None
        mobile_link = page.locator(SECURITY_KEY_MOBILE_LINK_SELECTOR)
        if await mobile_link.count() > 0:
            security_key_mobile_href = await mobile_link.first.get_attribute("href")

        mobile_verification_code = None
        if "two-factor/mobile" in current_url:
            mobile_verification_code = await self._extract_mobile_verification_code(
                page
            )

        return PageStateFacts(
            current_url=current_url,
            selector_counts=selector_counts,
            page_content_lower=page_content_lower,
            flash_error_text=flash_error_text,
            alternate_error_texts=alternate_error_texts,
            mobile_verification_code=mobile_verification_code,
            security_key_mobile_href=security_key_mobile_href,
        )

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
        logger.warning("Detecting page state, current URL: %s", page.url)

        try:
            facts = await self._gather_page_state_facts(page)

            mobile_redirect_url = security_key_mobile_redirect_url(facts)
            if mobile_redirect_url:
                logger.warning(
                    "On security key page, navigating to mobile 2FA: %s",
                    mobile_redirect_url,
                )
                await page.goto(mobile_redirect_url, wait_until="domcontentloaded")
                await asyncio.sleep(0.5)
                return await self.detect_page_state()

            if needs_main_page_flash_recheck(facts):
                logger.warning(
                    "Flash error on main page, waiting for page to stabilize..."
                )
                await asyncio.sleep(1.5)
                post_wait_counts = await self._selector_counts(
                    page,
                    GITHUB_LOGGED_IN_SELECTORS,
                )
                facts = replace(
                    facts,
                    post_wait_selector_counts=post_wait_counts,
                )

            result = classify_page_state(facts)

            if result.state == PageState.TWOFA_MOBILE and result.verification_code:
                logger.warning("Mobile verification code: %s", result.verification_code)
            elif result.state == PageState.TWOFA_SECURITY_KEY:
                logger.warning("Detected TWOFA_SECURITY_KEY (not supported)")
                if (
                    "two-factor/webauthn" in facts.current_url
                    or "two-factor/security" in facts.current_url
                ):
                    await self.save_debug_screenshot("security_key_2fa")
            elif result.state == PageState.LOGIN_ERROR:
                if facts.flash_error_text and facts.flash_error_text.strip():
                    error_html = await page.locator(
                        FLASH_ERROR_SELECTOR
                    ).first.inner_html()
                    logger.warning("Flash error HTML: %s", error_html)
                    logger.warning("Flash error text: '%s'", facts.flash_error_text)
                    await self.save_debug_screenshot("login_error")
                logger.warning("Detected LOGIN_ERROR: %s", result.error_message)
            elif result.state == PageState.UNKNOWN:
                logger.warning(
                    "UNKNOWN page state. URL: %s, Title: %s",
                    page.url,
                    await page.title(),
                )
                body_text = await page.locator("body").text_content()
                if body_text:
                    logger.debug(
                        "Page body text (first 500 chars): %s", body_text[:500]
                    )
                await self.save_debug_screenshot("unknown_state")

            return result

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
            auth_path = await save_auth_state_async(self._context, account)
            logger.info("Saving storage state to: %s", auth_path)

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
