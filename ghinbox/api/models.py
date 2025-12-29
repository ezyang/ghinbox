"""
Pydantic models for the HTML Notifications API.

These models match the unified proposal schema for repository-scoped
HTML notifications extraction.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Actor(BaseModel):
    """An actor (user) associated with a notification."""

    login: str
    avatar_url: str


class Subject(BaseModel):
    """The subject (issue, PR, discussion) of a notification."""

    title: str
    url: str
    type: Literal["Issue", "PullRequest", "Discussion", "Commit", "Release", "Unknown"]
    number: int | None = None
    state: Literal["open", "closed", "merged", "draft"] | None = None
    state_reason: Literal["completed", "not_planned", "resolved"] | None = None
    # The URL anchor indicating the first unread comment (e.g., "issuecomment-12345")
    # This is extracted from the notification link and indicates where "new" content starts.
    # None means no anchor was present (user hasn't read any comments yet).
    anchor: str | None = None


class UIState(BaseModel):
    """UI-specific state only available from HTML."""

    saved: bool = False
    done: bool = False
    action_tokens: dict[str, str] = Field(default_factory=dict)


class Notification(BaseModel):
    """A single notification extracted from HTML."""

    id: str
    unread: bool
    reason: str
    updated_at: datetime
    subject: Subject
    actors: list[Actor] = Field(default_factory=list)
    ui: UIState = Field(default_factory=UIState)


class Pagination(BaseModel):
    """Pagination information from the notifications page."""

    before_cursor: str | None = None
    after_cursor: str | None = None
    has_previous: bool = False
    has_next: bool = False


class Repository(BaseModel):
    """Repository information for the notification query."""

    owner: str
    name: str
    full_name: str


class NotificationsResponse(BaseModel):
    """Response schema for the notifications endpoint."""

    source_url: str
    generated_at: datetime
    repository: Repository
    notifications: list[Notification]
    pagination: Pagination
    # CSRF token for HTML form actions (unarchive, subscribe, etc.)
    # Any token from the page can be used for actions in the same session.
    authenticity_token: str | None = None
