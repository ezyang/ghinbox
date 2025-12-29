"""
FastAPI application for the HTML notifications API.
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from ghinbox.api.routes import router as notifications_router
from ghinbox.api.github_proxy import router as github_proxy_router
from ghinbox.api.fetcher import (
    NotificationsFetcher,
    set_fetcher,
    get_fetcher,
    run_fetcher_call,
    shutdown_fetcher_executor,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize fetcher on startup if account is configured."""
    account = os.environ.get("GHSIM_ACCOUNT")
    if account:
        headless = os.environ.get("GHSIM_HEADLESS", "1") == "1"
        fetcher = NotificationsFetcher(account=account, headless=headless)
        set_fetcher(fetcher)

    yield

    # Cleanup on shutdown - must run in thread pool because Playwright's
    # sync API cannot be called from a different thread than it started in
    fetcher = get_fetcher()
    if fetcher:
        await run_fetcher_call(fetcher.stop)
        set_fetcher(None)
    shutdown_fetcher_executor()


# Static files directory for the webapp
STATIC_DIR = Path(__file__).parent.parent.parent / "webapp"

app = FastAPI(
    lifespan=lifespan,
    title="GitHub HTML Notifications API",
    description="""
    A REST API that extracts structured notification data from GitHub's
    HTML notifications page.

    This API provides read-only access to notification data that is only
    available in the web UI, including:
    - Saved/bookmarked state
    - Done state
    - Subject state (open, closed, merged, draft)
    - Multiple actors

    ## Usage

    The main endpoint is `GET /notifications/html/repo/{owner}/{repo}` which
    parses notifications HTML and returns structured JSON.

    For testing, you can provide a `fixture` query parameter pointing to an
    HTML file on disk.
    """,
    version="0.1.0",
    license_info={
        "name": "MIT",
    },
)

app.include_router(notifications_router)
app.include_router(github_proxy_router)

# Mount static files for the webapp (if directory exists)
if STATIC_DIR.exists():
    app.mount("/app", StaticFiles(directory=STATIC_DIR, html=True), name="webapp")


@app.get("/", include_in_schema=False)
async def root():
    """Redirect to webapp or docs."""
    from fastapi.responses import RedirectResponse

    if STATIC_DIR.exists():
        return RedirectResponse(url="/app/")
    return {"message": "See /docs for API documentation"}


@app.get("/health")
async def health():
    """Health check endpoint."""
    from ghinbox.api.fetcher import get_fetcher

    fetcher = get_fetcher()
    return {
        "status": "ok",
        "test_mode": os.environ.get("GHINBOX_TEST_MODE") == "1",
        "live_fetching": fetcher is not None,
        "account": fetcher.account if fetcher else None,
    }


@app.get("/health/test")
async def health_test():
    """
    Test-mode-only health check endpoint.

    Returns 200 only when server is in test mode (started with --test flag).
    Returns 503 when server is in production mode.

    This endpoint is used by Playwright to ensure tests don't accidentally
    connect to a production server. If a production server is running on
    the test port, this endpoint will return 503 and Playwright will start
    a fresh test server instead of reusing the production one.
    """
    from fastapi import HTTPException

    if os.environ.get("GHINBOX_TEST_MODE") != "1":
        raise HTTPException(
            status_code=503,
            detail="Server is not in test mode. Tests require --test flag.",
        )
    return {"status": "ok", "test_mode": True}
