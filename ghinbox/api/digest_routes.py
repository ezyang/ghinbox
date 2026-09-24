"""Read/trigger endpoints for the background feed digest."""

from typing import Any

from fastapi import APIRouter, HTTPException

from ghinbox.api.snapshot_store import get_snapshot
from ghinbox.digest.feed import item_summary
from ghinbox.digest.store import get_digest_state, get_item_notes
from ghinbox.digest.worker import (
    digest_profiles,
    is_digest_running,
    schedule_digest_update,
)

router = APIRouter(prefix="/api/digest", tags=["digest"])


def build_digest_response(profile: str) -> dict[str, Any]:
    """Join the stored digest with item metadata.

    "Look at these" only lists items still in the snapshot (the client further
    filters against its live list, which reflects marks-done immediately).
    Vibe examples may also be items the worker auto-marked done; those render
    from the metadata saved with their notes.
    """
    state = get_digest_state(profile)
    snapshot = get_snapshot(f"profile:{profile}") or {}
    live = {
        str(n.get("id")): item_summary(n)
        for n in snapshot.get("notifications") or []
        if n.get("id")
    }
    auto_done = {
        nid: note["item"]
        for nid, note in get_item_notes(profile).items()
        if note.get("archived_at") and note.get("item")
    }
    known = {**auto_done, **live}
    digest = state.get("digest") or {}
    look_at = [
        {**live[entry["id"]], "why": entry.get("why", "")}
        for entry in digest.get("look_at") or []
        if entry.get("id") in live
    ]
    vibe = [
        {
            "title": theme.get("title", ""),
            "text": theme.get("text", ""),
            "examples": [
                known[example_id]
                for example_id in theme.get("example_ids") or []
                if example_id in known
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
        "auto_done": state.get("auto_done"),
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
