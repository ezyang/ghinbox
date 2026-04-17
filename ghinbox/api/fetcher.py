"""
Live HTML fetcher using Playwright.

Fetches notifications HTML from GitHub using an authenticated browser session.
"""

import asyncio
import html
import json
import os
import re
import threading
import time
import urllib.parse
from concurrent.futures import Future, ThreadPoolExecutor
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright, BrowserContext

from ghinbox.auth import create_authenticated_context


DEFAULT_FETCH_LOG_DIR = "responses/github-fetcher"
DEFAULT_FETCH_LOG_RETENTION_HOURS = 24
FETCH_LOG_RETENTION_ENV = "GHINBOX_FETCH_LOG_RETENTION_HOURS"
FETCH_DUMP_DIR_ENV = "GHINBOX_FETCH_DUMP_DIR"
FETCH_DUMP_HTML_ENV = "GHINBOX_FETCH_DUMP_HTML"

GITHUB_PAGE_READY_SELECTOR = (
    ".notifications-list-item, "
    ".blankslate, "
    "body.logged-out, "
    ".session-authentication, "
    ".auth-form, "
    'meta[name="route-pattern"][content*="/login"], '
    'meta[name="user-login"][content=""]'
)


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


def _safe_page_value(get_value: Callable[[], Any]) -> str | None:
    """Return a page value if it is available without masking fetch failures."""
    try:
        value = get_value()
    except Exception:
        return None
    return str(value) if value is not None else None


def _safe_locator_count(page: Any, selector: str) -> int | None:
    """Count diagnostic selectors without letting logging change fetch behavior."""
    try:
        return page.locator(selector).count()
    except Exception:
        return None


def _is_github_login_url(url: str) -> bool:
    """Return true when GitHub redirected the notifications request to login."""
    parsed = urllib.parse.urlparse(url)
    return parsed.netloc == "github.com" and parsed.path in {
        "/login",
        "/session",
        "/sessions/two-factor",
    }


def _env_flag(name: str) -> bool:
    value = os.environ.get(name, "")
    return value.lower() in {"1", "true", "yes", "on"}


def _fetch_log_retention_seconds() -> float | None:
    raw_value = os.environ.get(FETCH_LOG_RETENTION_ENV)
    if raw_value is None:
        return DEFAULT_FETCH_LOG_RETENTION_HOURS * 60 * 60
    try:
        hours = float(raw_value)
    except ValueError:
        print(
            f"[fetcher] Ignoring invalid {FETCH_LOG_RETENTION_ENV}={raw_value!r}; "
            f"using {DEFAULT_FETCH_LOG_RETENTION_HOURS}h"
        )
        return DEFAULT_FETCH_LOG_RETENTION_HOURS * 60 * 60
    if hours <= 0:
        return None
    return hours * 60 * 60


