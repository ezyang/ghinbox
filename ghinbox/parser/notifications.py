"""
Parser for GitHub notifications HTML pages.

Extracts structured notification data from the HTML rendered by
https://github.com/notifications?query=repo:owner/name
"""

import re
from datetime import datetime
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from ghinbox.api.models import (
    Actor,
    Notification,
    NotificationsResponse,
    Pagination,
    Repository,
    Subject,
    UIState,
)

# Map octicon classes to (type, state, state_reason)
ICON_STATE_MAP: dict[str, tuple[str, str | None, str | None]] = {
    "octicon-issue-opened": ("Issue", "open", None),
    "octicon-issue-closed": ("Issue", "closed", "completed"),
    "octicon-skip": ("Issue", "closed", "not_planned"),
    "octicon-git-merge": ("PullRequest", "merged", None),
    "octicon-git-pull-request": ("PullRequest", "open", None),
    "octicon-git-pull-request-closed": ("PullRequest", "closed", None),
    "octicon-git-pull-request-draft": ("PullRequest", "draft", None),
    "octicon-discussion-closed": ("Discussion", "closed", "resolved"),
    "octicon-comment-discussion": ("Discussion", "open", None),
    "octicon-git-commit": ("Commit", None, None),
    "octicon-tag": ("Release", None, None),
}


def parse_notifications_html(
    html: str,
    owner: str,
    repo: str,
    source_url: str | None = None,
) -> NotificationsResponse:
    """
    Parse GitHub notifications HTML and return structured data.

    Args:
        html: The raw HTML content of the notifications page
        owner: Repository owner
        repo: Repository name
        source_url: The URL that was fetched (for the response)

    Returns:
        NotificationsResponse with parsed notifications and pagination
    """
    soup = BeautifulSoup(html, "lxml")

    notifications = _parse_notification_items(soup)
    pagination = _parse_pagination(soup)
    token = _extract_authenticity_token(soup)

    if source_url is None:
        source_url = f"https://github.com/notifications?query=repo:{owner}/{repo}"

    return NotificationsResponse(
        source_url=source_url,
        generated_at=datetime.now(),
        repository=Repository(
            owner=owner,
            name=repo,
            full_name=f"{owner}/{repo}",
        ),
        notifications=notifications,
        pagination=pagination,
        authenticity_token=token,
    )


def _parse_notification_items(soup: BeautifulSoup) -> list[Notification]:
    """Parse all notification list items from the page."""
    notifications: list[Notification] = []

    # Find all notification list items
    items = soup.select("li.notifications-list-item[data-notification-id]")

    for index, item in enumerate(items):
        try:
            notification = _parse_single_notification(item)
        except Exception as e:
            raise ValueError(
                f"Failed to parse notification item at index {index}"
            ) from e
        if notification:
            notifications.append(notification)

    return notifications


def _parse_single_notification(item: Tag) -> Notification | None:
    """Parse a single notification list item."""
    # Get notification ID
    notification_id = item.get("data-notification-id")
    if not notification_id or not isinstance(notification_id, str):
        return None

    # Check if unread (class contains 'notification-unread')
    classes = item.get("class") or []
    if isinstance(classes, list):
        unread = "notification-unread" in classes
    else:
        unread = "notification-unread" in str(classes)

    # Extract reason (e.g., "subscribed", "author", "mention")
    reason = _extract_reason(item)

    # Extract updated_at from relative-time element
    updated_at = _extract_updated_at(item)

    # Extract subject info
    subject = _extract_subject(item)

    # Extract actors
    actors = _extract_actors(item)

    # Extract UI state
    ui = _extract_ui_state(item)
    ui.action_tokens = _extract_action_tokens(item)

    return Notification(
        id=notification_id,
        unread=unread,
        reason=reason,
        updated_at=updated_at,
        subject=subject,
        actors=actors,
        ui=ui,
    )


def _extract_reason(item: Tag) -> str:
    """Extract the notification reason (subscribed, author, etc.)."""
    # The reason is in a span with class f6 in the right side
    reason_span = item.select_one("span.f6.flex-self-center")
    if reason_span:
        return reason_span.get_text(strip=True)
    return "unknown"


