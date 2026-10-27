"""Slack DMs through the Meta CLI, for pinging silent PR reviewers.

The hole this fills: the browser cannot reach Slack, and the user's Slack
identity lives in the `meta` CLI on the server's machine. Messages go out as
the user, one DM per recipient.
"""

import asyncio
import json
import os
import re
import shlex
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/slack", tags=["slack"])

DEFAULT_SLACK_COMMAND = "meta"
SLACK_TIMEOUT_SECONDS = 60
MAX_MESSAGE_CHARS = 4000
# A Meta unixname: never a #channel, Slack link, or flag.
HANDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class SlackPingRequest(BaseModel):
    to: str
    markdown: str


def _slack_command() -> list[str]:
    configured = os.environ.get("GHINBOX_SLACK_COMMAND")
    if not configured and os.environ.get("GHINBOX_TEST_MODE") == "1":
        # Tests must never DM real people.
        raise HTTPException(status_code=503, detail="Slack is disabled in test mode")
    return shlex.split(configured or DEFAULT_SLACK_COMMAND)


def _check_handle(handle: str) -> str:
    handle = handle.strip()
    if not HANDLE_RE.match(handle):
        raise HTTPException(status_code=400, detail=f"Not a unixname: {handle!r}")
    return handle


async def _run_slack(args: list[str], stdin: str | None = None) -> Any:
    command = [*_slack_command(), *args]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE
            if stdin is not None
            else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        raise HTTPException(
            status_code=503, detail=f"Could not start Slack CLI: {error}"
        ) from error
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(stdin.encode() if stdin is not None else None),
            timeout=SLACK_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as error:
        process.kill()
        await process.wait()
        raise HTTPException(status_code=504, detail="Slack CLI timed out") from error
    output = stdout.decode(errors="replace").strip()
    try:
        parsed = json.loads(output) if output else None
    except json.JSONDecodeError:
        parsed = None
    failed = isinstance(parsed, dict) and parsed.get("status") == "error"
    if process.returncode != 0 or failed:
        detail = (
            parsed.get("message")
            if failed and isinstance(parsed, dict)
            else (stderr.decode(errors="replace") or output)
        )
        raise HTTPException(
            status_code=502, detail=str(detail).strip()[-500:] or "Slack CLI failed"
        )
    return parsed if parsed is not None else output


@router.get("/user")
async def describe_slack_user(user: str) -> dict[str, Any]:
    """Resolve a unixname to its Slack user, so the UI can show who gets the DM."""
    result = await _run_slack(
        [
            "slack.user",
            "describe",
            f"--user={_check_handle(user)}",
            "--columns=user_id,unixname,real_name,display_name",
            "--output=json",
        ]
    )
    if isinstance(result, list):
        result = result[0] if result else None
    if not isinstance(result, dict):
        raise HTTPException(status_code=404, detail=f"No Slack user for {user!r}")
    return {
        "user_id": result.get("user_id"),
        "unixname": result.get("unixname"),
        "real_name": result.get("real_name"),
        "display_name": result.get("display_name"),
    }


@router.post("/ping")
async def send_slack_ping(request: SlackPingRequest) -> dict[str, Any]:
    """DM one person as the user. The body goes on stdin, not argv."""
    to = _check_handle(request.to)
    markdown = request.markdown.strip()
    if not markdown:
        raise HTTPException(status_code=400, detail="Message is empty")
    if len(markdown) > MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=400, detail="Message is too long")
    result = await _run_slack(
        [
            "slack.message",
            "send",
            f"--to={to}",
            "--markdown=file://-",
            "--no-message-suffix",
            "--output=json",
        ],
        stdin=markdown,
    )
    return {"to": to, "result": result}
