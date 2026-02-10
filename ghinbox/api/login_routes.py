"""
FastAPI route handlers for GitHub authentication.

Provides endpoints for headless GitHub login flow with web-served forms.
"""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ghinbox.api.login_state import (
    LoginState,
    get_session_manager,
)
from ghinbox.api.login_fetcher import LoginFetcher, PageState

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["authentication"])


# Request/Response Models


class LoginStartRequest(BaseModel):
    """Request to start a new login session."""

    account: str = "default"


class LoginCredentialsRequest(BaseModel):
    """Request to submit credentials."""

    session_id: str
    username: str
    password: str


class Login2FARequest(BaseModel):
    """Request to submit 2FA code."""

    session_id: str
    code: str


class LoginCancelRequest(BaseModel):
    """Request to cancel a login session."""

    session_id: str


class LoginResponse(BaseModel):
    """Response from login endpoints."""

    session_id: str
    status: Literal[
        "initialized",
        "submitting",
        "waiting_2fa",
        "waiting_mobile",
        "success",
        "error",
        "captcha",
    ]
    message: str | None = None
    error: str | None = None
    username: str | None = None
    twofa_method: str | None = None
    verification_code: str | None = None  # Digits to confirm on mobile device


# Endpoints


@router.post(
    "/login/start",
    response_model=LoginResponse,
    summary="Start a login session",
    description="Create a new login session and prepare for credential input.",
)
async def start_login(request: LoginStartRequest) -> LoginResponse:
    """
    Start a new login session.

    Creates a headless browser, navigates to GitHub login,
    and returns a session ID for subsequent requests.
    """
    logger.info("Starting login session for account: %s", request.account)
    manager = get_session_manager()

    # Create the session
    session = manager.create_session(request.account)
    logger.info("Created session: %s", session.session_id)

    try:
        # Start the fetcher (async)
        logger.debug("Creating and starting LoginFetcher")
        fetcher = LoginFetcher()
        await fetcher.start()
        manager.set_fetcher(session.session_id, fetcher)
        logger.info("Login session ready: %s", session.session_id)

        return LoginResponse(
            session_id=session.session_id,
            status="initialized",
            message="Ready for credentials",
        )

    except Exception as e:
        logger.exception("Failed to start login session: %s", e)
        # Clean up session on error
        manager.update_state(
            session.session_id,
            LoginState.ERROR,
            error_message=str(e),
        )
        return LoginResponse(
            session_id=session.session_id,
            status="error",
            error=f"Failed to start login session: {e}",
        )


