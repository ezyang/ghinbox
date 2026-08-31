"""Shared GitHub API request headers."""

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
