import asyncio
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, cast

from ghinbox.api.fetcher import (
    NotificationsFetcher,
    run_fetcher_call,
    shutdown_fetcher_executor,
)


class FakeLocator:
    def __init__(self, selector: str, page: "FakePage") -> None:
        self.selector = selector
        self.page = page
        self.first = self

    def wait_for(self, *, state: str, timeout: int) -> None:
        self.page.wait_selector = self.selector
        assert state == "attached"
        assert timeout == 10000
        if "body.logged-out" not in self.selector:
            raise TimeoutError("login marker was not included in ready selector")

    def count(self) -> int:
        return self.page.counts.get(self.selector, 0)


class FakeResponse:
    status = 200


class FakePage:
    def __init__(
        self,
        *,
        url: str = "https://github.com/login?return_to=%2Fnotifications",
    ) -> None:
        self.url = url
        self.wait_selector: str | None = None
        self.closed = False
        self.counts = {
            ".notifications-list-item": 0,
            ".blankslate": 0,
            "body.logged-out": 1,
            ".session-authentication": 1,
            ".auth-form": 1,
            'meta[name="route-pattern"][content*="/login"]': 1,
            'meta[name="user-login"][content=""]': 1,
        }

    def goto(self, url: str, *, wait_until: str) -> FakeResponse:
        assert url == "https://github.com/notifications?query=repo%3Atestowner/testrepo"
        assert wait_until == "domcontentloaded"
        return FakeResponse()

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(selector, self)

    def content(self) -> str:
        if (
            self.url
            == "https://github.com/notifications?query=repo%3Atestowner/testrepo"
        ):
            return """
            <html>
              <head>
                <meta name="route-pattern" content="/notifications(.:format)">
                <meta name="user-login" content="ezyang0">
              </head>
              <body>
                <div class="notifications-list-item">Notification</div>
              </body>
            </html>
            """
        return """
        <html>
          <head>
            <meta name="route-pattern" content="/login">
            <meta name="user-login" content="">
          </head>
          <body class="logged-out">
            <div class="session-authentication">Sign in</div>
          </body>
        </html>
        """

    def title(self) -> str:
        return "GitHub"

    def close(self) -> None:
        self.closed = True


class FakeContext:
    def __init__(
        self,
        *,
        page_url: str = "https://github.com/login?return_to=%2Fnotifications",
    ) -> None:
        self.page = FakePage(url=page_url)

    def new_page(self) -> FakePage:
        return self.page


def test_fetch_returns_session_expired_for_login_redirect(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    monkeypatch.setenv("GHINBOX_FETCH_DUMP_DIR", str(tmp_path))
    fetcher = NotificationsFetcher(account="default")
    context = FakeContext()
    cast(Any, fetcher)._context = context

    result = fetcher.fetch_repo_notifications("testowner", "testrepo")

    assert result.status == "session_expired"
    assert result.error is not None
    assert "redirected" in result.error
    assert 'body class="logged-out"' in result.html
    assert context.page.wait_selector is None
    assert context.page.closed is True

    html_dumps = list(tmp_path.glob("*.html"))
    metadata_dumps = list(tmp_path.glob("*.json"))
    assert len(html_dumps) == 1
    assert len(metadata_dumps) == 1
    assert "Sign in" in html_dumps[0].read_text()
    metadata = json.loads(metadata_dumps[0].read_text())
    assert metadata["event"] == "github_notifications_session_expired"
    assert metadata["selector_counts"]["logged_out_body"] == 1


def test_success_fetch_writes_metadata_without_html_dump_by_default(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    monkeypatch.setenv("GHINBOX_FETCH_DUMP_DIR", str(tmp_path))
    monkeypatch.delenv("GHINBOX_FETCH_DUMP_HTML", raising=False)
    fetcher = NotificationsFetcher(account="default")
    context = FakeContext(
        page_url="https://github.com/notifications?query=repo%3Atestowner/testrepo"
    )
    cast(Any, fetcher)._context = context

    result = fetcher.fetch_repo_notifications("testowner", "testrepo")

    assert result.status == "ok"
    assert context.page.closed is True
    assert list(tmp_path.glob("*.html")) == []
    metadata_dumps = list(tmp_path.glob("*.json"))
    assert len(metadata_dumps) == 1
    metadata = json.loads(metadata_dumps[0].read_text())
    assert metadata["event"] == "github_notifications_fetch"
    assert metadata["html_path"] is None
    assert metadata["metadata_path"] == str(metadata_dumps[0])


def test_fetch_logging_is_best_effort(monkeypatch: Any) -> None:
    fetcher = NotificationsFetcher(account="default")
    context = FakeContext(
        page_url="https://github.com/notifications?query=repo%3Atestowner/testrepo"
    )
    cast(Any, fetcher)._context = context

    def fail_write(**kwargs: Any) -> None:
        raise OSError("disk is full")

    monkeypatch.setattr(fetcher, "_write_fetch_log_files", fail_write)

    result = fetcher.fetch_repo_notifications("testowner", "testrepo")

    assert result.status == "ok"
    assert result.error is None


def test_fetch_logs_prune_old_files(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.setenv("GHINBOX_FETCH_DUMP_DIR", str(tmp_path))
    monkeypatch.setenv("GHINBOX_FETCH_LOG_RETENTION_HOURS", "1")
    old_log = tmp_path / "old.json"
    fresh_log = tmp_path / "fresh.json"
    old_log.write_text("{}")
    fresh_log.write_text("{}")
    old_time = time.time() - (2 * 60 * 60)
    os.utime(old_log, (old_time, old_time))

    fetcher = NotificationsFetcher(account="default")
    context = FakeContext(
        page_url="https://github.com/notifications?query=repo%3Atestowner/testrepo"
    )
    cast(Any, fetcher)._context = context

    result = fetcher.fetch_repo_notifications("testowner", "testrepo")

    assert result.status == "ok"
    assert not old_log.exists()
    assert fresh_log.exists()


def test_run_fetcher_call_serializes_work_on_one_worker_thread() -> None:
    seen_threads: set[int] = set()
    order: list[int] = []

    async def run() -> list[int]:
        await asyncio.gather(
            run_fetcher_call(record_task, 1),
            run_fetcher_call(record_task, 2),
        )
        return order

    def record_task(value: int) -> None:
        try:
            asyncio.get_running_loop()
            raise AssertionError("fetcher worker should not have a running event loop")
        except RuntimeError:
            pass
        seen_threads.add(threading.get_ident())
        order.append(value)

    try:
        result = asyncio.run(run())
    finally:
        shutdown_fetcher_executor()

    assert result == [1, 2]
    assert len(seen_threads) == 1
