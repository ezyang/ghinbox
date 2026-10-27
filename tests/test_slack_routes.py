import json
import shlex
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ghinbox.api import slack_routes
from ghinbox.api.app import app

# Stands in for `meta`: records argv and stdin, answers like the real CLI.
FAKE_CLI = """
import json, sys
args = sys.argv[1:]
log = {"args": args, "stdin": sys.stdin.read() if "--markdown=file://-" in args else None}
with open(LOG_PATH, "a") as handle:
    handle.write(json.dumps(log) + "\\n")
if "--user=nobody" in args:
    print(json.dumps({"status": "error", "message": "no Slack user for nobody"}), file=sys.stderr)
    sys.exit(1)
sql = next((arg[6:] for arg in args if arg.startswith("--sql=")), "")
if args[:2] == ["presto.query", "execute"] and "pull_request_reviews" in sql:
    ids = {"alband": "465", "malfet": "320", "huydhn": "103"}
    rows = [{"author_username": login, "author_github_user_id": fbid} for login, fbid in ids.items() if f"'{login}'" in sql]
    print(json.dumps({"data": rows, "query_url": "https://x"}))
elif args[:2] == ["presto.query", "execute"]:
    links = {"465": "1215437703", "320": "705390770"}
    rows = [{"employee_fbid": employee} for account, employee in links.items() if f"({account})" in sql]
    print(json.dumps({"data": rows}))
elif args[:2] == ["people.profile", "get"]:
    profiles = {
        "--id=1215437703": {"name": "Alban Desmaison", "unixname": "albandes", "status": "current", "githubUsername": "albanD"},
        "--id=705390770": {"name": "Nikita Shulga", "unixname": "nshulga", "status": "former", "githubUsername": "malfet"},
    }
    print(json.dumps(profiles[args[2]]))
elif args[:2] == ["slack.user", "describe"]:
    print(json.dumps({"user_id": "U1", "unixname": "nshulga", "real_name": "Nikita Shulga", "display_name": "Nikita"}))
else:
    print(json.dumps({"ok": True, "ts": "1700000000.000100"}))
"""


@pytest.fixture
def fake_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(slack_routes, "_employee_cache", {})
    log_path = tmp_path / "calls.jsonl"
    script = tmp_path / "fake_meta.py"
    script.write_text(f"LOG_PATH = {str(log_path)!r}\n{FAKE_CLI}")
    monkeypatch.setenv(
        "GHINBOX_SLACK_COMMAND",
        f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}",
    )
    return log_path


def _calls(log_path: Path) -> list[dict]:
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text().splitlines()]


def test_describe_user_returns_slack_identity(fake_cli: Path) -> None:
    response = TestClient(app).get("/api/slack/user", params={"user": "nshulga"})
    assert response.status_code == 200
    assert response.json() == {
        "user_id": "U1",
        "unixname": "nshulga",
        "real_name": "Nikita Shulga",
        "display_name": "Nikita",
    }
    assert _calls(fake_cli)[0]["args"][:3] == [
        "slack.user",
        "describe",
        "--user=nshulga",
    ]


def test_describe_unknown_user_reports_cli_error(fake_cli: Path) -> None:
    response = TestClient(app).get("/api/slack/user", params={"user": "nobody"})
    assert response.status_code == 502
    assert response.json()["detail"] == "no Slack user for nobody"


def test_ping_sends_markdown_on_stdin_as_a_dm(fake_cli: Path) -> None:
    response = TestClient(app).post(
        "/api/slack/ping",
        json={"to": "nshulga", "markdown": "Hi! [pytorch#1](https://x) needs you"},
    )
    assert response.status_code == 200
    assert response.json()["to"] == "nshulga"
    assert _calls(fake_cli) == [
        {
            "args": [
                "slack.message",
                "send",
                "--to=nshulga",
                "--markdown=file://-",
                "--no-message-suffix",
                "--output=json",
            ],
            "stdin": "Hi! [pytorch#1](https://x) needs you",
        }
    ]


@pytest.mark.parametrize("to", ["#general", "-v", "https://meta.slack.com/x", ""])
def test_ping_only_goes_to_a_unixname(fake_cli: Path, to: str) -> None:
    response = TestClient(app).post(
        "/api/slack/ping", json={"to": to, "markdown": "hi"}
    )
    assert response.status_code == 400
    assert _calls(fake_cli) == []


def test_test_mode_without_a_configured_command_never_sends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GHINBOX_SLACK_COMMAND", raising=False)
    monkeypatch.setenv("GHINBOX_TEST_MODE", "1")
    response = TestClient(app).post(
        "/api/slack/ping", json={"to": "nshulga", "markdown": "hi"}
    )
    assert response.status_code == 503


def test_github_login_maps_to_linked_employee(fake_cli: Path) -> None:
    client = TestClient(app)
    response = client.get("/api/slack/github-user", params={"login": "albanD"})
    assert response.status_code == 200
    assert response.json() == {
        "login": "albanD",
        "unixname": "albandes",
        "name": "Alban Desmaison",
        "status": "current",
        "github_username": "albanD",
    }
    assert [call["args"][:2] for call in _calls(fake_cli)] == [
        ["presto.query", "execute"],
        ["presto.query", "execute"],
        ["people.profile", "get"],
    ]
    # Cached: asking again runs nothing.
    assert (
        client.get("/api/slack/github-user", params={"login": "albanD"}).json()[
            "unixname"
        ]
        == "albandes"
    )
    assert len(_calls(fake_cli)) == 3


def test_github_login_of_former_employee_reports_status(fake_cli: Path) -> None:
    response = TestClient(app).get("/api/slack/github-user", params={"login": "malfet"})
    assert response.json()["unixname"] == "nshulga"
    assert response.json()["status"] == "former"


@pytest.mark.parametrize("login", ["huydhn", "nobody-here"])
def test_github_login_without_linked_employee_is_404(
    fake_cli: Path, login: str
) -> None:
    response = TestClient(app).get("/api/slack/github-user", params={"login": login})
    assert response.status_code == 404
    assert response.json()["detail"] == f"No Meta employee is linked to @{login}"


@pytest.mark.parametrize("login", ["x' OR '1'='1", "a b", "-flag", ""])
def test_github_login_must_be_a_login(fake_cli: Path, login: str) -> None:
    response = TestClient(app).get("/api/slack/github-user", params={"login": login})
    assert response.status_code == 400
    assert _calls(fake_cli) == []
