"""Read/trigger endpoints for the background feed digest."""

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from ghinbox.api.snapshot_store import get_snapshot
from ghinbox.digest.feed import item_summary
from ghinbox.digest.store import get_digest_state, get_item_notes, get_llm_usage
from ghinbox.digest.worker import (
    digest_profiles,
    is_digest_running,
    next_compose_at,
    schedule_digest_update,
)

router = APIRouter(prefix="/api/digest", tags=["digest"])

LLM_USAGE_WINDOW_HOURS = 24


def build_digest_response(profile: str) -> dict[str, Any]:
    """Join the stored digest with item metadata.

    "Look at these" is the surfaced (high-attention) items still in the
    snapshot, newest first; the client further filters against its live list,
    which reflects marks-done immediately. Vibe examples may also be items the
    worker auto-marked done; those render from the metadata saved with their
    notes.
    """
    state = get_digest_state(profile)
    snapshot = get_snapshot(f"profile:{profile}") or {}
    live = {
        str(n.get("id")): item_summary(n)
        for n in snapshot.get("notifications") or []
        if n.get("id")
    }
    notes = get_item_notes(profile)
    auto_done = {
        nid: note["item"]
        for nid, note in notes.items()
        if note.get("archived_at") and note.get("item")
    }
    known = {**auto_done, **live}
    digest = state.get("digest") or {}
    look_at = sorted(
        (
            {**live[nid], "why": note.get("why") or note.get("summary") or ""}
            for nid, note in notes.items()
            if nid in live and note.get("surfaced") and not note.get("archived_at")
        ),
        key=lambda item: str(item.get("updated_at") or ""),
        reverse=True,
    )
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
        "next_compose_at": next_compose_at(state),
        "pending_count": state.get("pending_count", 0),
        "queue_count": state.get("queue_count", 0),
        "counts": state.get("counts") or {},
        "auto_done": state.get("auto_done"),
        "snapshot_synced_at": snapshot.get("synced_at"),
        "llm_usage": {
            "window_hours": LLM_USAGE_WINDOW_HOURS,
            **get_llm_usage(
                profile,
                datetime.now(timezone.utc) - timedelta(hours=LLM_USAGE_WINDOW_HOURS),
            ),
        },
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
    started = schedule_digest_update(profile, force_compose=True)
    return {"started": started, "status": "running"}
