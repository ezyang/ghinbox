"""Slack DMs through the Meta CLI, for pinging silent PR reviewers.

The hole this fills: the browser cannot reach Slack, and the user's Slack
identity lives in the `meta` CLI on the server's machine. Messages go out as
the user, one DM per recipient. The same CLI maps reviewers' GitHub logins
to unixnames.
"""

import asyncio
import json
import os
import re
import shlex
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/slack", tags=["slack"])

DEFAULT_SLACK_COMMAND = "meta"
SLACK_TIMEOUT_SECONDS = 60
MAX_MESSAGE_CHARS = 4000
# A Meta unixname: never a #channel, Slack link, or flag.
HANDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# A GitHub login; it is interpolated into SQL, so nothing else gets through.
GITHUB_LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
FBID_RE = re.compile(r"^[0-9]{1,20}$")
# Account links change rarely; misses may be a link signed since.
EMPLOYEE_HIT_TTL_SECONDS = 24 * 3600
EMPLOYEE_MISS_TTL_SECONDS = 3600
_employee_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


class SlackPingRequest(BaseModel):
    to: str
    markdown: str


def _meta_command() -> list[str]:
    configured = os.environ.get("GHINBOX_SLACK_COMMAND")
    if not configured and os.environ.get("GHINBOX_TEST_MODE") == "1":
        # Tests must never DM real people or query corp data.
        raise HTTPException(status_code=503, detail="Slack is disabled in test mode")
    return shlex.split(configured or DEFAULT_SLACK_COMMAND)


def _check_handle(handle: str) -> str:
    handle = handle.strip()
    if not HANDLE_RE.match(handle):
        raise HTTPException(status_code=400, detail=f"Not a unixname: {handle!r}")
    return handle


def _parse_json(text: str) -> Any:
    try:
        return json.loads(text) if text.strip() else None
    except json.JSONDecodeError:
        return None


async def _run_meta(args: list[str], stdin: str | None = None) -> Any:
    command = [*_meta_command(), *args]
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
    parsed = _parse_json(output)
    # The CLI reports errors as {"status": "error", "message": ...}, on
    # stderr when it exits nonzero.
    error = next(
        (
            reply
            for reply in (parsed, _parse_json(stderr.decode(errors="replace")))
            if isinstance(reply, dict) and reply.get("status") == "error"
        ),
        None,
    )
    if process.returncode != 0 or error:
        detail = (
            error.get("message")
            if error
            else (stderr.decode(errors="replace") or output)
        )
        raise HTTPException(
            status_code=502, detail=str(detail).strip()[-500:] or "Slack CLI failed"
        )
    return parsed if parsed is not None else output


@router.get("/user")
async def describe_slack_user(user: str) -> dict[str, Any]:
    """Resolve a unixname to its Slack user, so the UI can show who gets the DM."""
    result = await _run_meta(
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


def _rows(result: Any) -> list[dict[str, Any]]:
    data = result.get("data") if isinstance(result, dict) else None
    return [row for row in data or [] if isinstance(row, dict)]


async def _presto(namespace: str, sql: str) -> list[dict[str, Any]]:
    return _rows(
        await _run_meta(
            [
                "presto.query",
                "execute",
                f"--namespace={namespace}",
                "--output=json",
                "--reasoning=Map a PR reviewer's GitHub login to their unixname for a Slack ping",
                f"--sql={sql}",
            ]
        )
    )


async def _find_employee(login: str) -> dict[str, Any] | None:
    """GitHub login -> GitHub account FBID -> linked employee -> profile."""
    accounts = await _presto(
        "infrastructure",
        "SELECT DISTINCT author_github_user_id FROM opensource_github_pull_request_reviews"
        " WHERE ds = (SELECT MAX(ds) FROM opensource_github_pull_request_reviews)"
        f" AND lower(author_username) = '{login.lower()}'",
    )
    account_ids = [
        str(row.get("author_github_user_id"))
        for row in accounts
        if FBID_RE.match(str(row.get("author_github_user_id")))
    ]
    if not account_ids:
        return None
    links = await _presto(
        "aml",
        "SELECT employee_fbid FROM stg_opensource_contributors"
        " WHERE ds = (SELECT MAX(ds) FROM stg_opensource_contributors)"
        f" AND github_user_fbid IN ({', '.join(account_ids)})"
        " AND employee_fbid IS NOT NULL AND revoked_at IS NULL"
        " ORDER BY signed_at DESC LIMIT 1",
    )
    employee_id = str(links[0].get("employee_fbid")) if links else ""
    if not FBID_RE.match(employee_id):
        return None
    profile = await _run_meta(
        ["people.profile", "get", f"--id={employee_id}", "--output=json"]
    )
    if not isinstance(profile, dict) or not profile.get("unixname"):
        return None
    return {
        "login": login,
        "unixname": profile.get("unixname"),
        "name": profile.get("name"),
        "status": profile.get("status"),
        "github_username": profile.get("githubUsername"),
    }


@router.get("/github-user")
async def describe_github_user(login: str) -> dict[str, Any]:
    """Map a GitHub login to the Meta employee linked to it, if any.

    Logins and unixnames often differ (malfet is nshulga), and the link
    lives in Meta's open source contributor tables, not on GitHub.
    """
    if not GITHUB_LOGIN_RE.match(login):
        raise HTTPException(status_code=400, detail=f"Not a GitHub login: {login!r}")
    key = login.lower()
    cached = _employee_cache.get(key)
    if cached and cached[0] > time.monotonic():
        employee = cached[1]
    else:
        employee = await _find_employee(login)
        ttl = EMPLOYEE_HIT_TTL_SECONDS if employee else EMPLOYEE_MISS_TTL_SECONDS
        _employee_cache[key] = (time.monotonic() + ttl, employee)
    if not employee:
        raise HTTPException(
            status_code=404, detail=f"No Meta employee is linked to @{login}"
        )
    return employee


@router.post("/ping")
async def send_slack_ping(request: SlackPingRequest) -> dict[str, Any]:
    """DM one person as the user. The body goes on stdin, not argv."""
    to = _check_handle(request.to)
    markdown = request.markdown.strip()
    if not markdown:
        raise HTTPException(status_code=400, detail="Message is empty")
    if len(markdown) > MAX_MESSAGE_CHARS:
        raise HTTPException(status_code=400, detail="Message is too long")
    result = await _run_meta(
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