@router.post(
    "/login/credentials",
    response_model=LoginResponse,
    summary="Submit login credentials",
    description="Submit username and password for GitHub login.",
)
async def submit_credentials(request: LoginCredentialsRequest) -> LoginResponse:
    """
    Submit username and password.

    Returns the resulting state: success, waiting_2fa, or error.
    """
    logger.info(
        "Submitting credentials for session: %s, user: %s",
        request.session_id,
        request.username,
    )
    manager = get_session_manager()
    session = manager.get_session(request.session_id)

    if session is None:
        logger.warning("Session not found: %s", request.session_id)
        raise HTTPException(
            status_code=404,
            detail="Session not found or expired",
        )

    if session.state != LoginState.INITIALIZED:
        logger.warning("Invalid session state for credentials: %s", session.state.value)
        raise HTTPException(
            status_code=400,
            detail=f"Invalid session state for credentials: {session.state.value}",
        )

    fetcher = manager.get_fetcher(request.session_id)
    if fetcher is None:
        logger.error("No fetcher associated with session: %s", request.session_id)
        raise HTTPException(
            status_code=500,
            detail="No fetcher associated with session",
        )

    # Update state to submitting
    manager.update_state(request.session_id, LoginState.SUBMITTING_CREDENTIALS)
    logger.debug("Updated session state to SUBMITTING_CREDENTIALS")

    try:
        # Submit credentials (async)
        logger.debug("Calling fetcher.submit_credentials")
        result = await fetcher.submit_credentials(request.username, request.password)
        logger.info(
            "Credential submission result: state=%s, error=%s, twofa_method=%s",
            result.state.value,
            result.error_message,
            result.twofa_method,
        )

        # Map result to response
        if result.state == PageState.LOGGED_IN:
            # Success! Save auth state
            logger.info("Login successful, saving auth state")
            success, username = await fetcher.save_auth_state(session.account)
            if success:
                manager.update_state(
                    request.session_id,
                    LoginState.SUCCESS,
                    username=username,
                )
                logger.info("Auth state saved, username: %s", username)
                return LoginResponse(
                    session_id=request.session_id,
                    status="success",
                    username=username,
                    message="Login successful",
                )
            else:
                logger.error("Failed to save auth state")
                manager.update_state(
                    request.session_id,
                    LoginState.ERROR,
                    error_message="Failed to save auth state",
                )
                return LoginResponse(
                    session_id=request.session_id,
                    status="error",
                    error="Failed to save auth state",
                )

        elif result.state == PageState.TWOFA_MOBILE:
            logger.info(
                "Mobile 2FA required - waiting for approval on device, code: %s",
                result.verification_code,
            )
            manager.update_state(
                request.session_id,
                LoginState.WAITING_MOBILE,
                requires_2fa=True,
                twofa_method="mobile",
            )
            return LoginResponse(
                session_id=request.session_id,
                status="waiting_mobile",
                twofa_method="mobile",
                verification_code=result.verification_code,
                message="Approve the login request on your GitHub Mobile app",
            )

        elif result.state in (PageState.TWOFA_APP, PageState.TWOFA_SMS):
            logger.info("2FA required, method: %s", result.twofa_method)
            manager.update_state(
                request.session_id,
                LoginState.WAITING_2FA,
                requires_2fa=True,
                twofa_method=result.twofa_method,
            )
            return LoginResponse(
                session_id=request.session_id,
                status="waiting_2fa",
                twofa_method=result.twofa_method,
                message="Enter your 2FA code",
            )

        elif result.state == PageState.TWOFA_SECURITY_KEY:
            logger.warning("Security key 2FA detected (not supported)")
            manager.update_state(
                request.session_id,
                LoginState.ERROR,
                error_message=result.error_message,
            )
            return LoginResponse(
                session_id=request.session_id,
                status="error",
                error=result.error_message
                or "Security key 2FA not supported. Please configure authenticator app.",
            )

        elif result.state == PageState.CAPTCHA:
            logger.warning("CAPTCHA detected")
            manager.update_state(
                request.session_id,
                LoginState.CAPTCHA,
                error_message=result.error_message,
            )
            return LoginResponse(
                session_id=request.session_id,
                status="captcha",
                error=result.error_message
                or "CAPTCHA required. Use --headed-login flag.",
            )

        elif result.state == PageState.LOGIN_ERROR:
            logger.warning("Login error: %s", result.error_message)
            manager.update_state(
                request.session_id,
                LoginState.ERROR,
                error_message=result.error_message,
            )
            return LoginResponse(
                session_id=request.session_id,
                status="error",
                error=result.error_message or "Login failed",
            )

        else:
            # Unknown state
            logger.error(
                "Unknown page state after credentials: %s, error: %s",
                result.state.value,
                result.error_message,
            )
            manager.update_state(
                request.session_id,
                LoginState.ERROR,
                error_message=result.error_message or "Unknown page state",
            )
            return LoginResponse(
                session_id=request.session_id,
                status="error",
                error=result.error_message or "Unknown page state after credentials",
            )

    except Exception as e:
        logger.exception("Error during credential submission: %s", e)
        manager.update_state(
            request.session_id,
            LoginState.ERROR,
            error_message=str(e),
        )
        return LoginResponse(
            session_id=request.session_id,
            status="error",
            error=f"Error during login: {e}",
        )


