import os
from pathlib import Path

import pytest

from ghinbox.api.server import _iter_reload_files, _load_env_file


def test_stat_reload_watches_web_source_files(tmp_path: Path) -> None:
    watched = [
        tmp_path / "ghinbox" / "api" / "server.py",
        tmp_path / "ghinbox" / "webapp" / "notifications.html",
        tmp_path / "ghinbox" / "webapp" / "styles.css",
        tmp_path / "ghinbox" / "webapp" / "app.js",
    ]
    ignored = [
        tmp_path / "logs" / "ghinbox.log",
        tmp_path / ".venv" / "lib" / "dependency.py",
        tmp_path / "ghinbox" / "webapp" / "notes.txt",
    ]

    for path in watched + ignored:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")

    reloaded_paths = set(_iter_reload_files([tmp_path]))

    assert reloaded_paths == {path.resolve() for path in watched}


def test_load_env_file_reads_private_launch_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "ghinbox.env"
    env_file.write_text(
        "\n".join(
            [
                "# Local deployment values",
                "GHINBOX_SITE_PASSWORD=site-secret",
                "GHINBOX_WEBHOOK_SECRET=hook-secret",
                "GHINBOX_WEBHOOK_REPOSITORY=ezyang/ghinbox",
            ]
        ),
        encoding="utf-8",
    )
    env_file.chmod(0o600)

    _load_env_file(env_file)

    assert os.environ["GHINBOX_SITE_PASSWORD"] == "site-secret"
    assert os.environ["GHINBOX_WEBHOOK_SECRET"] == "hook-secret"
    assert os.environ["GHINBOX_WEBHOOK_REPOSITORY"] == "ezyang/ghinbox"


def test_load_env_file_does_not_override_explicit_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "ghinbox.env"
    env_file.write_text("GHINBOX_WEBHOOK_SECRET=file-secret\n", encoding="utf-8")
    env_file.chmod(0o600)
    monkeypatch.setenv("GHINBOX_WEBHOOK_SECRET", "explicit-secret")

    _load_env_file(env_file)

    assert os.environ["GHINBOX_WEBHOOK_SECRET"] == "explicit-secret"


def test_load_env_file_rejects_permissions_readable_by_others(tmp_path: Path) -> None:
    env_file = tmp_path / "ghinbox.env"
    env_file.write_text("GHINBOX_WEBHOOK_SECRET=hook-secret\n", encoding="utf-8")
    env_file.chmod(0o644)

    with pytest.raises(RuntimeError, match="must not be accessible"):
        _load_env_file(env_file)
