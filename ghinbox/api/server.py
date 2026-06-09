"""
Server CLI for the HTML notifications API.

Usage:
    python -m ghinbox.api.server              # Uses default account (auto-setup on first run)
    python -m ghinbox.api.server --account X  # Uses specific account X

This starts the API server with live GitHub fetching enabled,
using the specified account's authenticated session.
"""

import argparse
import atexit
import os
import socket
import stat
import sys
import tempfile
from pathlib import Path

import uvicorn
from uvicorn import Config, Server
from uvicorn.main import STARTUP_FAILURE
from uvicorn.supervisors import ChangeReload
from uvicorn.supervisors.statreload import StatReload

from ghinbox.auth import (
    has_valid_auth,
    verify_auth,
    login_interactive,
    load_username,
    DEFAULT_ACCOUNT,
)
from ghinbox.token import has_token, provision_token, verify_token

DEFAULT_DEBUG_SOCKET_PATH = Path("auth_state") / "ghinbox-debug.sock"
DEFAULT_ENV_FILE_PATH = Path("auth_state") / "ghinbox.env"
ENV_FILE_KEYS = frozenset(
    {
        "GHINBOX_SITE_PASSWORD",
        "GHINBOX_WEBHOOK_SECRET",
        "GHINBOX_WEBHOOK_REPOSITORY",
    }
)
RELOAD_FILE_SUFFIXES = frozenset({".py", ".html", ".js", ".css"})
RELOAD_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "auth_state",
        "logs",
        "node_modules",
        "playwright-report",
        "test-results",
    }
)


def _load_env_file(path: Path) -> None:
    """Load approved deployment values from a private local environment file."""
    if not path.exists():
        return
    if path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise RuntimeError(f"Environment file must not be accessible by others: {path}")

    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = stripped.partition("=")
        if not separator or key not in ENV_FILE_KEYS or not value:
            raise RuntimeError(
                f"Invalid environment file entry at {path}:{line_number}"
            )
        os.environ.setdefault(key, value)


def _iter_reload_files(reload_dirs: list[Path]) -> list[Path]:
    """Find source files watched by the stat-based autoreloader."""
    files: list[Path] = []
    for reload_dir in reload_dirs:
        if not reload_dir.is_dir():
            continue
        for root, dirs, filenames in os.walk(reload_dir):
            dirs[:] = [
                dirname for dirname in dirs if dirname not in RELOAD_EXCLUDED_DIRS
            ]
            root_path = Path(root)
            for filename in filenames:
                path = root_path / filename
                if path.suffix in RELOAD_FILE_SUFFIXES:
                    files.append(path.resolve())
    return files


class GhinboxStatReload(StatReload):
    """Stat-based reloader that also watches web source files."""

    def iter_py_files(self):  # type: ignore[no-untyped-def]
        yield from _iter_reload_files(self.config.reload_dirs)


def _is_source_checkout() -> bool:
    """Check if running from a source checkout (has .git directory)."""
    # Look for .git in the package's parent directory
    package_dir = Path(__file__).parent.parent  # ghinbox/
    repo_root = package_dir.parent  # parent of ghinbox/
    return (repo_root / ".git").is_dir()


