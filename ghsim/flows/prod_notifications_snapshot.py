"""
Prod notifications snapshot flow - capture notifications HTML/JSON without side effects.

This flow:
1. Validates auth for the owner account (trigger account may be the same).
2. Fetches notifications HTML for a repo via authenticated session.
3. Parses HTML to JSON and saves both to responses/.
"""

from __future__ import annotations

from ghsim.api.fetcher import NotificationsFetcher
from ghsim.flows.base import BaseFlow
from ghsim.github_api import save_response, RESPONSES_DIR
from ghsim.parser.notifications import (
    parse_notifications_html,
    extract_authenticity_token,
)


class ProdNotificationsSnapshotFlow(BaseFlow):
    """Capture production notifications HTML/JSON without mutating GitHub state."""

    name = "prod_notifications_snapshot"
    description = "Capture notifications HTML/JSON for an existing repo (read-only)"

    def __init__(
        self,
        owner_account: str,
        trigger_account: str,
        headless: bool = True,
        cleanup: bool = True,
        repo: str | None = None,
        pages: int = 1,
    ):
        super().__init__(owner_account, trigger_account, headless, cleanup)
        self.repo = repo or ""
        self.pages = max(pages, 1)

    def run(self) -> bool:
        if not self.validate_prerequisites():
            return False

        repo = self._parse_repo(self.repo)
        if repo is None:
            print("ERROR: --repo is required (owner/repo)")
            return False

        owner, repo_name = repo
        repo_slug = f"{owner}_{repo_name}"

        print(f"\n{'=' * 60}")
        print("Capturing notifications HTML/JSON (read-only)")
        print(f"{'=' * 60}")
        print(f"Repo: {owner}/{repo_name}")
        print(f"Pages: {self.pages}")

        after_cursor = None
        captured = 0
        tokens: list[tuple[int, str]] = []  # (page_num, token)

        with NotificationsFetcher(
            account=self.owner_account, headless=self.headless
        ) as fetcher:
            for page_num in range(1, self.pages + 1):
                result = fetcher.fetch_repo_notifications(
                    owner=owner,
                    repo=repo_name,
                    after=after_cursor,
                )
                if result.status != "ok":
                    print(f"ERROR: Failed to fetch notifications: {result.error}")
                    return False

                html_path = save_response(
                    f"prod_notifications_{repo_slug}_page{page_num}",
                    result.html,
                    "html",
                )
                parsed = parse_notifications_html(
                    html=result.html,
                    owner=owner,
                    repo=repo_name,
                    source_url=result.url,
                )
                json_path = save_response(
                    f"prod_notifications_{repo_slug}_page{page_num}",
                    parsed.model_dump(mode="json"),
                    "json",
                )

                # Extract authenticity_token for verification
                token = extract_authenticity_token(result.html)
                if token:
                    tokens.append((page_num, token))
                    print(f"  Page {page_num} token: {token[:20]}...")
                else:
                    print(f"  Page {page_num} token: NOT FOUND")

                print(f"  Page {page_num} HTML: {html_path}")
                print(f"  Page {page_num} JSON: {json_path}")
                captured += 1

                if not parsed.pagination.has_next or not parsed.pagination.after_cursor:
                    break
                after_cursor = parsed.pagination.after_cursor

        print(f"\nSaved {captured} page(s) to: {RESPONSES_DIR}")

        # Report on token stability across pages
        if len(tokens) > 1:
            first_token = tokens[0][1]
            all_same = all(t[1] == first_token for t in tokens)
            print("\nAuthenticity token stability check:")
            print(f"  Pages compared: {len(tokens)}")
            print(f"  All tokens identical: {all_same}")
            if not all_same:
                print("  Token values per page:")
                for page_num, token in tokens:
                    print(f"    Page {page_num}: {token[:40]}...")
        elif len(tokens) == 1:
            print("\nAuthenticity token captured (single page):")
            print(f"  Token: {tokens[0][1][:40]}...")
        return True

    def _parse_repo(self, value: str) -> tuple[str, str] | None:
        trimmed = value.strip()
        if not trimmed:
            return None
        parts = trimmed.split("/")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            return None
        return parts[0], parts[1]
