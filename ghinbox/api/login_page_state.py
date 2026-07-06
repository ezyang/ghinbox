"""
Pure classification for GitHub login page states.

Browser code gathers selector counts and text into PageStateFacts; this module
decides what those facts mean without touching Playwright.
"""

import re
from dataclasses import dataclass, field
from enum import Enum
from collections.abc import Mapping

from ghinbox.auth_common import (
    GITHUB_LOGGED_IN_SELECTORS,
    first_present_selector,
    normalize_github_href,
    selector_count,
)


class PageState(Enum):
    """Detected state of the current page."""

    LOGIN_FORM = "login_form"  # On the login page with username/password form
    TWOFA_APP = "twofa_app"  # 2FA page for authenticator app
    TWOFA_SMS = "twofa_sms"  # 2FA page for SMS code
    TWOFA_MOBILE = "twofa_mobile"  # 2FA page for GitHub mobile app approval
    TWOFA_SECURITY_KEY = "twofa_security_key"  # 2FA page for security key
    LOGGED_IN = "logged_in"  # Successfully logged in
    LOGIN_ERROR = "login_error"  # Login failed (wrong credentials)
    CAPTCHA = "captcha"  # CAPTCHA challenge detected
    UNKNOWN = "unknown"  # Unable to determine page state


@dataclass(frozen=True)
class PageStateResult:
    """Result of detecting page state."""

    state: PageState
    error_message: str | None = None
    twofa_method: str | None = None  # 'app', 'sms', or 'mobile'
    verification_code: str | None = None  # Digits to confirm on mobile device


CAPTCHA_SELECTORS: tuple[str, ...] = (
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    'div[class*="captcha"]',
    "#captcha-container",
)
CAPTCHA_ERROR_MESSAGE = "CAPTCHA required. Use --headed-login flag to login manually."

MOBILE_2FA_SELECTORS: tuple[str, ...] = (
    "[data-target='sudo-credential-options.mobileOption']",
    "button[data-action*='mobile']",
    ".js-mobile-credential-option",
)
SECURITY_KEY_MOBILE_LINK_SELECTOR = "a[href*='two-factor/mobile']"
SECURITY_KEY_BUTTON_SELECTOR = 'button[data-action="click:webauthn-get#start"]'
SECURITY_KEY_ERROR_MESSAGE = (
    "Security key 2FA not supported. Please configure authenticator app in GitHub "
    "settings."
)

APP_OTP_INPUT_SELECTOR = 'input[name="app_otp"], input[id="app_totp"]'
SMS_OTP_INPUT_SELECTOR = 'input[name="sms_otp"]'
GENERIC_OTP_INPUT_SELECTOR = 'input[type="text"][autocomplete="one-time-code"]'

FLASH_ERROR_SELECTOR = ".flash-error"
ALTERNATE_ERROR_SELECTORS: tuple[str, ...] = (
    ".js-flash-alert",
    "#js-flash-container .flash",
)

LOGIN_INPUT_SELECTOR = 'input[name="login"], input#login_field'
PASSWORD_INPUT_SELECTOR = 'input[name="password"], input#password'

MOBILE_VERIFICATION_CODE_SELECTORS: tuple[str, ...] = (
    ".js-verification-code",
    "[data-target='device-verification.number']",
    ".verification-code",
    ".auth-form-body strong",
    ".Box-body strong",
    "div.text-center strong",
    ".flash strong",
)
MOBILE_VERIFICATION_CODE_RE = re.compile(r"\b(\d{2})\b")

PAGE_STATE_SELECTORS: tuple[str, ...] = (
    *GITHUB_LOGGED_IN_SELECTORS,
    *CAPTCHA_SELECTORS,
    *MOBILE_2FA_SELECTORS,
    SECURITY_KEY_BUTTON_SELECTOR,
    APP_OTP_INPUT_SELECTOR,
    SMS_OTP_INPUT_SELECTOR,
    GENERIC_OTP_INPUT_SELECTOR,
    FLASH_ERROR_SELECTOR,
    *ALTERNATE_ERROR_SELECTORS,
    LOGIN_INPUT_SELECTOR,
    PASSWORD_INPUT_SELECTOR,
)


@dataclass(frozen=True)
class PageStateFacts:
    """Already-evaluated page facts used to classify GitHub login state."""

    current_url: str
    selector_counts: dict[str, int] = field(default_factory=dict)
    page_content_lower: str = ""
    flash_error_text: str | None = None
    flash_error_html: str | None = None
    alternate_error_texts: dict[str, str] = field(default_factory=dict)
    mobile_verification_code: str | None = None
    security_key_mobile_href: str | None = None
    post_wait_selector_counts: dict[str, int] = field(default_factory=dict)
    title: str | None = None
    body_text: str | None = None