def _extract_updated_at(item: Tag) -> datetime:
    """Extract the updated_at timestamp from relative-time element."""
    relative_time = item.select_one("relative-time[datetime]")
    if relative_time:
        dt_str = relative_time.get("datetime")
        if dt_str and isinstance(dt_str, str):
            # Parse ISO format datetime
            return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))

    # Fallback to now if not found
    return datetime.now()


def _extract_subject(item: Tag) -> Subject:
    """Extract subject information (title, url, type, number, state, anchor)."""
    # Find the main notification link
    link = item.select_one("a.notification-list-item-link")

    title = ""
    url = ""
    subject_type = "Unknown"
    number: int | None = None
    state: str | None = None
    state_reason: str | None = None
    anchor: str | None = None

    if link:
        href = link.get("href", "")
        if isinstance(href, str) and href:
            url = urljoin("https://github.com", href)
            parsed = urlparse(url)

            # Extract number from URL path
            number = _extract_number_from_url(parsed.path)

            # Extract anchor (fragment) - indicates first unread comment
            # e.g., "issuecomment-12345" or "discussion_r12345"
            if parsed.fragment:
                anchor = parsed.fragment

        # Get title from markdown-title element
        title_elem = link.select_one("p.markdown-title")
        if title_elem:
            title = _extract_markdown_title(title_elem)

    # Get type and state from icon
    icon = item.select_one("svg[class*='octicon-']")
    if icon:
        icon_classes = icon.get("class") or []
        if isinstance(icon_classes, list):
            for cls in icon_classes:
                if cls in ICON_STATE_MAP:
                    subject_type, state, state_reason = ICON_STATE_MAP[cls]
                    break

    return Subject(
        title=title,
        url=url,
        type=subject_type,  # type: ignore[arg-type]
        number=number,
        state=state,  # type: ignore[arg-type]
        state_reason=state_reason,  # type: ignore[arg-type]
        anchor=anchor,
    )


def _extract_markdown_title(title_elem: Tag) -> str:
    """Extract title text while preserving inline code with backticks."""
    for code_tag in title_elem.find_all("code"):
        code_text = code_tag.get_text()
        code_tag.replace_with(f"`{code_text}`")
    raw_title = title_elem.get_text()
    return " ".join(raw_title.split())


def _extract_number_from_url(path: str) -> int | None:
    """Extract issue/PR number from URL path."""
    # Pattern: /owner/repo/issues/123 or /owner/repo/pull/123
    match = re.search(r"/(?:issues|pull|discussions)/(\d+)", path)
    if match:
        return int(match.group(1))
    return None


def _extract_actors(item: Tag) -> list[Actor]:
    """Extract actor information from avatar stack."""
    actors: list[Actor] = []

    # Find avatar links in the AvatarStack
    avatar_links = item.select(".AvatarStack a.avatar[data-hovercard-url]")

    for link in avatar_links:
        href = link.get("href", "")
        if isinstance(href, str) and href.startswith("/"):
            login = href.lstrip("/")

            # Get avatar URL from img
            img = link.select_one("img")
            avatar_url = ""
            if img:
                src = img.get("src", "")
                if isinstance(src, str):
                    avatar_url = src

            if login:
                actors.append(Actor(login=login, avatar_url=avatar_url))

    return actors


def _extract_ui_state(item: Tag) -> UIState:
    """Extract UI-specific state (saved, done)."""
    saved = False
    done = False

    # Check for filled bookmark icon (saved)
    # The saved state uses octicon-bookmark-fill vs octicon-bookmark
    bookmark_fill = item.select_one("svg.octicon-bookmark-fill")
    if bookmark_fill:
        saved = True

    # Done state is not directly visible in inbox view
    # It would only be true if we're viewing the "Done" tab
    # For now, we can't determine this from the HTML alone

    return UIState(saved=saved, done=done)