def _prune_old_fetch_logs(dump_root: Path, *, now: datetime) -> None:
    retention_seconds = _fetch_log_retention_seconds()
    if retention_seconds is None:
        return

    cutoff = now.timestamp() - retention_seconds
    for path in dump_root.iterdir():
        if not path.is_file() or path.suffix not in {".html", ".json"}:
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError as e:
            print(f"[fetcher] Failed to prune old fetch log {path}: {e}")


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
        query = f"repo:{owner}/{repo}"
        url = f"https://github.com/notifications?query={urllib.parse.quote(query)}"

        if before:
            url += f"&before={urllib.parse.quote(before)}"
        if after:
            url += f"&after={urllib.parse.quote(after)}"

        timing: dict[str, int] = {}
        page = None
        response_status: int | None = None

        try:
            if self._context is None:
                self.start()

            assert self._context is not None

            t0 = time.perf_counter()
            page = self._context.new_page()
            timing["new_page_ms"] = int((time.perf_counter() - t0) * 1000)

            t0 = time.perf_counter()
            response = page.goto(url, wait_until="domcontentloaded")
            response_status = response.status if response is not None else None
            timing["goto_ms"] = int((time.perf_counter() - t0) * 1000)

            if _is_github_login_url(page.url):
                t0 = time.perf_counter()
                html = page.content()
                timing["content_ms"] = int((time.perf_counter() - t0) * 1000)

                error_text = (
                    "GitHub redirected notifications request to login. "
                    "Stored browser session is expired."
                )
                self._log_github_page(
                    page=page,
                    requested_url=url,
                    html=html,
                    timing=timing,
                    response_status=response_status,
                    event="github_notifications_session_expired",
                    error=error_text,
                )

                t0 = time.perf_counter()
                page.close()
                timing["close_ms"] = int((time.perf_counter() - t0) * 1000)

                return FetchResult(
                    html=html,
                    url=url,
                    status="session_expired",
                    error=error_text,
                    timing=timing,
                )

            # Wait for either notifications, an empty state, or a GitHub
            # logged-out/login page to be in DOM. The parser turns logged-out
            # HTML into a session_expired API response.
            t0 = time.perf_counter()
            page.locator(GITHUB_PAGE_READY_SELECTOR).first.wait_for(
                state="attached",
                timeout=10000,
            )
            timing["wait_for_ms"] = int((time.perf_counter() - t0) * 1000)

            t0 = time.perf_counter()
            html = page.content()
            timing["content_ms"] = int((time.perf_counter() - t0) * 1000)

            self._log_github_page(
                page=page,
                requested_url=url,
                html=html,
                timing=timing,
                response_status=response_status,
                event="github_notifications_fetch",
            )

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
                    page_html = page.content()
                    self._log_github_page(
                        page=page,
                        requested_url=url,
                        html=page_html,
                        timing=timing,
                        response_status=response_status,
                        event="github_notifications_fetch_error",
                        error=error_text,
                    )
                except Exception as dump_error:
                    print(f"[fetcher] Failed to dump page: {dump_error}")
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

    def _log_github_page(
        self,
        *,
        page: Any,
        requested_url: str,
        html: str,
        timing: dict[str, int],
        response_status: int | None,
        event: str,
        error: str | None = None,
    ) -> None:
        now = datetime.now(timezone.utc)
        final_url = _safe_page_value(lambda: page.url)
        title = _safe_page_value(page.title)
        selector_counts = {
            "notifications": _safe_locator_count(page, ".notifications-list-item"),
            "blankslate": _safe_locator_count(page, ".blankslate"),
            "logged_out_body": _safe_locator_count(page, "body.logged-out"),
            "session_authentication": _safe_locator_count(
                page, ".session-authentication"
            ),
            "auth_form": _safe_locator_count(page, ".auth-form"),
            "login_route_meta": _safe_locator_count(
                page, 'meta[name="route-pattern"][content*="/login"]'
            ),
            "empty_user_login_meta": _safe_locator_count(
                page, 'meta[name="user-login"][content=""]'
            ),
        }
        metadata = {
            "event": event,
            "timestamp": now.isoformat(),
            "account": self.account,
            "requested_url": requested_url,
            "final_url": final_url,
            "title": title,
            "response_status": response_status,
            "error": error,
            "timing": timing,
            "selector_counts": selector_counts,
            "html_path": None,
            "metadata_path": None,
            "html_bytes": len(html.encode("utf-8")),
        }

        try:
            self._write_fetch_log_files(
                metadata=metadata,
                html=html,
                requested_url=requested_url,
                now=now,
            )
        except Exception as e:
            metadata["log_error"] = f"{type(e).__name__}: {e}"

        print(f"[fetcher] {json.dumps(metadata, sort_keys=True)}")

    def _write_fetch_log_files(
        self,
        *,
        metadata: dict[str, Any],
        html: str,
        requested_url: str,
        now: datetime,
    ) -> None:
        """Write bounded fetch diagnostics without making logging part of fetch success."""
        dump_root = Path(os.environ.get(FETCH_DUMP_DIR_ENV, DEFAULT_FETCH_LOG_DIR))
        dump_root.mkdir(parents=True, exist_ok=True)
        _prune_old_fetch_logs(dump_root, now=now)

        parsed = urllib.parse.urlparse(requested_url)
        query = urllib.parse.parse_qs(parsed.query).get("query", ["notifications"])[0]
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", query).strip("_") or "notifications"
        timestamp = now.strftime("%Y%m%dT%H%M%S.%fZ")
        stem = f"{timestamp}_{slug}"

        if (
            _env_flag(FETCH_DUMP_HTML_ENV)
            or metadata["event"] != "github_notifications_fetch"
        ):
            html_path = dump_root / f"{stem}.html"
            html_path.write_text(html, encoding="utf-8")
            metadata["html_path"] = str(html_path)

        metadata_path = dump_root / f"{stem}.json"
        metadata["metadata_path"] = str(metadata_path)
        metadata_path.write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
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

            # Use a browser page + fetch() so the request goes through
            # Chromium's networking stack (which respects proxy settings),
            # rather than Playwright's APIRequestContext which does not.
            page = self._context.new_page()
            try:
                page.goto(
                    "https://github.com",
                    wait_until="domcontentloaded",
                )
                result = page.evaluate(
                    """async ([url, payload]) => {
                        const resp = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                            },
                            body: payload,
                        });
                        return { status: resp.status, body: await resp.text() };
                    }""",
                    [url, payload],
                )
            finally:
                page.close()

            status_code = result["status"]
            content = result["body"]

            if status_code >= 400:
                return ActionResult(
                    status="error",
                    error=f"HTTP {status_code}",
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


_fetch_executor: ThreadPoolExecutor | None = None
_fetch_worker_lock = threading.Lock()


def _submit_fetcher_call(func: Callable[[], Any]) -> Future[Any]:
    global _fetch_executor
    with _fetch_worker_lock:
        if _fetch_executor is None:
            _fetch_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="ghinbox-playwright-fetcher",
            )
        return _fetch_executor.submit(func)


async def run_fetcher_call(func, *args, **kwargs):
    future = _submit_fetcher_call(lambda: func(*args, **kwargs))
    return await asyncio.wrap_future(future)


def shutdown_fetcher_executor() -> None:
    global _fetch_executor
    with _fetch_worker_lock:
        executor = _fetch_executor
        _fetch_executor = None
    if executor is not None:
        executor.shutdown(wait=True)


# Global fetcher instance (set by server on startup)
_global_fetcher: NotificationsFetcher | None = None


def get_fetcher() -> NotificationsFetcher | None:
    """Get the global fetcher instance."""
    return _global_fetcher


def set_fetcher(fetcher: NotificationsFetcher | None) -> None:
    """Set the global fetcher instance."""
    global _global_fetcher
    _global_fetcher = fetcher