def extract_mobile_verification_code(
    selector_texts: Mapping[str, str | None],
    body_text: str,
) -> str | None:
    """
    Extract GitHub Mobile verification digits from already-read page text.

    GitHub shows a 2-digit code that the user needs to match on their phone.
    """
    for selector in MOBILE_VERIFICATION_CODE_SELECTORS:
        text = selector_texts.get(selector)
        if text:
            digits = "".join(c for c in text if c.isdigit())
            if len(digits) >= 2:
                return digits

    matches = MOBILE_VERIFICATION_CODE_RE.findall(body_text)
    if matches:
        return matches[0]

    return None


def security_key_mobile_redirect_url(facts: PageStateFacts) -> str | None:
    """Return the mobile 2FA URL to try from a security-key page, if present."""
    if not _is_security_key_url(facts.current_url):
        return None
    if not facts.security_key_mobile_href:
        return None
    return normalize_github_href(facts.security_key_mobile_href)


def needs_main_page_flash_recheck(facts: PageStateFacts) -> bool:
    """Return true when a main-page flash error needs a logged-in recheck."""
    return bool(_strip(facts.flash_error_text)) and _is_main_github_page(
        facts.current_url
    )


def classify_page_state(facts: PageStateFacts) -> PageStateResult:
    """Classify GitHub login state from already-gathered page facts."""
    if first_present_selector(facts.selector_counts, GITHUB_LOGGED_IN_SELECTORS):
        return PageStateResult(state=PageState.LOGGED_IN)

    if first_present_selector(facts.selector_counts, CAPTCHA_SELECTORS):
        return PageStateResult(
            state=PageState.CAPTCHA,
            error_message=CAPTCHA_ERROR_MESSAGE,
        )

    if "two-factor/mobile" in facts.current_url:
        return PageStateResult(
            state=PageState.TWOFA_MOBILE,
            twofa_method="mobile",
            verification_code=facts.mobile_verification_code,
        )

    if first_present_selector(facts.selector_counts, MOBILE_2FA_SELECTORS):
        return PageStateResult(
            state=PageState.TWOFA_MOBILE,
            twofa_method="mobile",
        )

    if _is_security_key_url(facts.current_url):
        return PageStateResult(
            state=PageState.TWOFA_SECURITY_KEY,
            error_message=SECURITY_KEY_ERROR_MESSAGE,
            twofa_method="security_key",
        )

    if selector_count(facts.selector_counts, SECURITY_KEY_BUTTON_SELECTOR) > 0:
        return PageStateResult(
            state=PageState.TWOFA_SECURITY_KEY,
            error_message=SECURITY_KEY_ERROR_MESSAGE,
            twofa_method="security_key",
        )

    if selector_count(facts.selector_counts, APP_OTP_INPUT_SELECTOR) > 0:
        return PageStateResult(
            state=PageState.TWOFA_APP,
            twofa_method="app",
        )

    if _has_2fa_text(facts.page_content_lower):
        if selector_count(facts.selector_counts, SMS_OTP_INPUT_SELECTOR) > 0:
            return PageStateResult(
                state=PageState.TWOFA_SMS,
                twofa_method="sms",
            )

        if selector_count(facts.selector_counts, GENERIC_OTP_INPUT_SELECTOR) > 0:
            return PageStateResult(
                state=PageState.TWOFA_APP,
                twofa_method="app",
            )

    flash_error = _strip(facts.flash_error_text)
    if flash_error:
        if _is_main_github_page(facts.current_url) and first_present_selector(
            facts.post_wait_selector_counts,
            GITHUB_LOGGED_IN_SELECTORS,
        ):
            return PageStateResult(state=PageState.LOGGED_IN)

        return PageStateResult(
            state=PageState.LOGIN_ERROR,
            error_message=flash_error,
        )

    for selector in ALTERNATE_ERROR_SELECTORS:
        error_text = _strip(facts.alternate_error_texts.get(selector))
        if error_text:
            return PageStateResult(
                state=PageState.LOGIN_ERROR,
                error_message=error_text,
            )

    if (
        selector_count(facts.selector_counts, LOGIN_INPUT_SELECTOR) > 0
        and selector_count(facts.selector_counts, PASSWORD_INPUT_SELECTOR) > 0
    ):
        return PageStateResult(state=PageState.LOGIN_FORM)

    return PageStateResult(state=PageState.UNKNOWN)


def _is_security_key_url(url: str) -> bool:
    return "two-factor/webauthn" in url or "two-factor/security" in url


def _is_main_github_page(url: str) -> bool:
    return url.rstrip("/") == "https://github.com" or url.startswith(
        "https://github.com/?"
    )


def _has_2fa_text(page_content_lower: str) -> bool:
    return "two-factor" in page_content_lower or "authentication code" in (
        page_content_lower
    )


def _strip(text: str | None) -> str:
    return (text or "").strip()