def _extract_action_tokens(item: Tag) -> dict[str, str]:
    """Extract per-notification authenticity tokens for actions."""
    action_map = {
        "/notifications/beta/archive": "archive",
        "/notifications/beta/unarchive": "unarchive",
        "/notifications/beta/subscribe": "subscribe",
        "/notifications/beta/unsubscribe": "unsubscribe",
    }
    tokens: dict[str, str] = {}
    for action_path, key in action_map.items():
        form = item.select_one(f'form[action="{action_path}"]')
        if not form:
            continue
        token_input = form.select_one('input[name="authenticity_token"]')
        if not token_input:
            continue
        value = token_input.get("value")
        if isinstance(value, str):
            tokens[key] = value
    return tokens


def _parse_pagination(soup: BeautifulSoup) -> Pagination:
    """Parse pagination information from the page."""
    before_cursor: str | None = None
    after_cursor: str | None = None
    has_previous = False
    has_next = False

    # Find the pagination buttons
    # Next button: <a href="?after=CURSOR">Next</a>
    # Prev button: <a href="?before=CURSOR">Prev</a> or <button disabled>Prev</button>

    # Check for Prev link/button
    prev_link = soup.select_one('a[aria-label="Previous"]')
    prev_button = soup.select_one('button[aria-label="Previous"]')

    if prev_link:
        has_previous = True
        href = prev_link.get("href", "")
        if isinstance(href, str):
            before_cursor = _extract_cursor_from_href(href, "before")
    elif prev_button:
        # Button exists but might be disabled
        has_previous = not prev_button.has_attr("disabled")

    # Check for Next link/button
    next_link = soup.select_one('a[aria-label="Next"]')
    next_button = soup.select_one('button[aria-label="Next"]')

    if next_link:
        has_next = True
        href = next_link.get("href", "")
        if isinstance(href, str):
            after_cursor = _extract_cursor_from_href(href, "after")
    elif next_button:
        has_next = not next_button.has_attr("disabled")

    return Pagination(
        before_cursor=before_cursor,
        after_cursor=after_cursor,
        has_previous=has_previous,
        has_next=has_next,
    )


def _extract_cursor_from_href(href: str, param: str) -> str | None:
    """Extract cursor value from href query string."""
    parsed = urlparse(href)
    params = parse_qs(parsed.query)
    values = params.get(param, [])
    if values:
        return values[0]
    return None


def _extract_authenticity_token(soup: BeautifulSoup) -> str | None:
    """
    Extract an authenticity_token from a parsed notifications page.

    GitHub includes CSRF tokens in forms. We prefer the token used for
    undo-capable actions (unarchive/subscribe) since those are required
    for in-app undo requests.

    Args:
        soup: Parsed BeautifulSoup object of the notifications page

    Returns:
        The authenticity_token value, or None if not found
    """
    preferred_actions = [
        "/notifications/beta/unarchive",
        "/notifications/beta/subscribe",
    ]
    for action in preferred_actions:
        action_form = soup.select_one(f'form[action="{action}"]')
        if action_form:
            token_input = action_form.select_one('input[name="authenticity_token"]')
            if token_input:
                value = token_input.get("value")
                if isinstance(value, str):
                    return value

    # Fallback: try the bulk archive form's token (reliably present)
    bulk_form = soup.select_one('form[action="/notifications/beta/archive"]')
    if bulk_form:
        token_input = bulk_form.select_one('input[name="authenticity_token"]')
        if token_input:
            value = token_input.get("value")
            if isinstance(value, str):
                return value

    # Fallback: try any form with authenticity_token
    token_input = soup.select_one('input[name="authenticity_token"]')
    if token_input:
        value = token_input.get("value")
        if isinstance(value, str):
            return value

    return None


def extract_authenticity_token(html: str) -> str | None:
    """
    Extract an authenticity_token from the notifications page HTML.

    This is a convenience wrapper that parses the HTML first.
    For internal use where soup is already available, use _extract_authenticity_token.

    Args:
        html: The raw HTML content of the notifications page

    Returns:
        The authenticity_token value, or None if not found
    """
    soup = BeautifulSoup(html, "lxml")
    return _extract_authenticity_token(soup)
