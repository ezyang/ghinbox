#!/usr/bin/env python3
"""
Harvest real Dr. CI / mergebot / ghstack text for the Ship pane's tests.

Per SOUL.md axiom 4, the Ship pane's parsers are tested against what GitHub
bots actually post, not against our guesses. This pulls the named comments
from live pytorch/pytorch PRs over the server's debug socket (read-only REST
calls through the token proxy) and freezes them under e2e/fixtures/ship/.

Re-running overwrites the fixtures with the PRs' current comments, which may
have moved on (Dr. CI edits its comment in place), so update the SAMPLES
table to PRs that show each shape before re-harvesting.

Usage (repo root, server running):

    uv run python scripts/harvest_ship_fixtures.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import httpx

DEFAULT_SOCKET_PATH = "auth_state/ghinbox-debug.sock"
OUT_DIR = Path("e2e/fixtures/ship")
REPO = "pytorch/pytorch"

DRCI_MARKER = "<!-- drci-comment-start -->"

# fixture name -> (PR number, what to extract)
#   drci: the Dr. CI status comment
#   mergebot:<prefix>: the newest pytorchmergebot comment starting with prefix
#   body: the PR description (ghstack stack list)
SAMPLES: dict[str, tuple[int, str]] = {
    "drci-no-failures": (200188, "drci"),
    "drci-pending": (200193, "drci"),
    "drci-merge-normally-flaky": (200106, "drci"),
    "drci-new-failure": (200100, "drci"),
    "drci-cancelled-pending": (200189, "drci"),
    "drci-broken-trunk": (196019, "drci"),
    "drci-unstable": (198515, "drci"),
    "drci-unclassified": (195800, "drci"),
    "drci-ai-suppressed": (200102, "drci"),
    "drci-crcr": (189413, "drci"),
    "drci-sev": (166813, "drci"),
    "drci-new-and-broken-trunk": (192082, "drci"),
    "drci-stack-too-deep": (200218, "drci"),
    "mergebot-failed-label": (
        195800,
        "mergebot:## Merge failed\n**Reason**: This PR needs a `release notes:` label",
    ),
    "mergebot-failed-job": (200103, "mergebot:## Merge failed"),
    "mergebot-started": (200103, "mergebot:### Merge started"),
    "mergebot-stack-merge": (200167, "mergebot:Starting merge as part of PR stack"),
    "ghstack-body": (200189, "body"),
}


def _client(socket_path: str) -> httpx.Client:
    transport = httpx.HTTPTransport(uds=socket_path)
    return httpx.Client(transport=transport, base_url="http://ghinbox", timeout=60)


def _comments(client: httpx.Client, number: int) -> list[dict]:
    comments: list[dict] = []
    # Bounded walk: the newest mergebot comment can be past page one.
    for page in range(1, 6):
        resp = client.get(
            f"/github/rest/repos/{REPO}/issues/{number}/comments",
            params={"per_page": 100, "page": page},
        )
        resp.raise_for_status()
        batch = resp.json()
        comments.extend(batch)
        if len(batch) < 100:
            break
    return comments


def _extract(client: httpx.Client, number: int, kind: str) -> str:
    if kind == "body":
        resp = client.get(f"/github/rest/repos/{REPO}/pulls/{number}")
        resp.raise_for_status()
        return resp.json()["body"] or ""
    comments = _comments(client, number)
    if kind == "drci":
        matches = [c for c in comments if DRCI_MARKER in (c.get("body") or "")]
    else:
        prefix = kind.split(":", 1)[1]
        matches = [
            c
            for c in comments
            if (c.get("user") or {}).get("login") == "pytorchmergebot"
            and (c.get("body") or "").lstrip().startswith(prefix)
        ]
    if not matches:
        raise SystemExit(f"#{number}: no comment matching {kind!r}")
    return matches[-1]["body"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--socket", default=DEFAULT_SOCKET_PATH)
    parser.add_argument("names", nargs="*", help="only harvest these samples")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with _client(args.socket) as client:
        for name, (number, kind) in SAMPLES.items():
            if args.names and name not in args.names:
                continue
            text = _extract(client, number, kind)
            (OUT_DIR / f"{name}.md").write_text(text)
            print(f"{name}: #{number} ({len(text)} chars)")


if __name__ == "__main__":
    main()
