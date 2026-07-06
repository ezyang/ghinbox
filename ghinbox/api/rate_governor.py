"""GitHub API rate-limit governor.

The decision core in this module is deliberately pure: callers provide the
known pool state, call class, and current time, and get back an allow/deny
decision.  The RateGovernor class is the small stateful shell used by the API
server to remember response headers and per-request outbound call counts.
"""

from __future__ import annotations

import os
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from threading import Lock
from typing import Any, Literal
from urllib.parse import parse_qsl, urlparse

CallClass = Literal["background", "interactive"]

DEFAULT_RATE_FLOOR_BACKGROUND = 500
DEFAULT_RATE_FLOOR_INTERACTIVE = 100
DEFAULT_RATE_REQUEST_BUDGET = 300
MAX_RECENT_DENIALS = 100

ENV_RATE_FLOOR_BACKGROUND = "GHINBOX_RATE_FLOOR_BACKGROUND"
ENV_RATE_FLOOR_INTERACTIVE = "GHINBOX_RATE_FLOOR_INTERACTIVE"
ENV_RATE_REQUEST_BUDGET = "GHINBOX_RATE_REQUEST_BUDGET"
ENV_RATE_GOVERNOR_ENABLED = "GHINBOX_RATE_GOVERNOR_ENABLED"
ENV_RATE_GOVERNOR_TEST_ENABLE = "GHINBOX_RATE_GOVERNOR_TEST_ENABLE"


def utc_now() -> datetime:
    return datetime.now(UTC)


def isoformat_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _coerce_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _env_int(name: str, default: int, *, minimum: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError:
        return default
    return max(minimum, value)


def normalize_call_class(call_class: str | None) -> CallClass:
    if call_class == "interactive":
        return "interactive"
    return "background"


def normalize_resource(resource: str | None) -> str:
    value = str(resource or "").strip().lower()
    return value or "unknown"


@dataclass(frozen=True)
class RateGovernorConfig:
    """Runtime policy for rate-limit decisions."""

    background_floor: int = DEFAULT_RATE_FLOOR_BACKGROUND
    interactive_floor: int = DEFAULT_RATE_FLOOR_INTERACTIVE
    request_budget: int = DEFAULT_RATE_REQUEST_BUDGET
    enabled: bool = True

    @classmethod
    def from_env(cls) -> RateGovernorConfig:
        enabled = os.environ.get(ENV_RATE_GOVERNOR_ENABLED, "1") != "0"
        if (
            os.environ.get("GHINBOX_TEST_MODE") == "1"
            and os.environ.get(ENV_RATE_GOVERNOR_TEST_ENABLE) != "1"
        ):
            enabled = False
        return cls(
            background_floor=_env_int(
                ENV_RATE_FLOOR_BACKGROUND,
                DEFAULT_RATE_FLOOR_BACKGROUND,
                minimum=0,
            ),
            interactive_floor=_env_int(
                ENV_RATE_FLOOR_INTERACTIVE,
                DEFAULT_RATE_FLOOR_INTERACTIVE,
                minimum=0,
            ),
            request_budget=_env_int(
                ENV_RATE_REQUEST_BUDGET,
                DEFAULT_RATE_REQUEST_BUDGET,
                minimum=1,
            ),
            enabled=enabled,
        )

    def floor_for(self, call_class: str | None) -> int:
        normalized = normalize_call_class(call_class)
        if normalized == "interactive":
            return self.interactive_floor
        return self.background_floor

    def to_debug_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "floors": {
                "background": self.background_floor,
                "interactive": self.interactive_floor,
            },
            "request_budget": self.request_budget,
        }


@dataclass(frozen=True)
class RateLimitPoolState:
    """Last observed GitHub rate-limit state for one x-ratelimit-resource pool."""

    resource: str
    remaining: int
    reset_at: datetime
    limit: int | None = None
    used: int | None = None
    updated_at: datetime | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "resource", normalize_resource(self.resource))
        object.__setattr__(self, "reset_at", _coerce_utc(self.reset_at))
        if self.updated_at is not None:
            object.__setattr__(self, "updated_at", _coerce_utc(self.updated_at))

    def to_debug_dict(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "limit": self.limit,
            "remaining": self.remaining,
            "used": self.used,
            "reset_at": isoformat_utc(self.reset_at),
            "updated_at": isoformat_utc(self.updated_at),
        }