@router.post(
    "/login/2fa",
    response_model=LoginResponse,
    summary="Submit 2FA code",
    description="Submit the 2FA verification code.",
)
async def submit_2fa(request: Login2FARequest) -> LoginResponse:
    """
    Submit 2FA code.

    Returns success or error.
    """
    manager = get_session_manager()
    session = manager.get_session(request.session_id)

    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Session not found or expired",
        )

    if session.state != LoginState.WAITING_2FA:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid session state for 2FA: {session.state.value}",
        )

    fetcher = manager.get_fetcher(request.session_id)
    if fetcher is None:
        raise HTTPException(
            status_code=500,
            detail="No fetcher associated with session",
        )

    # Update state to submitting
    manager.update_state(request.session_id, LoginState.SUBMITTING_2FA)

    try:
        # Submit 2FA code (async)
        result = await fetcher.submit_2fa_code(request.code)

        if result.state == PageState.LOGGED_IN:
            # Success! Save auth state
            success, username = await fetcher.save_auth_state(session.account)
            if success:
                manager.update_state(
                    request.session_id,
                    LoginState.SUCCESS,
                    username=username,
                )
                return LoginResponse(
                    session_id=request.session_id,
                    status="success",
                    username=username,
                    message="Login successful",
                )
            else:
                manager.update_state(
                    request.session_id,
                    LoginState.ERROR,
                    error_message="Failed to save auth state",
                )
                return LoginResponse(
                    session_id=request.session_id,
                    status="error",
                    error="Failed to save auth state",
                )

        elif result.state == PageState.LOGIN_ERROR:
            # Wrong 2FA code - stay in WAITING_2FA state for retry
            manager.update_state(request.session_id, LoginState.WAITING_2FA)
            return LoginResponse(
                session_id=request.session_id,
                status="waiting_2fa",
                error=result.error_message or "Invalid 2FA code, please try again",
            )

        else:
            manager.update_state(
                request.session_id,
                LoginState.ERROR,
                error_message=result.error_message or "Unknown state after 2FA",
            )
            return LoginResponse(
                session_id=request.session_id,
                status="error",
                error=result.error_message or "Unknown state after 2FA submission",
            )

    except Exception as e:
        manager.update_state(
            request.session_id,
            LoginState.ERROR,
            error_message=str(e),
        )
        return LoginResponse(
            session_id=request.session_id,
            status="error",
            error=f"Error during 2FA: {e}",
        )


class LoginMobileWaitRequest(BaseModel):
    """Request to wait for mobile 2FA approval."""

    session_id: str
    timeout_seconds: int = 120


@router.post(
    "/login/mobile-wait",
    response_model=LoginResponse,
    summary="Wait for mobile 2FA approval",
    description="Poll for GitHub Mobile 2FA approval.",
)
async def wait_for_mobile_2fa(request: LoginMobileWaitRequest) -> LoginResponse:
    """
    Wait for mobile 2FA approval.

    This endpoint polls until the user approves on their device or timeout.
    """
    logger.info("Waiting for mobile 2FA approval, session: %s", request.session_id)
    manager = get_session_manager()
    session = manager.get_session(request.session_id)

    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Session not found or expired",
        )

    if session.state != LoginState.WAITING_MOBILE:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid session state for mobile wait: {session.state.value}",
        )

    fetcher = manager.get_fetcher(request.session_id)
    if fetcher is None:
        raise HTTPException(
            status_code=500,
            detail="No fetcher associated with session",
        )

    try:
        # Wait for mobile approval (async polling)
        result = await fetcher.wait_for_mobile_approval(
            timeout_seconds=request.timeout_seconds
        )

        if result.state == PageState.LOGGED_IN:
            # Success! Save auth state
            success, username = await fetcher.save_auth_state(session.account)
            if success:
                manager.update_state(
                    request.session_id,
                    LoginState.SUCCESS,
                    username=username,
                )
                return LoginResponse(
                    session_id=request.session_id,
                    status="success",
                    username=username,
                    message="Login successful",
                )
            else:
                manager.update_state(
                    request.session_id,
                    LoginState.ERROR,
                    error_message="Failed to save auth state",
                )
                return LoginResponse(
                    session_id=request.session_id,
                    status="error",
                    error="Failed to save auth state",
                )

        elif result.state == PageState.TWOFA_MOBILE:
            # Still waiting (timeout)
            return LoginResponse(
                session_id=request.session_id,
                status="waiting_mobile",
                twofa_method="mobile",
                error=result.error_message,
                message="Mobile approval timed out. Try again.",
            )

        elif result.state == PageState.LOGIN_ERROR:
            manager.update_state(
                request.session_id,
                LoginState.ERROR,
                error_message=result.error_message,
            )
            return LoginResponse(
                session_id=request.session_id,
                status="error",
                error=result.error_message or "Mobile 2FA failed",
            )

        else:
            manager.update_state(
                request.session_id,
                LoginState.ERROR,
                error_message=result.error_message or "Unexpected state",
            )
            return LoginResponse(
                session_id=request.session_id,
                status="error",
                error=result.error_message or "Unexpected state during mobile wait",
            )

    except Exception as e:
        logger.exception("Error during mobile 2FA wait: %s", e)
        manager.update_state(
            request.session_id,
            LoginState.ERROR,
            error_message=str(e),
        )
        return LoginResponse(
            session_id=request.session_id,
            status="error",
            error=f"Error during mobile 2FA: {e}",
        )


