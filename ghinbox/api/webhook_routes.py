"""Authenticated GitHub webhook endpoint for updating the running checkout."""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ghinbox.api.observability import emit_deployment_audit

router = APIRouter(prefix="/webhooks/github", tags=["deployment"])
logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
MAIN_REF = "refs/heads/main"
_update_lock = threading.Lock()


class UpdateError(RuntimeError):
    """Raised when the checkout cannot be safely updated."""


@dataclass(frozen=True)
class DeploymentResult:
    """Successful update result suitable for sanitized audit records."""

    status: str
    previous_head: str
    current_head: str


def _verify_signature(payload: bytes, signature: str | None, secret: str) -> None:
    if not signature:
        raise HTTPException(status_code=403, detail="Webhook signature required")
    expected = (
        "sha256="
        + hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    )
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=403, detail="Invalid webhook signature")


def _decode_event(payload: bytes, content_type: str) -> dict:
    decoded_payload = payload
    if content_type.partition(";")[0].strip().lower() == (
        "application/x-www-form-urlencoded"
    ):
        try:
            form = parse_qs(payload.decode("utf-8"), strict_parsing=True)
            decoded_payload = form["payload"][0].encode("utf-8")
        except (KeyError, UnicodeDecodeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid webhook payload")
    try:
        event = json.loads(decoded_payload)
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=400, detail="Invalid webhook payload"
        ) from error
    if not isinstance(event, dict):
        raise HTTPException(status_code=400, detail="Invalid webhook payload")
    return event


def _git(*args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *args],
            check=False,
            capture_output=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UpdateError("git command could not be completed") from error
    if result.returncode != 0:
        raise UpdateError(f"git {args[0]} failed")
    return result.stdout.strip()


def update_from_origin_main() -> DeploymentResult:
    """Fast-forward a clean local main checkout to origin/main."""
    with _update_lock:
        if _git("branch", "--show-current") != "main":
            raise UpdateError("checkout is not on main")
        if _git("status", "--porcelain", "--untracked-files=normal"):
            raise UpdateError("checkout contains local changes")

        previous_head = _git("rev-parse", "HEAD")
        _git("fetch", "origin", "refs/heads/main:refs/remotes/origin/main")
        _git("merge", "--ff-only", "origin/main")
        current_head = _git("rev-parse", "HEAD")
        status = "already_current" if current_head == previous_head else "updated"
        return DeploymentResult(status, previous_head, current_head)


@router.post("/push")
async def receive_push_webhook(request: Request):
    """Receive signed GitHub pushes and update for advances to origin/main."""
    secret = os.environ.get("GHINBOX_WEBHOOK_SECRET")
    repository = os.environ.get("GHINBOX_WEBHOOK_REPOSITORY")
    if not secret or not repository:
        raise HTTPException(
            status_code=503, detail="Webhook deployment is not configured"
        )

    payload = await request.body()
    _verify_signature(payload, request.headers.get("x-hub-signature-256"), secret)
    event = _decode_event(payload, request.headers.get("content-type", ""))

    event_repository = event.get("repository", {}).get("full_name")
    if event_repository != repository:
        raise HTTPException(status_code=403, detail="Unexpected webhook repository")

    request_id = request.scope.get("ghinbox_request_id")
    delivery_id = request.headers.get("x-github-delivery")
    github_event = request.headers.get("x-github-event")
    ref = event.get("ref")
    if github_event != "push":
        emit_deployment_audit(
            request_id=request_id,
            delivery_id=delivery_id,
            github_event=github_event,
            repository=event_repository,
            ref=ref,
            status="ignored",
            reason="not push",
        )
        return JSONResponse(
            status_code=202, content={"status": "ignored", "reason": "not push"}
        )
    if ref != MAIN_REF:
        emit_deployment_audit(
            request_id=request_id,
            delivery_id=delivery_id,
            github_event=github_event,
            repository=event_repository,
            ref=ref,
            status="ignored",
            reason="not main",
        )
        return JSONResponse(
            status_code=202, content={"status": "ignored", "reason": "not main"}
        )

    try:
        result = await asyncio.to_thread(update_from_origin_main)
    except UpdateError as error:
        emit_deployment_audit(
            request_id=request_id,
            delivery_id=delivery_id,
            github_event=github_event,
            repository=event_repository,
            ref=ref,
            status="rejected",
            reason=str(error),
        )
        logger.warning("Webhook update rejected: %s", error)
        raise HTTPException(status_code=409, detail=str(error)) from error
    emit_deployment_audit(
        request_id=request_id,
        delivery_id=delivery_id,
        github_event=github_event,
        repository=event_repository,
        ref=ref,
        status=result.status,
        reason=None,
        previous_head=result.previous_head,
        current_head=result.current_head,
    )
    return {"status": result.status}
