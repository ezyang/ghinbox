"""
Local production observability helpers.

This module intentionally records request metadata, not request or response
bodies.  The debug endpoints are meant for live troubleshooting without
capturing GitHub tokens, site passwords, or notification contents.
"""

from __future__ import annotations

import json
import logging
import os
import hashlib
import time
import uuid
from collections import deque
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter

from ghinbox.api.fetcher import get_fetcher

MAX_RECENT_REQUESTS = 200
REQUEST_ID_HEADER = b"x-ghinbox-request-id"


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class RecentRequestStore:
    """Thread-safe in-memory ring buffer of recent request metadata."""

    def __init__(self, maxlen: int = MAX_RECENT_REQUESTS) -> None:
        self._requests: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = Lock()

    def add(self, entry: dict[str, Any]) -> None:
        with self._lock:
            self._requests.append(entry)

    def snapshot(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            requests = list(self._requests)
        return requests[-limit:]

    def clear(self) -> None:
        with self._lock:
            self._requests.clear()

    @property
    def maxlen(self) -> int:
        return self._requests.maxlen or MAX_RECENT_REQUESTS


recent_requests = RecentRequestStore()
recent_notification_actions = RecentRequestStore()
recent_deployments = RecentRequestStore()

request_logger = logging.getLogger("ghinbox.requests")
request_logger.setLevel(logging.INFO)
request_logger.propagate = False


def configure_request_logging() -> None:
    """Configure JSONL request logging from environment variables."""
    if os.environ.get("GHINBOX_REQUEST_LOG_ENABLED", "1") != "1":
        return

    log_file = os.environ.get("GHINBOX_REQUEST_LOG_FILE")
    if not log_file:
        return

    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    resolved_log_path = str(log_path.resolve())
    for handler in request_logger.handlers:
        if getattr(handler, "baseFilename", None) == resolved_log_path:
            return

    handler = RotatingFileHandler(
        resolved_log_path,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    request_logger.addHandler(handler)


def _header_value(headers: list[tuple[bytes, bytes]], name: bytes) -> str | None:
    for key, value in headers:
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def _client_host(scope: dict[str, Any]) -> str | None:
    client = scope.get("client")
    if not client:
        return None
    return str(client[0])


class ObservabilityMiddleware:
    """ASGI middleware that records request metadata and emits request IDs."""

    def __init__(self, app) -> None:
        self.app = app
        configure_request_logging()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = str(uuid.uuid4())
        scope["ghinbox_request_id"] = request_id
        method = scope.get("method", "")
        path = scope.get("path", "")
        query_string = scope.get("query_string", b"").decode("latin-1")
        headers = scope.get("headers", [])
        started_at = _utc_now_iso()
        started = time.perf_counter()
        status_code = 500

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                response_headers = list(message.get("headers", []))
                response_headers.append((REQUEST_ID_HEADER, request_id.encode()))
                message["headers"] = response_headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            entry = {
                "timestamp": started_at,
                "request_id": request_id,
                "method": method,
                "path": path,
                "query": query_string,
                "status_code": status_code,
                "duration_ms": duration_ms,
                "client": _client_host(scope),
                "user_agent": _header_value(headers, b"user-agent"),
            }
            recent_requests.add(entry)
            if request_logger.handlers:
                request_logger.info(json.dumps(entry, separators=(",", ":")))


def _notification_id_fingerprint(notification_id: str) -> dict[str, str]:
    digest = hashlib.sha256(notification_id.encode("utf-8")).hexdigest()
    return {
        "sha256": digest,
        "prefix": notification_id[:12],
        "suffix": notification_id[-12:],
    }


def emit_notification_action_audit(
    *,
    request_id: str | None,
    action: str,
    notification_ids: list[str],
    token_present: bool,
    status: str,
    error: str | None,
    github_status_code: int | None,
    duration_ms: float,
) -> None:
    """Record a sanitized notification action audit event."""
    entry: dict[str, Any] = {
        "timestamp": _utc_now_iso(),
        "event": "notification_action",
        "request_id": request_id,
        "action": action,
        "notification_count": len(notification_ids),
        "notification_ids": [
            _notification_id_fingerprint(notification_id)
            for notification_id in notification_ids
        ],
        "token_present": token_present,
        "status": status,
        "error": error,
        "github_status_code": github_status_code,
        "duration_ms": round(duration_ms, 2),
    }
    recent_notification_actions.add(entry)
    if request_logger.handlers:
        request_logger.info(json.dumps(entry, separators=(",", ":")))


def emit_deployment_audit(
    *,
    request_id: str | None,
    delivery_id: str | None,
    github_event: str | None,
    repository: str | None,
    ref: str | None,
    status: str,
    reason: str | None,
    previous_head: str | None = None,
    current_head: str | None = None,
) -> None:
    """Record a sanitized webhook deployment audit event."""
    entry: dict[str, Any] = {
        "timestamp": _utc_now_iso(),
        "event": "webhook_deployment",
        "request_id": request_id,
        "delivery_id": delivery_id,
        "github_event": github_event,
        "repository": repository,
        "ref": ref,
        "status": status,
        "reason": reason,
        "previous_head": previous_head,
        "current_head": current_head,
    }
    recent_deployments.add(entry)
    if request_logger.handlers:
        request_logger.info(json.dumps(entry, separators=(",", ":")))


router = APIRouter(prefix="/debug", tags=["debug"])


@router.get("/requests")
async def debug_requests(limit: int = 50) -> dict[str, Any]:
    """Return recent request metadata from the in-memory ring buffer."""
    bounded_limit = max(1, min(limit, recent_requests.maxlen))
    return {
        "max_recent_requests": recent_requests.maxlen,
        "requests": recent_requests.snapshot(bounded_limit),
    }


@router.get("/notification-actions")
async def debug_notification_actions(limit: int = 50) -> dict[str, Any]:
    """Return recent sanitized notification action audit events."""
    bounded_limit = max(1, min(limit, recent_notification_actions.maxlen))
    return {
        "max_recent_actions": recent_notification_actions.maxlen,
        "actions": recent_notification_actions.snapshot(bounded_limit),
    }


@router.post("/notification-actions/clear")
async def clear_debug_notification_actions() -> dict[str, str]:
    """Clear the in-memory notification action audit buffer."""
    recent_notification_actions.clear()
    return {"status": "ok"}


@router.get("/deployments")
async def debug_deployments(limit: int = 50) -> dict[str, Any]:
    """Return recent sanitized webhook deployment audit events."""
    bounded_limit = max(1, min(limit, recent_deployments.maxlen))
    return {
        "max_recent_deployments": recent_deployments.maxlen,
        "deployments": recent_deployments.snapshot(bounded_limit),
    }


@router.post("/deployments/clear")
async def clear_debug_deployments() -> dict[str, str]:
    """Clear the in-memory webhook deployment audit buffer."""
    recent_deployments.clear()
    return {"status": "ok"}


@router.post("/requests/clear")
async def clear_debug_requests() -> dict[str, str]:
    """Clear the in-memory recent request buffer."""
    recent_requests.clear()
    return {"status": "ok"}


@router.get("/state")
async def debug_state() -> dict[str, Any]:
    """Return non-secret server state useful for live troubleshooting."""
    fetcher = get_fetcher()
    log_file = os.environ.get("GHINBOX_REQUEST_LOG_FILE")
    return {
        "status": "ok",
        "test_mode": os.environ.get("GHINBOX_TEST_MODE") == "1",
        "needs_auth": os.environ.get("GHINBOX_NEEDS_AUTH") == "1",
        "site_auth_enabled": bool(os.environ.get("GHINBOX_SITE_PASSWORD")),
        "live_fetching": fetcher is not None,
        "account": fetcher.account if fetcher else None,
        "headless": fetcher.headless if fetcher else None,
        "request_log_enabled": os.environ.get("GHINBOX_REQUEST_LOG_ENABLED", "1")
        == "1",
        "request_log_file": log_file,
    }