@router.get(
    "/login/status/{session_id}",
    response_model=LoginResponse,
    summary="Check login status",
    description="Get the current status of a login session.",
)
async def get_login_status(session_id: str) -> LoginResponse:
    """Get the current status of a login session."""
    manager = get_session_manager()
    session = manager.get_session(session_id)

    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Session not found or expired",
        )

    # Map session state to response status
    status_map = {
        LoginState.INITIALIZED: "initialized",
        LoginState.SUBMITTING_CREDENTIALS: "submitting",
        LoginState.WAITING_2FA: "waiting_2fa",
        LoginState.WAITING_MOBILE: "waiting_mobile",
        LoginState.SUBMITTING_2FA: "submitting",
        LoginState.SUCCESS: "success",
        LoginState.ERROR: "error",
        LoginState.CAPTCHA: "captcha",
    }

    return LoginResponse(
        session_id=session.session_id,
        status=status_map.get(session.state, "error"),
        error=session.error_message,
        username=session.username,
        twofa_method=session.twofa_method if session.requires_2fa else None,
    )


@router.post(
    "/login/cancel",
    response_model=LoginResponse,
    summary="Cancel login session",
    description="Cancel and clean up a login session.",
)
async def cancel_login(request: LoginCancelRequest) -> LoginResponse:
    """Cancel and clean up a login session."""
    manager = get_session_manager()
    session = manager.get_session(request.session_id)

    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Session not found or expired",
        )

    # Get fetcher and close it asynchronously
    fetcher = manager.get_fetcher(request.session_id)
    if fetcher is not None:
        try:
            await fetcher.close()
        except Exception:
            pass

    # Remove the session
    manager.remove_session(request.session_id)

    return LoginResponse(
        session_id=request.session_id,
        status="error",
        message="Session cancelled",
    )


@router.get(
    "/needs-login",
    summary="Check if login is needed",
    description="Check if the server requires authentication.",
)
async def needs_login() -> dict:
    """Check if the server requires authentication."""
    import os

    from ghinbox.auth import has_valid_auth, DEFAULT_ACCOUNT

    # In test mode, never require login (tests use mocked APIs)
    if os.environ.get("GHINBOX_TEST_MODE") == "1":
        logger.warning(
            "needs_login check: test mode enabled, returning needs_login=False"
        )
        return {"needs_login": False, "account": "test"}

    account = os.environ.get("GHSIM_ACCOUNT", DEFAULT_ACCOUNT)
    needs_auth = os.environ.get("GHINBOX_NEEDS_AUTH") == "1"

    logger.warning(
        "needs_login check: account=%s, GHINBOX_NEEDS_AUTH=%s, has_valid_auth=%s",
        account,
        os.environ.get("GHINBOX_NEEDS_AUTH"),
        has_valid_auth(account),
    )

    # If explicitly marked as needing auth
    if needs_auth:
        logger.warning("Returning needs_login=True (GHINBOX_NEEDS_AUTH is set)")
        return {"needs_login": True, "account": account}

    # Check if we have valid auth
    if not has_valid_auth(account):
        logger.warning("Returning needs_login=True (no valid auth for account)")
        return {"needs_login": True, "account": account}

    logger.warning("Returning needs_login=False")
    return {"needs_login": False, "account": account}