@dataclass(frozen=True)
class RateGovernorDecision:
    """Allow/deny decision returned by the pure policy function."""

    allowed: bool
    call_class: CallClass
    pool: str
    remaining: int | None
    floor: int
    reset_at: datetime | None
    reason: str | None = None
    request_id: str | None = None
    request_count: int | None = None
    request_budget: int | None = None
    message: str | None = None

    def with_context(
        self,
        *,
        request_id: str | None,
        request_count: int | None,
        request_budget: int | None,
        message: str | None = None,
    ) -> RateGovernorDecision:
        return replace(
            self,
            request_id=request_id,
            request_count=request_count,
            request_budget=request_budget,
            message=message if message is not None else self.message,
        )

    def to_detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {
            "error": "github_rate_governor_denied",
            "message": self.message or self.default_message(),
            "reason": self.reason,
            "pool": self.pool,
            "remaining": self.remaining,
            "floor": self.floor,
            "reset_at": isoformat_utc(self.reset_at),
            "call_class": self.call_class,
        }
        if self.request_id is not None:
            detail["request_id"] = self.request_id
        if self.request_count is not None:
            detail["request_count"] = self.request_count
        if self.request_budget is not None:
            detail["request_budget"] = self.request_budget
        return detail

    def default_message(self) -> str:
        if self.reason == "request_budget_exceeded":
            return (
                "GitHub API request budget exceeded: "
                f"{self.request_count}/{self.request_budget} outbound calls "
                "already made for this request."
            )
        reset_suffix = (
            f" Resets at {isoformat_utc(self.reset_at)}." if self.reset_at else ""
        )
        return (
            "GitHub API rate governor denied "
            f"{self.call_class} call for {self.pool}: remaining "
            f"{self.remaining} is below floor {self.floor}.{reset_suffix}"
        )


class RateGovernorDeniedError(RuntimeError):
    """Raised when a GitHub API call is denied before being issued."""

    def __init__(self, decision: RateGovernorDecision) -> None:
        self.decision = decision
        self.detail = decision.to_detail()
        super().__init__(str(self.detail["message"]))


def evaluate(
    pool_state: RateLimitPoolState | None,
    call_class: str | None,
    now: datetime,
    *,
    pool: str = "unknown",
    background_floor: int = DEFAULT_RATE_FLOOR_BACKGROUND,
    interactive_floor: int = DEFAULT_RATE_FLOOR_INTERACTIVE,
) -> RateGovernorDecision:
    """Evaluate one outbound call against the last known pool state."""
    normalized_class = normalize_call_class(call_class)
    floor = interactive_floor if normalized_class == "interactive" else background_floor
    normalized_pool = normalize_resource(pool_state.resource if pool_state else pool)
    now = _coerce_utc(now)

    if pool_state is None:
        return RateGovernorDecision(
            allowed=True,
            call_class=normalized_class,
            pool=normalized_pool,
            remaining=None,
            floor=floor,
            reset_at=None,
        )

    if pool_state.reset_at <= now:
        return RateGovernorDecision(
            allowed=True,
            call_class=normalized_class,
            pool=normalized_pool,
            remaining=pool_state.remaining,
            floor=floor,
            reset_at=pool_state.reset_at,
        )

    if pool_state.remaining < floor:
        return RateGovernorDecision(
            allowed=False,
            reason="remaining_below_floor",
            call_class=normalized_class,
            pool=normalized_pool,
            remaining=pool_state.remaining,
            floor=floor,
            reset_at=pool_state.reset_at,
        )

    return RateGovernorDecision(
        allowed=True,
        call_class=normalized_class,
        pool=normalized_pool,
        remaining=pool_state.remaining,
        floor=floor,
        reset_at=pool_state.reset_at,
    )


def _mapping_header_value(headers: Mapping[str, str] | None, name: str) -> str | None:
    if headers is None:
        return None
    value = headers.get(name) or headers.get(name.lower())
    if value is not None:
        return str(value)
    normalized_name = name.lower()
    for key, header_value in headers.items():
        if key.lower() == normalized_name:
            return str(header_value)
    return None


def _parse_nonnegative_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    if parsed < 0:
        return None
    return parsed


def pool_state_from_headers(
    headers: Mapping[str, str] | None,
    *,
    observed_at: datetime | None = None,
) -> RateLimitPoolState | None:
    """Parse GitHub x-ratelimit-* headers into a pool state.

    A partial or malformed header set is ignored so bad test doubles or unusual
    GitHub responses cannot poison the governor state.
    """
    resource = _mapping_header_value(headers, "x-ratelimit-resource")
    remaining = _parse_nonnegative_int(
        _mapping_header_value(headers, "x-ratelimit-remaining")
    )
    reset_epoch = _parse_nonnegative_int(
        _mapping_header_value(headers, "x-ratelimit-reset")
    )
    if not resource or remaining is None or reset_epoch is None:
        return None

    return RateLimitPoolState(
        resource=resource,
        limit=_parse_nonnegative_int(
            _mapping_header_value(headers, "x-ratelimit-limit")
        ),
        remaining=remaining,
        used=_parse_nonnegative_int(_mapping_header_value(headers, "x-ratelimit-used")),
        reset_at=datetime.fromtimestamp(reset_epoch, UTC),
        updated_at=observed_at or utc_now(),
    )


def _endpoint_from_url(url: str) -> tuple[str, list[str]]:
    parsed = urlparse(url)
    endpoint = parsed.path or url
    query_keys = sorted({key for key, _value in parse_qsl(parsed.query)})
    return endpoint, query_keys


