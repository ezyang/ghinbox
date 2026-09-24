"""Tests for GitHub token loading."""

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from ghinbox import token as token_module
from ghinbox.api import github_proxy
from ghinbox.token import (
    clear_command_token_cache,
    command_token_status,
    load_command_token,
)


@pytest.fixture(autouse=True)
def _fresh_token_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    monkeypatch.setattr(token_module, "TOKEN_DIR", tmp_path)
    monkeypatch.delenv("GHINBOX_TOKEN_COMMAND", raising=False)
    clear_command_token_cache()
    yield
    clear_command_token_cache()


def _python_command(code: str) -> str:
    return f'{sys.executable} -c "{code}"'


def test_get_token_prefers_token_command_over_classic_pat_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "default.token").write_text("ghp_classic\n")
    monkeypatch.setenv("GHINBOX_ACCOUNT", "default")
    assert github_proxy.get_token() == "ghp_classic"

    monkeypatch.setenv("GHINBOX_TOKEN_COMMAND", _python_command("print('gho_oauth')"))

    assert github_proxy.get_token() == "gho_oauth"
    assert command_token_status() == {
        "configured": True,
        "command": _python_command("print('gho_oauth')"),
        "ok": True,
        "error": None,
    }


def test_failing_token_command_falls_back_to_classic_pat_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "default.token").write_text("ghp_classic\n")
    monkeypatch.setenv("GHINBOX_ACCOUNT", "default")
    monkeypatch.setenv(
        "GHINBOX_TOKEN_COMMAND",
        _python_command("import sys; sys.exit('not logged in')"),
    )

    assert github_proxy.get_token() == "ghp_classic"
    status = command_token_status()
    assert status["ok"] is False
    assert status["error"] == "exit 1: not logged in"


def test_token_command_is_unused_without_a_live_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Test-mode servers drop GHINBOX_ACCOUNT so they can never reach GitHub;
    # a token command in the launch env must not undo that.
    monkeypatch.delenv("GHINBOX_ACCOUNT", raising=False)
    monkeypatch.setenv("GHINBOX_TOKEN_COMMAND", _python_command("print('gho_oauth')"))

    assert github_proxy.get_token() is None


def test_token_command_result_is_cached_until_ttl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    counter = tmp_path / "runs"
    code = (
        "import pathlib; p = pathlib.Path(r'{path}'); "
        "n = len(p.read_text()) if p.exists() else 0; "
        "p.write_text('x' * (n + 1)); print(f'gho_{{n}}')"
    ).format(path=counter)
    monkeypatch.setenv("GHINBOX_TOKEN_COMMAND", _python_command(code))
    now = [1000.0]
    monkeypatch.setattr(token_module.time, "monotonic", lambda: now[0])

    assert load_command_token() == "gho_0"
    now[0] += token_module.TOKEN_COMMAND_TTL_SECONDS - 1
    assert load_command_token() == "gho_0"
    now[0] += 2
    assert load_command_token() == "gho_1"