async def _initialize_fetcher_after_login(account: str) -> bool:
    """Initialize the NotificationsFetcher after successful login.

    This is called when login completes successfully to set up the fetcher
    that was skipped during server startup due to missing auth.

    Returns:
        True if fetcher was initialized successfully
    """
    import os

    from ghinbox.api.fetcher import NotificationsFetcher, get_fetcher, set_fetcher

    logger.warning("_initialize_fetcher_after_login called for account: %s", account)

    # Clear the needs-auth flag FIRST - always do this
    old_needs_auth = os.environ.get("GHINBOX_NEEDS_AUTH")
    if "GHINBOX_NEEDS_AUTH" in os.environ:
        del os.environ["GHINBOX_NEEDS_AUTH"]
        logger.warning("Cleared GHINBOX_NEEDS_AUTH (was: %s)", old_needs_auth)

    # Set the account
    os.environ["GHSIM_ACCOUNT"] = account
    logger.warning("Set GHSIM_ACCOUNT=%s", account)

    # Check if fetcher already exists
    if get_fetcher() is not None:
        logger.warning("Fetcher already exists, skipping initialization")
        return True

    headless = os.environ.get("GHSIM_HEADLESS", "1") == "1"
    logger.warning("headless=%s", headless)

    try:
        logger.warning("Initializing NotificationsFetcher for account: %s", account)
        fetcher = NotificationsFetcher(account=account, headless=headless)
        set_fetcher(fetcher)
        logger.warning("NotificationsFetcher initialized successfully")
        return True
    except Exception as e:
        logger.exception("Failed to initialize fetcher: %s", e)
        return False


@router.post(
    "/reload",
    summary="Reload authentication",
    description="Reload auth and initialize fetcher after login.",
)
async def reload_auth() -> dict:
    """Reload authentication after successful login.

    This endpoint should be called after login completes to initialize
    the notifications fetcher and provision the API token if needed.
    """
    import asyncio
    import os

    from ghinbox.auth import has_valid_auth, DEFAULT_ACCOUNT, get_auth_state_path
    from ghinbox.token import has_token, provision_token, verify_token

    account = os.environ.get("GHSIM_ACCOUNT", DEFAULT_ACCOUNT)
    auth_path = get_auth_state_path(account)
    has_auth = has_valid_auth(account)

    logger.warning(
        "reload_auth called: account=%s, auth_path=%s, exists=%s",
        account,
        auth_path,
        has_auth,
    )

    if not has_auth:
        raise HTTPException(
            status_code=400,
            detail=f"No valid auth state found at {auth_path}. Complete login first.",
        )

    success = await _initialize_fetcher_after_login(account)

    # Provision token if missing or invalid
    token_status = "skipped"
    need_provision = False
    if not has_token(account):
        logger.warning("No token found for account %s, provisioning...", account)
        need_provision = True
    else:
        # Verify existing token is still valid
        loop = asyncio.get_event_loop()
        is_valid, login = await loop.run_in_executor(
            None, lambda: verify_token(account)
        )
        if is_valid:
            logger.warning(
                "Token already exists and is valid for account %s (login=%s)",
                account,
                login,
            )
            token_status = "exists"
        else:
            logger.warning(
                "Token exists but is invalid/expired for account %s, re-provisioning...",
                account,
            )
            need_provision = True

    if need_provision:
        try:
            # Run sync provision_token in thread pool
            loop = asyncio.get_event_loop()
            token = await loop.run_in_executor(
                None,
                lambda: provision_token(account, headless=True, prod=True, force=True),
            )
            if token:
                logger.warning("Token provisioned successfully")
                token_status = "provisioned"
            else:
                logger.warning("Token provisioning failed")
                token_status = "failed"
        except Exception as e:
            logger.exception("Error provisioning token: %s", e)
            token_status = f"error: {e}"

    if success:
        return {
            "status": "ok",
            "message": "Auth reloaded and fetcher initialized",
            "token_status": token_status,
        }
    else:
        return {
            "status": "error",
            "message": "Failed to initialize fetcher",
            "token_status": token_status,
        }
