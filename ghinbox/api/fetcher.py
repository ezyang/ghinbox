"""
Live HTML fetcher using Playwright.

Fetches notifications HTML from GitHub using an authenticated browser session.
"""

import asyncio
import html
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from playwright.sync_api import sync_playwright, BrowserContext

from ghinbox.auth import create_authenticated_context


@dataclass
class FetchResult:
    """Result of fetching a notifications page."""

    html: str
    url: str
    status: str = "ok"
    error: str | None = None
    timing: dict | None = None


@dataclass
class ActionResult:
    """Result of a notification action (unarchive, subscribe, etc.)."""

    status: str = "ok"
    error: str | None = None
    response_html: str | None = None


class NotificationsFetcher:
    """
    Fetches notifications HTML from GitHub using Playwright.

    This class manages a persistent browser context for an authenticated
    GitHub session, allowing multiple fetches without re-authenticating.
    """

    def __init__(self, account: str, headless: bool = True):
        """
        Initialize the fetcher.

        Args:
            account: The ghinbox account name (must have valid auth state)
            headless: Whether to run browser in headless mode
        """
        self.account = account
        self.headless = headless
        self._playwright: Any = None
        self._context: BrowserContext | None = None

    def start(self) -> None:
        """Start the browser and create authenticated context."""
        if self._playwright is not None:
            return

        self._playwright = sync_playwright().start()
        self._context = create_authenticated_context(
            self._playwright, self.account, headless=self.headless
        )

        if self._context is None:
            raise RuntimeError(
                f"Failed to create authenticated context for '{self.account}'. "
                f"Run: python -m ghinbox.auth {self.account}"
            )

    def stop(self) -> None:
        """Stop the browser and clean up."""
        if self._context and self._context.browser:
            self._context.browser.close()
        if self._playwright:
            self._playwright.stop()
        self._context = None
        self._playwright = None

    def fetch_repo_notifications(
        self,
        owner: str,
        repo: str,
        before: str | None = None,
        after: str | None = None,
    ) -> FetchResult:
        """
        Fetch notifications HTML for a specific repository.

        Args:
            owner: Repository owner
            repo: Repository name
            before: Pagination cursor for previous page
            after: Pagination cursor for next page

        Returns:
            FetchResult with HTML content and metadata
        """
        if self._context is None:
            self.start()

        assert self._context is not None

        # Build URL
        query = f"repo:{owner}/{repo}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        if before:
            url += f"&before={urllib.parse.quote(before)}"
        if after:
            url += f"&after={urllib.parse.quote(after)}"

        timing: dict[str, int] = {}
        page = None

        try:
            t0 = time.perf_counter()
            page = self._context.new_page()
            timing["new_page_ms"] = int((time.perf_counter() - t0) * 1000)

            t0 = time.perf_counter()
            page.goto(url, wait_until="domcontentloaded")
            timing["goto_ms"] = int((time.perf_counter() - t0) * 1000)

            # Wait for either notifications or empty state to be in DOM
            t0 = time.perf_counter()
            page.locator(".notifications-list-item, .blankslate").first.wait_for(
                state="attached",
                timeout=10000,
            )
            timing["wait_for_ms"] = int((time.perf_counter() - t0) * 1000)

            t0 = time.perf_counter()
            html = page.content()
            timing["content_ms"] = int((time.perf_counter() - t0) * 1000)

            t0 = time.perf_counter()
            page.close()
            timing["close_ms"] = int((time.perf_counter() - t0) * 1000)

            return FetchResult(html=html, url=url, timing=timing)

        except Exception as e:
            error_text = f"{type(e).__name__}: {e}"
            print(f"[fetcher] Failed to fetch notifications page: {error_text}")
            print(f"[fetcher] URL: {url}")
            if timing:
                print(f"[fetcher] Timing: {timing}")
            if page is not None:
                try:
                    page.close()
                except Exception as close_error:
                    print(f"[fetcher] Failed to close page: {close_error}")
            return FetchResult(
                html="",
                url=url,
                status="error",
                error=error_text,
                timing=timing,
            )

    def submit_notification_action(
        self,
        action: str,
        notification_ids: list[str],
        authenticity_token: str,
    ) -> ActionResult:
        """
        Submit a notification action to GitHub using form POST.

        Args:
            action: The action to perform ('unarchive' or 'subscribe')
            notification_ids: The NT_... notification IDs
            authenticity_token: CSRF token from the page

        Returns:
            ActionResult indicating success or failure
        """
        if self._context is None:
            self.start()

        assert self._context is not None

        # Map action names to GitHub endpoints
        action_paths = {
            "archive": "/notifications/beta/archive",
            "unarchive": "/notifications/beta/unarchive",
            "subscribe": "/notifications/beta/subscribe",
            "unsubscribe": "/notifications/beta/unsubscribe",
        }

        if action not in action_paths:
            return ActionResult(
                status="error",
                error=f"Unknown action: {action}. Valid actions: {list(action_paths.keys())}",
            )
        if not notification_ids:
            return ActionResult(
                status="error",
                error="No notification IDs provided for action",
            )

        action_path = action_paths[action]
        url = f"https://github.com{action_path}"
        escaped_token = html.escape(authenticity_token, quote=True)

        try:
            payload = urllib.parse.urlencode(
                [
                    ("authenticity_token", escaped_token),
                    *[
                        ("notification_ids[]", notification_id)
                        for notification_id in notification_ids
                    ],
                ]
            )
            response = self._context.request.post(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": "https://github.com/notifications",
                },
            )
            content = response.text()

            if response.status >= 400:
                return ActionResult(
                    status="error",
                    error=f"HTTP {response.status}",
                    response_html=content,
                )

            lower_content = content.lower()
            if "error" in lower_content and "422" in lower_content:
                return ActionResult(
                    status="error",
                    error="GitHub returned 422 - token may be invalid or expired",
                    response_html=content,
                )
            if "your browser did something unexpected" in lower_content:
                return ActionResult(
                    status="error",
                    error="GitHub returned an unexpected error page",
                    response_html=content,
                )

            return ActionResult(status="ok", response_html=content)

        except Exception as e:
            error_text = f"{type(e).__name__}: {e}"
            print(f"[fetcher] Failed to submit action: {error_text}")
            return ActionResult(status="error", error=error_text)

    def __enter__(self) -> "NotificationsFetcher":
        self.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self.stop()


# Single-thread executor to keep Playwright sync API on one thread.
_fetch_executor = ThreadPoolExecutor(max_workers=1)


async def run_fetcher_call(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_fetch_executor, lambda: func(*args, **kwargs))


def shutdown_fetcher_executor() -> None:
    _fetch_executor.shutdown(wait=False)


# Global fetcher instance (set by server on startup)
_global_fetcher: NotificationsFetcher | None = None


def get_fetcher() -> NotificationsFetcher | None:
    """Get the global fetcher instance."""
    return _global_fetcher


def set_fetcher(fetcher: NotificationsFetcher | None) -> None:
    """Set the global fetcher instance."""
    global _global_fetcher
    _global_fetcher = fetcher
