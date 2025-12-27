"""
Fixture management CLI for test HTML and JSON files.

This module provides commands to manage test fixtures:
- list: Show available response files that can become fixtures
- update: Copy latest responses to tests/fixtures/ with stable names
- generate-e2e: Generate E2E JSON fixtures from HTML fixtures

Usage:
    python -m ghsim.fixtures list
    python -m ghsim.fixtures update [--force]
    python -m ghsim.fixtures generate-e2e [--force]
"""

import argparse
import difflib
import json
import re
import shutil
import sys
from pathlib import Path

from ghsim.parser.notifications import parse_notifications_html

# Directories
RESPONSES_DIR = Path("responses")
FIXTURES_DIR = Path("tests/fixtures")
E2E_FIXTURES_DIR = Path("e2e/fixtures")

# Mapping from response file patterns to fixture names
# Pattern -> fixture name (without extension)
# Timestamp format: YYYYMMDD_HHMMSS
FIXTURE_MAPPING = {
    r"pagination_page1_\d{8}_\d{6}\.html": "pagination_page1",
    r"pagination_page2_\d{8}_\d{6}\.html": "pagination_page2",
    r"html_before_done_\d{8}_\d{6}\.html": "notification_before_done",
    r"html_after_done_\d{8}_\d{6}\.html": "notification_after_done",
    r"notifications_html_\d{8}_\d{6}\.html": "notifications_inbox",
}

# Mapping from HTML fixtures to E2E JSON fixtures
# HTML fixture name -> (E2E JSON fixture name, owner, repo)
# owner/repo are used for parsing; use "fixture" as placeholder
E2E_FIXTURE_MAPPING: dict[str, tuple[str, str, str]] = {
    "pagination_page1.html": ("notifications_pagination_page1.json", "fixture", "repo"),
    "pagination_page2.html": ("notifications_pagination_page2.json", "fixture", "repo"),
    "notification_before_done.html": (
        "notifications_before_done.json",
        "fixture",
        "repo",
    ),
    "notification_after_done.html": (
        "notifications_after_done.json",
        "fixture",
        "repo",
    ),
    "notifications_inbox.html": ("notifications_inbox.json", "fixture", "repo"),
}


def find_latest_response(pattern: str) -> Path | None:
    """Find the most recent response file matching the pattern."""
    if not RESPONSES_DIR.exists():
        return None

    regex = re.compile(pattern)
    matches = [f for f in RESPONSES_DIR.iterdir() if regex.match(f.name)]

    if not matches:
        return None

    # Sort by modification time, newest first
    matches.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return matches[0]


def list_responses() -> None:
    """List available response files and their fixture mappings."""
    print("Available response files:")
    print("=" * 60)

    if not RESPONSES_DIR.exists():
        print(f"  (responses directory not found: {RESPONSES_DIR})")
        return

    # Group files by fixture mapping
    for pattern, fixture_name in FIXTURE_MAPPING.items():
        latest = find_latest_response(pattern)
        fixture_path = FIXTURES_DIR / f"{fixture_name}.html"

        print(f"\n{fixture_name}.html:")
        print(f"  Pattern: {pattern}")

        if latest:
            print(f"  Latest:  {latest.name}")
            print(f"           (modified: {latest.stat().st_mtime})")
        else:
            print("  Latest:  (no matching files)")

        if fixture_path.exists():
            print(f"  Fixture: EXISTS ({fixture_path.stat().st_size} bytes)")
        else:
            print("  Fixture: NOT YET CREATED")

    # Also list any unmatched HTML files
    all_html = list(RESPONSES_DIR.glob("*.html"))
    matched_files = set()

    for pattern in FIXTURE_MAPPING:
        regex = re.compile(pattern)
        matched_files.update(f for f in all_html if regex.match(f.name))

    unmatched = [f for f in all_html if f not in matched_files]

    if unmatched:
        print("\n" + "-" * 60)
        print("Other HTML files (no fixture mapping):")
        for f in sorted(unmatched, key=lambda x: x.stat().st_mtime, reverse=True)[:10]:
            print(f"  {f.name}")


def show_diff(old_path: Path, new_path: Path) -> bool:
    """Show diff between old and new file. Returns True if different."""
    if not old_path.exists():
        print(f"  (new file, {new_path.stat().st_size} bytes)")
        return True

    old_content = old_path.read_text().splitlines(keepends=True)
    new_content = new_path.read_text().splitlines(keepends=True)

    if old_content == new_content:
        print("  (no changes)")
        return False

    # Show abbreviated diff
    diff = list(
        difflib.unified_diff(
            old_content[:50],
            new_content[:50],
            fromfile=str(old_path),
            tofile=str(new_path),
            lineterm="",
        )
    )

    if diff:
        print("  Changes (first 50 lines):")
        for line in diff[:20]:
            print(f"    {line.rstrip()}")
        if len(diff) > 20:
            print(f"    ... ({len(diff) - 20} more diff lines)")

    return True