class RateGovernor:
    """Stateful tracker around the pure rate-limit decision function."""

    def __init__(
        self,
        config: RateGovernorConfig | None = None,
        *,
        max_recent_denials: int = MAX_RECENT_DENIALS,
    ) -> None:
        self._fixed_config = config
        self._pool_states: dict[str, RateLimitPoolState] = {}
        self._request_counts: dict[str, int] = {}
        self._recent_denials: deque[dict[str, Any]] = deque(maxlen=max_recent_denials)
        self._lock = Lock()

    def _config(self) -> RateGovernorConfig:
        if self._fixed_config is not None:
            return self._fixed_config
        return RateGovernorConfig.from_env()

    def check(
        self,
        *,
        pool: str,
        call_class: str | None,
        request_id: str | None,
        source: str,
        method: str,
        url: str,
        now: datetime | None = None,
    ) -> RateGovernorDecision:
        config = self._config()
        normalized_pool = normalize_resource(pool)
        normalized_class = normalize_call_class(call_class)
        current_time = now or utc_now()
        if not config.enabled:
            return RateGovernorDecision(
                allowed=True,
                call_class=normalized_class,
                pool=normalized_pool,
                remaining=None,
                floor=config.floor_for(normalized_class),
                reset_at=None,
            )

        with self._lock:
            pool_state = self._pool_states.get(normalized_pool)
            request_count = (
                self._request_counts.get(request_id, 0)
                if request_id is not None
                else None
            )
            decision = evaluate(
                pool_state,
                normalized_class,
                current_time,
                pool=normalized_pool,
                background_floor=config.background_floor,
                interactive_floor=config.interactive_floor,
            ).with_context(
                request_id=request_id,
                request_count=request_count,
                request_budget=config.request_budget,
            )
            if not decision.allowed:
                self._record_denial_locked(
                    decision,
                    source=source,
                    method=method,
                    url=url,
                )
                return decision

            if request_id is not None and request_count is not None:
                if request_count >= config.request_budget:
                    budget_decision = RateGovernorDecision(
                        allowed=False,
                        reason="request_budget_exceeded",
                        call_class=normalized_class,
                        pool=normalized_pool,
                        remaining=decision.remaining,
                        floor=decision.floor,
                        reset_at=decision.reset_at,
                        request_id=request_id,
                        request_count=request_count,
                        request_budget=config.request_budget,
                    )
                    self._record_denial_locked(
                        budget_decision,
                        source=source,
                        method=method,
                        url=url,
                    )
                    return budget_decision
                self._request_counts[request_id] = request_count + 1
                decision = decision.with_context(
                    request_id=request_id,
                    request_count=request_count + 1,
                    request_budget=config.request_budget,
                )

            return decision

    def update_from_headers(
        self,
        headers: Mapping[str, str] | None,
        *,
        observed_at: datetime | None = None,
    ) -> RateLimitPoolState | None:
        if not self._config().enabled:
            return None
        pool_state = pool_state_from_headers(headers, observed_at=observed_at)
        if pool_state is None:
            return None
        with self._lock:
            self._pool_states[pool_state.resource] = pool_state
        return pool_state

    def finish_request(self, request_id: str | None) -> None:
        if request_id is None:
            return
        with self._lock:
            self._request_counts.pop(request_id, None)

    def snapshot(self, *, denial_limit: int = 20) -> dict[str, Any]:
        config = self._config()
        with self._lock:
            pools = {
                resource: state.to_debug_dict()
                for resource, state in sorted(self._pool_states.items())
            }
            denials = list(self._recent_denials)[-denial_limit:]
            active_request_counts = dict(self._request_counts)
        return {
            **config.to_debug_dict(),
            "pools": pools,
            "active_request_counts": active_request_counts,
            "recent_denials": denials,
        }

    def reset(self) -> None:
        with self._lock:
            self._pool_states.clear()
            self._request_counts.clear()
            self._recent_denials.clear()

    def _record_denial_locked(
        self,
        decision: RateGovernorDecision,
        *,
        source: str,
        method: str,
        url: str,
    ) -> None:
        endpoint, query_keys = _endpoint_from_url(url)
        entry: dict[str, Any] = {
            "timestamp": isoformat_utc(utc_now()),
            "event": "github_rate_governor_denial",
            "request_id": decision.request_id,
            "source": source,
            "method": method.upper(),
            "endpoint": endpoint,
            "reason": decision.reason,
            "pool": decision.pool,
            "call_class": decision.call_class,
            "remaining": decision.remaining,
            "floor": decision.floor,
            "reset_at": isoformat_utc(decision.reset_at),
            "request_count": decision.request_count,
            "request_budget": decision.request_budget,
        }
        if query_keys:
            entry["query_keys"] = query_keys
        self._recent_denials.append(entry)


_global_rate_governor = RateGovernor()


def get_rate_governor() -> RateGovernor:
    return _global_rate_governor
