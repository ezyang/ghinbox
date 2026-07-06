"""Repository key helpers shared by API routes."""


def repo_key(owner: str, repo: str) -> str:
    return f"{owner}/{repo}"