def update_fixtures(force: bool = False) -> None:
    """Update test fixtures from latest response files."""
    print("Updating test fixtures from responses/")
    print("=" * 60)

    # Ensure fixtures directory exists
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    updates: list[tuple[Path, Path]] = []

    for pattern, fixture_name in FIXTURE_MAPPING.items():
        latest = find_latest_response(pattern)
        fixture_path = FIXTURES_DIR / f"{fixture_name}.html"

        print(f"\n{fixture_name}.html:")

        if not latest:
            print("  SKIP: No source file found")
            continue

        print(f"  From: {latest.name}")

        has_changes = show_diff(fixture_path, latest)

        if has_changes:
            updates.append((latest, fixture_path))

    if not updates:
        print("\n" + "-" * 60)
        print("No updates needed.")
        return

    print("\n" + "-" * 60)
    print(f"Files to update: {len(updates)}")

    if not force:
        response = input("\nProceed with update? [y/N] ")
        if response.lower() != "y":
            print("Aborted.")
            return

    # Perform updates
    for src, dst in updates:
        shutil.copy2(src, dst)
        print(f"  Updated: {dst.name}")

    print(f"\nUpdated {len(updates)} fixture(s).")


def generate_e2e_fixtures(force: bool = False) -> None:
    """Generate E2E JSON fixtures from HTML fixtures."""
    print("Generating E2E JSON fixtures from HTML fixtures")
    print("=" * 60)

    # Ensure E2E fixtures directory exists
    E2E_FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    updates: list[tuple[Path, Path, str]] = []  # (html_src, json_dst, json_content)

    for html_name, (json_name, owner, repo) in E2E_FIXTURE_MAPPING.items():
        html_path = FIXTURES_DIR / html_name
        json_path = E2E_FIXTURES_DIR / json_name

        print(f"\n{html_name} -> {json_name}:")

        if not html_path.exists():
            print(f"  SKIP: Source HTML fixture not found: {html_path}")
            continue

        # Parse HTML to get JSON
        html_content = html_path.read_text()
        try:
            parsed = parse_notifications_html(
                html=html_content,
                owner=owner,
                repo=repo,
            )
            json_content = json.dumps(
                parsed.model_dump(mode="json"),
                indent=2,
                default=str,
            )
        except Exception as e:
            print(f"  ERROR: Failed to parse HTML: {e}")
            continue

        # Check for changes
        if json_path.exists():
            existing_content = json_path.read_text()
            if existing_content == json_content:
                print("  (no changes)")
                continue
            else:
                # Show summary of changes
                existing_data = json.loads(existing_content)
                new_data = json.loads(json_content)
                old_count = len(existing_data.get("notifications", []))
                new_count = len(new_data.get("notifications", []))
                print(f"  Changes: {old_count} -> {new_count} notifications")
        else:
            parsed_data = json.loads(json_content)
            notif_count = len(parsed_data.get("notifications", []))
            print(f"  (new file, {notif_count} notifications)")

        updates.append((html_path, json_path, json_content))

    if not updates:
        print("\n" + "-" * 60)
        print("No updates needed.")
        return

    print("\n" + "-" * 60)
    print(f"Files to generate: {len(updates)}")

    if not force:
        response = input("\nProceed with generation? [y/N] ")
        if response.lower() != "y":
            print("Aborted.")
            return

    # Perform updates
    for html_src, json_dst, json_content in updates:
        json_dst.write_text(json_content)
        print(f"  Generated: {json_dst.name}")

    print(f"\nGenerated {len(updates)} E2E fixture(s).")


def main() -> int:
    """Main entry point for fixture management CLI."""
    parser = argparse.ArgumentParser(
        description="Manage test fixtures for HTML notifications parser",
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # list command
    subparsers.add_parser("list", help="List available response files")

    # update command
    update_parser = subparsers.add_parser(
        "update", help="Update fixtures from responses"
    )
    update_parser.add_argument(
        "--force", "-f", action="store_true", help="Skip confirmation prompt"
    )

    # generate-e2e command
    generate_parser = subparsers.add_parser(
        "generate-e2e", help="Generate E2E JSON fixtures from HTML fixtures"
    )
    generate_parser.add_argument(
        "--force", "-f", action="store_true", help="Skip confirmation prompt"
    )

    args = parser.parse_args()

    if args.command == "list":
        list_responses()
    elif args.command == "update":
        update_fixtures(force=args.force)
    elif args.command == "generate-e2e":
        generate_e2e_fixtures(force=args.force)
    else:
        parser.print_help()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
