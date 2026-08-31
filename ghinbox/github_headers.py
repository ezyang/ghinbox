"""Shared GitHub API request/response header helpers."""

GITHUB_REST_ACCEPT = "application/vnd.github+json"
GITHUB_API_VERSION = "2022-11-28"


def github_auth_headers(token: str) -> dict[str, str]:
    """Return the common bearer auth header for GitHub requests."""
    return {"Authorization": f"Bearer {token}"}


def github_rest_headers(token: str) -> dict[str, str]:
    """Return standard headers for GitHub REST API requests."""
    return {
        **github_auth_headers(token),
        "Accept": GITHUB_REST_ACCEPT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }


def github_graphql_headers(token: str) -> dict[str, str]:
    """Return headers for GitHub GraphQL requests."""
    return {
        **github_auth_headers(token),
        "Content-Type": "application/json",
    }


def next_link_url(link_header: str | None) -> str | None:
    """Extract the rel="next" URL from a Link response header."""
    if not link_header:
        return None
    for part in link_header.split(","):
        section = part.strip()
        if 'rel="next"' not in section:
            continue
        if not section.startswith("<"):
            continue
        end_index = section.find(">")
        if end_index <= 1:
            continue
        return section[1:end_index]
    return None
