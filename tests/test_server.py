from pathlib import Path

from ghinbox.api.server import _iter_reload_files


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
