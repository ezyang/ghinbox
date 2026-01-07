"""
State machine and session management for headless GitHub login.

This module manages login sessions that track the state of authentication
attempts across multiple HTTP requests.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from threading import Lock
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ghinbox.api.login_fetcher import LoginFetcher


class LoginState(Enum):
    """States in the login state machine."""

    INITIALIZED = "initialized"  # Session created, waiting for credentials
    SUBMITTING_CREDENTIALS = "submitting_credentials"  # Submitting to GitHub
    WAITING_2FA = "waiting_2fa"  # GitHub requested 2FA (code entry)
    WAITING_MOBILE = "waiting_mobile"  # Waiting for GitHub Mobile 2FA approval
    SUBMITTING_2FA = "submitting_2fa"  # Submitting 2FA code
    SUCCESS = "success"  # Login completed successfully
    ERROR = "error"  # Login failed
    CAPTCHA = "captcha"  # CAPTCHA detected, cannot proceed headlessly


@dataclass
class LoginSession:
    """A login session tracking authentication state."""

    session_id: str
    account: str
    state: LoginState
    created_at: float
    error_message: str | None = None
    requires_2fa: bool = False
    twofa_method: str | None = None  # 'app', 'sms', or None
    username: str | None = None  # GitHub username on success
    # Internal: reference to LoginFetcher for this session (not serialized)
    _fetcher: LoginFetcher | None = field(default=None, repr=False)

    def to_dict(self) -> dict:
        """Convert to API response dict."""
        result = {
            "session_id": self.session_id,
            "status": self.state.value,
            "created_at": self.created_at,
        }
        if self.error_message:
            result["error"] = self.error_message
        if self.username:
            result["username"] = self.username
        if self.requires_2fa:
            result["requires_2fa"] = True
            if self.twofa_method:
                result["twofa_method"] = self.twofa_method
        return result

    @property
    def is_terminal(self) -> bool:
        """Check if this session is in a terminal state."""
        return self.state in (LoginState.SUCCESS, LoginState.ERROR, LoginState.CAPTCHA)

    @property
    def expires_at(self) -> float:
        """Session expiration timestamp (5 minutes from creation)."""
        return self.created_at + 300  # 5 minutes

    @property
    def is_expired(self) -> bool:
        """Check if this session has expired."""
        return time.time() > self.expires_at


class LoginSessionManager:
    """
    Manages login sessions with expiry and cleanup.

    Thread-safe singleton for managing active login sessions.
    Sessions expire after 5 minutes of inactivity.
    """

    _instance: "LoginSessionManager | None" = None
    _class_lock = Lock()

    # Instance attributes (declared for type checker)
    _sessions: dict[str, LoginSession]
    _sessions_lock: Lock

    def __new__(cls) -> "LoginSessionManager":
        if cls._instance is None:
            with cls._class_lock:
                if cls._instance is None:
                    instance = super().__new__(cls)
                    instance._sessions = {}
                    instance._sessions_lock = Lock()
                    cls._instance = instance
        return cls._instance

    def create_session(self, account: str) -> LoginSession:
        """Create a new login session."""
        session_id = str(uuid.uuid4())
        session = LoginSession(
            session_id=session_id,
            account=account,
            state=LoginState.INITIALIZED,
            created_at=time.time(),
        )
        with self._sessions_lock:
            # Cleanup expired sessions while we're at it
            self._cleanup_expired_unlocked()
            self._sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> LoginSession | None:
        """Get a session by ID, returning None if not found or expired."""
        with self._sessions_lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            if session.is_expired:
                self._remove_session_unlocked(session_id)
                return None
            return session

    def update_state(
        self,
        session_id: str,
        state: LoginState,
        error_message: str | None = None,
        username: str | None = None,
        requires_2fa: bool = False,
        twofa_method: str | None = None,
    ) -> LoginSession | None:
        """Update the state of a session."""
        with self._sessions_lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            session.state = state
            if error_message is not None:
                session.error_message = error_message
            if username is not None:
                session.username = username
            if requires_2fa:
                session.requires_2fa = True
            if twofa_method is not None:
                session.twofa_method = twofa_method
            return session

    def set_fetcher(self, session_id: str, fetcher: LoginFetcher) -> None:
        """Attach a fetcher to a session."""
        with self._sessions_lock:
            session = self._sessions.get(session_id)
            if session:
                session._fetcher = fetcher

    def get_fetcher(self, session_id: str) -> LoginFetcher | None:
        """Get the fetcher for a session."""
        with self._sessions_lock:
            session = self._sessions.get(session_id)
            return session._fetcher if session else None

    def remove_session(self, session_id: str) -> LoginSession | None:
        """Remove a session and return it."""
        with self._sessions_lock:
            return self._remove_session_unlocked(session_id)

    def _remove_session_unlocked(self, session_id: str) -> LoginSession | None:
        """Remove a session without locking (caller must hold lock).

        Note: Callers should close the fetcher (await fetcher.close()) before
        calling this method, as the fetcher's close() is async and cannot be
        called from this sync context.
        """
        session = self._sessions.pop(session_id, None)
        # Clear the fetcher reference (caller is responsible for closing it)
        if session and session._fetcher:
            session._fetcher = None
        return session

    def _cleanup_expired_unlocked(self) -> int:
        """Remove expired sessions (caller must hold lock)."""
        now = time.time()
        expired = [
            sid for sid, session in self._sessions.items() if session.expires_at < now
        ]
        for sid in expired:
            self._remove_session_unlocked(sid)
        return len(expired)

    def cleanup_expired(self) -> int:
        """Remove expired sessions and return count removed."""
        with self._sessions_lock:
            return self._cleanup_expired_unlocked()

    def session_count(self) -> int:
        """Get count of active sessions."""
        with self._sessions_lock:
            return len(self._sessions)


# Global instance
def get_session_manager() -> LoginSessionManager:
    """Get the global session manager instance."""
    return LoginSessionManager()
