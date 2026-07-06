import pytest

from ghinbox.api.login_page_state import (
    ALTERNATE_ERROR_SELECTORS,
    APP_OTP_INPUT_SELECTOR,
    CAPTCHA_ERROR_MESSAGE,
    CAPTCHA_SELECTORS,
    GENERIC_OTP_INPUT_SELECTOR,
    LOGIN_INPUT_SELECTOR,
    MOBILE_2FA_SELECTORS,
    MOBILE_VERIFICATION_CODE_SELECTORS,
    PASSWORD_INPUT_SELECTOR,
    SECURITY_KEY_BUTTON_SELECTOR,
    SECURITY_KEY_ERROR_MESSAGE,
    SMS_OTP_INPUT_SELECTOR,
    PageState,
    PageStateFacts,
    PageStateResult,
    classify_page_state,
    extract_mobile_verification_code,
    needs_main_page_flash_recheck,
    security_key_mobile_redirect_url,
)
from ghinbox.auth_common import GITHUB_LOGGED_IN_SELECTORS


def _facts(
    *,
    current_url: str = "https://github.com/login",
    selector_counts: dict[str, int] | None = None,
    page_content_lower: str = "",
    flash_error_text: str | None = None,
    alternate_error_texts: dict[str, str] | None = None,
    mobile_verification_code: str | None = None,
    security_key_mobile_href: str | None = None,
    post_wait_selector_counts: dict[str, int] | None = None,
) -> PageStateFacts:
    return PageStateFacts(
        current_url=current_url,
        selector_counts=selector_counts or {},
        page_content_lower=page_content_lower,
        flash_error_text=flash_error_text,
        alternate_error_texts=alternate_error_texts or {},
        mobile_verification_code=mobile_verification_code,
        security_key_mobile_href=security_key_mobile_href,
        post_wait_selector_counts=post_wait_selector_counts or {},
    )


@pytest.mark.parametrize(
    ("name", "facts", "expected"),
    [
        (
            "logged in",
            _facts(selector_counts={GITHUB_LOGGED_IN_SELECTORS[0]: 1}),
            PageStateResult(state=PageState.LOGGED_IN),
        ),
        (
            "captcha",
            _facts(selector_counts={CAPTCHA_SELECTORS[0]: 1}),
            PageStateResult(
                state=PageState.CAPTCHA,
                error_message=CAPTCHA_ERROR_MESSAGE,
            ),
        ),
        (
            "mobile 2fa url",
            _facts(
                current_url="https://github.com/sessions/two-factor/mobile",
                mobile_verification_code="42",
            ),
            PageStateResult(
                state=PageState.TWOFA_MOBILE,
                twofa_method="mobile",
                verification_code="42",
            ),
        ),
        (
            "mobile 2fa selector",
            _facts(selector_counts={MOBILE_2FA_SELECTORS[0]: 1}),
            PageStateResult(
                state=PageState.TWOFA_MOBILE,
                twofa_method="mobile",
            ),
        ),
        (
            "security key url",
            _facts(current_url="https://github.com/sessions/two-factor/webauthn"),
            PageStateResult(
                state=PageState.TWOFA_SECURITY_KEY,
                error_message=SECURITY_KEY_ERROR_MESSAGE,
                twofa_method="security_key",
            ),
        ),
        (
            "security key button",
            _facts(selector_counts={SECURITY_KEY_BUTTON_SELECTOR: 1}),
            PageStateResult(
                state=PageState.TWOFA_SECURITY_KEY,
                error_message=SECURITY_KEY_ERROR_MESSAGE,
                twofa_method="security_key",
            ),
        ),
        (
            "app 2fa input",
            _facts(selector_counts={APP_OTP_INPUT_SELECTOR: 1}),
            PageStateResult(
                state=PageState.TWOFA_APP,
                twofa_method="app",
            ),
        ),
        (
            "sms 2fa",
            _facts(
                page_content_lower="two-factor authentication",
                selector_counts={SMS_OTP_INPUT_SELECTOR: 1},
            ),
            PageStateResult(
                state=PageState.TWOFA_SMS,
                twofa_method="sms",
            ),
        ),
        (
            "generic app 2fa",
            _facts(
                page_content_lower="enter your authentication code",
                selector_counts={GENERIC_OTP_INPUT_SELECTOR: 1},
            ),
            PageStateResult(
                state=PageState.TWOFA_APP,
                twofa_method="app",
            ),
        ),
        (
            "flash error",
            _facts(flash_error_text=" Incorrect username or password. "),
            PageStateResult(
                state=PageState.LOGIN_ERROR,
                error_message="Incorrect username or password.",
            ),
        ),
        (
            "main page flash error stabilizes logged in",
            _facts(
                current_url="https://github.com",
                flash_error_text=" Signed in ",
                post_wait_selector_counts={GITHUB_LOGGED_IN_SELECTORS[1]: 1},
            ),
            PageStateResult(state=PageState.LOGGED_IN),
        ),
        (
            "alternate flash error",
            _facts(
                alternate_error_texts={
                    ALTERNATE_ERROR_SELECTORS[0]: " Session expired. "
                },
            ),
            PageStateResult(
                state=PageState.LOGIN_ERROR,
                error_message="Session expired.",
            ),
        ),
        (
            "login form",
            _facts(
                selector_counts={
                    LOGIN_INPUT_SELECTOR: 1,
                    PASSWORD_INPUT_SELECTOR: 1,
                },
            ),
            PageStateResult(state=PageState.LOGIN_FORM),
        ),
        (
            "unknown",
            _facts(),
            PageStateResult(state=PageState.UNKNOWN),
        ),
    ],
)
def test_classify_page_state_branches(
    name: str,
    facts: PageStateFacts,
    expected: PageStateResult,
) -> None:
    assert classify_page_state(facts) == expected, name


def test_security_key_mobile_redirect_url_normalizes_relative_href() -> None:
    facts = _facts(
        current_url="https://github.com/sessions/two-factor/security",
        security_key_mobile_href="/sessions/two-factor/mobile",
    )

    assert (
        security_key_mobile_redirect_url(facts)
        == "https://github.com/sessions/two-factor/mobile"
    )


def test_security_key_mobile_redirect_url_ignores_non_security_pages() -> None:
    facts = _facts(
        current_url="https://github.com/login",
        security_key_mobile_href="/sessions/two-factor/mobile",
    )

    assert security_key_mobile_redirect_url(facts) is None


def test_needs_main_page_flash_recheck_only_for_main_github_page() -> None:
    assert needs_main_page_flash_recheck(
        _facts(current_url="https://github.com", flash_error_text="Loading")
    )
    assert not needs_main_page_flash_recheck(
        _facts(current_url="https://github.com/login", flash_error_text="Bad password")
    )


@pytest.mark.parametrize(
    ("selector_texts", "body_text", "expected"),
    [
        (
            {MOBILE_VERIFICATION_CODE_SELECTORS[0]: "Use code 42"},
            "",
            "42",
        ),
        (
            {},
            "Approve the sign-in request showing 17 on your phone.",
            "17",
        ),
        (
            {MOBILE_VERIFICATION_CODE_SELECTORS[0]: "No digits here"},
            "No standalone number",
            None,
        ),
    ],
)
def test_extract_mobile_verification_code(
    selector_texts: dict[str, str],
    body_text: str,
    expected: str | None,
) -> None:
    assert extract_mobile_verification_code(selector_texts, body_text) == expected
