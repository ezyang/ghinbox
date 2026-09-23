"""Read/trigger endpoints for the background feed digest."""

from typing import Any

from fastapi import APIRouter, HTTPException

from ghinbox.api.snapshot_store import get_snapshot
from ghinbox.digest.store import get_digest_state
from ghinbox.digest.worker import (
    digest_profiles,
    is_digest_running,
    schedule_digest_update,
)

router = APIRouter(prefix="/api/digest", tags=["digest"])


def _item_summary(notification: dict[str, Any]) -> dict[str, Any]:
    subject = notification.get("subject") or {}
    repo = (notification.get("repository") or {}).get("full_name")
    number = subject.get("number")
    url = subject.get("url")
    if not url and repo and number:
        path = "pull" if subject.get("type") == "PullRequest" else "issues"
        url = f"https://github.com/{repo}/{path}/{number}"
    return {
        "id": str(notification.get("id")),
        "title": subject.get("title"),
        "url": url,
        "repo": repo,
        "number": number,
        "type": subject.get("type"),
        "state": subject.get("state"),
        "updated_at": notification.get("updated_at"),
    }


def build_digest_response(profile: str) -> dict[str, Any]:
    """Join the stored digest with the current snapshot's item metadata.

    Items that are no longer in the snapshot are dropped; the client further
    filters against its own live list (which reflects marks-done immediately).
    """
    state = get_digest_state(profile)
    snapshot = get_snapshot(f"profile:{profile}") or {}
    by_id = {
        str(n.get("id")): n for n in snapshot.get("notifications") or [] if n.get("id")
    }
    digest = state.get("digest") or {}
    look_at = [
        {**_item_summary(by_id[entry["id"]]), "why": entry.get("why", "")}
        for entry in digest.get("look_at") or []
        if entry.get("id") in by_id
    ]
    vibe = [
        {
            "title": theme.get("title", ""),
            "text": theme.get("text", ""),
            "examples": [
                _item_summary(by_id[example_id])
                for example_id in theme.get("example_ids") or []
                if example_id in by_id
            ],
        }
        for theme in digest.get("vibe") or []
    ]
    running = is_digest_running(profile)
    return {
        "profile": profile,
        "enabled": profile in digest_profiles(),
        "status": "running" if running else state.get("status", "idle"),
        "error": state.get("error"),
        "composed_at": state.get("composed_at"),
        "pending_count": state.get("pending_count", 0),
        "counts": state.get("counts") or {},
        "snapshot_synced_at": snapshot.get("synced_at"),
        "look_at": look_at,
        "vibe": vibe,
    }


@router.get("/{profile}")
async def get_digest(profile: str) -> dict[str, Any]:
    return build_digest_response(profile)


@router.post("/{profile}/run")
async def run_digest(profile: str) -> dict[str, Any]:
    if get_snapshot(f"profile:{profile}") is None:
        raise HTTPException(
            status_code=404, detail=f"No server snapshot for profile {profile!r}"
        )
    started = schedule_digest_update(profile)
    return {"started": started, "status": "running"}