def _bind_debug_socket(path: Path) -> socket.socket:
    """Bind the local agent/debug Unix socket."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    if path.exists():
        mode = path.stat().st_mode
        if not stat.S_ISSOCK(mode):
            raise RuntimeError(f"Debug socket path exists and is not a socket: {path}")

        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(str(path))
        except OSError:
            path.unlink()
        else:
            raise RuntimeError(f"Debug socket is already in use: {path}")
        finally:
            probe.close()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.bind(str(path))
        os.chmod(path, 0o600)
    except OSError:
        sock.close()
        raise

    sock.set_inheritable(True)
    return sock


def _run_uvicorn(
    *,
    host: str,
    port: int,
    reload: bool,
    debug_socket_path: Path | None,
) -> None:
    """Run Uvicorn with the normal TCP listener and optional debug UDS listener."""
    if debug_socket_path is None:
        uvicorn.run(
            "ghinbox.api.app:app",
            host=host,
            port=port,
            reload=reload,
        )
        return

    os.environ["GHINBOX_DEBUG_SOCKET_ENABLED"] = "1"
    config = Config("ghinbox.api.app:app", host=host, port=port, reload=reload)
    server = Server(config=config)
    sockets: list[socket.socket] = []

    try:
        sockets.append(config.bind_socket())
        sockets.append(_bind_debug_socket(debug_socket_path))
        print(f"Debug socket: {debug_socket_path}")

        if config.should_reload:
            reload_supervisor = (
                GhinboxStatReload if ChangeReload is StatReload else ChangeReload
            )
            reload_supervisor(config, target=server.run, sockets=sockets).run()
        else:
            server.run(sockets=sockets)
    except KeyboardInterrupt:
        pass
    finally:
        for sock in sockets:
            sock.close()
        if debug_socket_path.exists():
            debug_socket_path.unlink()

    if not server.started and not config.should_reload:
        sys.exit(STARTUP_FAILURE)


def setup_default_account(headed: bool = False) -> tuple[bool, str | None]:
    """
    Set up the default account with authentication and token.

    Args:
        headed: Whether to run browser in headed mode for token provisioning

    Returns:
        Tuple of (success, username)
    """
    print("\n" + "=" * 60)
    print("First-time setup: Setting up default GitHub account")
    print("=" * 60 + "\n")

    # Step 1: Interactive login (always headed for login)
    if not has_valid_auth(DEFAULT_ACCOUNT):
        print("Step 1: GitHub Login")
        print("-" * 40)
        result = login_interactive(DEFAULT_ACCOUNT, save_username_flag=True)
        if isinstance(result, tuple):
            success, username = result
        else:
            success = result
            username = load_username(DEFAULT_ACCOUNT)

        if not success:
            print("ERROR: Login failed")
            return False, None
    else:
        username = load_username(DEFAULT_ACCOUNT)
        print(f"Auth already configured for: {username or 'default'}")

    # Step 2: Token provisioning
    if not has_token(DEFAULT_ACCOUNT):
        print("\nStep 2: GitHub API Token")
        print("-" * 40)
        token = provision_token(
            DEFAULT_ACCOUNT,
            force=False,
            headless=not headed,
            prod=True,  # Use reduced scopes for default account
        )
        if not token:
            print("ERROR: Token provisioning failed")
            return False, username
    else:
        print("Token already configured")

    print("\n" + "=" * 60)
    print("Setup complete!")
    print("=" * 60 + "\n")

    return True, username


def main() -> int:
    """Main entry point for the API server."""
    parser = argparse.ArgumentParser(
        description="Start the GitHub HTML Notifications API server",
    )
    parser.add_argument(
        "--account",
        "-a",
        help="ghinbox account name for live GitHub fetching. "
        "If not specified, uses the default account (auto-setup on first run).",
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help=(
            "Host to bind to (default: 0.0.0.0, listens on localhost and "
            "Tailnet 10.*.*.*)."
        ),
    )
    parser.add_argument(
        "--port",
        "-p",
        type=int,
        default=8000,
        help="Port to bind to (default: 8000)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        default=None,
        help="Enable auto-reload on code changes (auto-enabled in source checkouts)",
    )
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="Disable auto-reload even in source checkouts",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in headed mode (visible window)",
    )
    parser.add_argument(
        "--headed-login",
        action="store_true",
        help="Use headed browser for login (fallback for CAPTCHA or security key 2FA)",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Test mode: skip account validation (for E2E tests with mocked APIs)",
    )
    parser.add_argument(
        "--site-password",
        help="Require this password to access the site (cookie-based gate)",
    )
    parser.add_argument(
        "--env-file",
        default=str(DEFAULT_ENV_FILE_PATH),
        help=(
            "Private local environment file for site/webhook secrets "
            "(default: auth_state/ghinbox.env)."
        ),
    )
    parser.add_argument(
        "--log-file",
        default=None,
        help=(
            "Write JSONL request logs to this file "
            "(default: logs/ghinbox.log outside --test)."
        ),
    )
    parser.add_argument(
        "--no-request-log",
        action="store_true",
        help="Disable JSONL request logging. Recent in-memory requests remain enabled.",
    )
    parser.add_argument(
        "--snapshot-db-path",
        default=None,
        help="Path to SQLite database for server-side notification snapshots.",
    )
    parser.add_argument(
        "--snapshot-sync-interval-minutes",
        type=float,
        default=0,
        help=(
            "Periodically refresh repos with existing server snapshots. "
            "Disabled by default."
        ),
    )
    parser.add_argument(
        "--debug-socket",
        default=str(DEFAULT_DEBUG_SOCKET_PATH),
        help=(
            "Unix domain socket for local shell/agent HTTP access that bypasses "
            "the site password gate (default: auth_state/ghinbox-debug.sock)."
        ),
    )
    parser.add_argument(
        "--no-debug-socket",
        action="store_true",
        help="Disable the local debug Unix socket.",
    )

    args = parser.parse_args()

    try:
        _load_env_file(Path(args.env_file))
    except RuntimeError as error:
        parser.error(str(error))

    # Set env vars so the app can recreate fetcher after reload
    if args.site_password:
        os.environ["GHINBOX_SITE_PASSWORD"] = args.site_password
    if args.snapshot_db_path:
        os.environ["GHINBOX_SNAPSHOT_DB_PATH"] = args.snapshot_db_path
    if args.snapshot_sync_interval_minutes > 0:
        interval_seconds = int(args.snapshot_sync_interval_minutes * 60)
        os.environ["GHINBOX_SNAPSHOT_SYNC_INTERVAL_SECONDS"] = str(interval_seconds)
    if args.no_request_log:
        os.environ["GHINBOX_REQUEST_LOG_ENABLED"] = "0"
    else:
        os.environ["GHINBOX_REQUEST_LOG_ENABLED"] = "1"
        request_log_file = args.log_file
        if request_log_file is None and not args.test:
            request_log_file = "logs/ghinbox.log"
        if request_log_file is not None:
            os.environ["GHINBOX_REQUEST_LOG_FILE"] = request_log_file

    if args.test:
        print("Starting server in TEST MODE (no live fetching)")
        # Don't set GHINBOX_ACCOUNT - app will run without fetcher
        # Set test mode flag so /health/test endpoint works
        os.environ["GHINBOX_TEST_MODE"] = "1"
        if not args.snapshot_db_path and "GHINBOX_SNAPSHOT_DB_PATH" not in os.environ:
            # Fresh per-run DB so test runs are hermetic: no state leaks
            # between runs and concurrent runs don't share a database.
            fd, test_db_path = tempfile.mkstemp(
                prefix="ghinbox_snapshot_test_", suffix=".db"
            )
            os.close(fd)
            os.environ["GHINBOX_SNAPSHOT_DB_PATH"] = test_db_path
            print(f"Test snapshot DB: {test_db_path}")

            def _cleanup_test_db() -> None:
                for suffix in ("", "-wal", "-shm"):
                    try:
                        os.unlink(test_db_path + suffix)
                    except FileNotFoundError:
                        pass

            atexit.register(_cleanup_test_db)
    else:
        # Determine which account to use
        account = args.account or DEFAULT_ACCOUNT

        # Check if account needs setup
        if not has_valid_auth(account):
            if args.headed_login:
                # Use headed browser login (fallback for CAPTCHA/security key)
                if account == DEFAULT_ACCOUNT:
                    success, username = setup_default_account(headed=args.headed)
                    if not success:
                        return 1
                else:
                    print(f"ERROR: No valid auth for account '{account}'")
                    print(f"Run: python -m ghinbox.auth {account}")
                    return 1
            else:
                # Headless mode: start server and serve login page
                print(f"No valid auth for account '{account}'.")
                print("Starting server with web-based login...")
                print("Visit the server URL to login via browser.")
                os.environ["GHINBOX_NEEDS_AUTH"] = "1"
                os.environ["GHINBOX_ACCOUNT"] = account
                os.environ["GHINBOX_HEADLESS"] = "1"
        else:
            # Account exists, check for token
            if not has_token(account):
                if account == DEFAULT_ACCOUNT:
                    # Auto-provision token for default account
                    print("Token not found, provisioning...")
                    token = provision_token(
                        account, force=False, headless=not args.headed, prod=True
                    )
                    if not token:
                        print("ERROR: Token provisioning failed")
                        return 1
                else:
                    print(f"WARNING: No token for account '{account}'")
                    print(f"Run: python -m ghinbox.token {account}")
                    print("API proxy features will not work without a token.\n")

        # Verify the token actually works
        if has_token(account) and os.environ.get("GHINBOX_NEEDS_AUTH") != "1":
            print("Verifying GitHub token...")
            is_valid, github_login = verify_token(account)
            if not is_valid:
                print("Token is invalid or expired.")
                if account == DEFAULT_ACCOUNT:
                    # First verify browser auth is valid (needed for token provisioning)
                    print("Checking browser authentication...")
                    if not verify_auth(account):
                        if args.headed_login:
                            # Use headed browser for re-auth
                            print("Browser auth is also invalid. Re-authenticating...")
                            result = login_interactive(
                                account, force=True, save_username_flag=True
                            )
                            if isinstance(result, tuple):
                                success, _ = result
                            else:
                                success = result
                            if not success:
                                print("ERROR: Browser re-authentication failed")
                                return 1
                        else:
                            # Headless mode: redirect to web login
                            print("Browser auth is also invalid.")
                            print("Starting server with web-based login...")
                            os.environ["GHINBOX_NEEDS_AUTH"] = "1"

                    if os.environ.get("GHINBOX_NEEDS_AUTH") != "1":
                        print("Re-provisioning token (browser window will open)...")
                        token = provision_token(
                            account,
                            force=True,
                            headless=not args.headed_login,
                            prod=True,
                        )
                        if not token:
                            print("ERROR: Token re-provisioning failed")
                            return 1
                        # Verify the new token
                        is_valid, github_login = verify_token(account)
                        if not is_valid:
                            print("ERROR: New token verification failed")
                            return 1
                        print(f"Token verified for GitHub user: {github_login}")
                else:
                    print(f"Run: python -m ghinbox.token {account} --force")
                    return 1
            else:
                print(f"Token verified for GitHub user: {github_login}")

        # Show account info (only if not in needs-auth mode)
        if os.environ.get("GHINBOX_NEEDS_AUTH") != "1":
            username = load_username(account)
            if username:
                print(f"Starting server with account: {account} (GitHub: {username})")
            else:
                print(f"Starting server with account: {account}")

            os.environ["GHINBOX_ACCOUNT"] = account
            os.environ["GHINBOX_HEADLESS"] = "0" if args.headed else "1"

    display_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    print(f"Server: http://{display_host}:{args.port}")
    print(f"API docs: http://{display_host}:{args.port}/docs")
    request_log_file = os.environ.get("GHINBOX_REQUEST_LOG_FILE")
    if not args.no_request_log and request_log_file:
        print(f"Request log: {request_log_file}")
    debug_socket_path = None if args.no_debug_socket else Path(str(args.debug_socket))
    print()

    # Determine reload behavior:
    # - --no-reload: always disable
    # - --reload: always enable
    # - neither: auto-enable only in source checkouts
    if args.no_reload:
        reload = False
    elif args.reload:
        reload = True
    else:
        reload = _is_source_checkout()

    _run_uvicorn(
        host=args.host,
        port=args.port,
        reload=reload,
        debug_socket_path=debug_socket_path,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
