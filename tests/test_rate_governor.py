"""Tests for the pure GitHub API rate governor."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ghinbox.api.rate_governor import (
    ENV_RATE_GOVERNOR_TEST_ENABLE,
    RateGovernor,
    RateGovernorConfig,
    RateLimitPoolState,
    evaluate,
    pool_state_from_headers,
)

NOW = datetime(2026, 7, 6, 12, 0, tzinfo=UTC)


def pool_state(
    *,
    remaining: int,
    reset_at: datetime | None = None,
    resource: str = "core",
) -> RateLimitPoolState:
    return RateLimitPoolState(
        resource=resource,
        remaining=remaining,
        reset_at=reset_at or NOW + timedelta(hours=1),
        limit=5000,
        used=5000 - remaining,
        updated_at=NOW,
    )


@pytest.mark.parametrize(
    ("call_class", "remaining", "expected_allowed", "expected_floor"),
    [
        ("background", 499, False, 500),
        ("background", 500, True, 500),
        ("background", 501, True, 500),
        ("interactive", 99, False, 100),
        ("interactive", 100, True, 100),
        ("interactive", 101, True, 100),
        ("unknown", 499, False, 500),
    ],
)
def test_evaluate_applies_call_class_floors(
    call_class: str,
    remaining: int,
    expected_allowed: bool,
    expected_floor: int,
) -> None:
    decision = evaluate(pool_state(remaining=remaining), call_class, NOW)

    assert decision.allowed is expected_allowed
    assert decision.floor == expected_floor
    assert decision.remaining == remaining
    if expected_allowed:
        assert decision.reason is None
    else:
        assert decision.reason == "remaining_below_floor"


def test_evaluate_caps_floor_at_half_small_pool_limit() -> None:
    """GitHub's search pool caps at 30/min, far below the 500 background floor.
    A flat floor would permanently block search; the effective floor must be
    capped at half the pool's own limit so small pools stay usable."""
    search_pool = RateLimitPoolState(
        resource="search",
        remaining=29,
        reset_at=NOW + timedelta(minutes=1),
        limit=30,
        used=1,
        updated_at=NOW,
    )

    decision = evaluate(search_pool, "background", NOW)

    assert decision.floor == 15
    assert decision.allowed is True
    assert decision.reason is None

    exhausted = RateLimitPoolState(
        resource="search",
        remaining=10,
        reset_at=NOW + timedelta(minutes=1),
        limit=30,
        used=20,
        updated_at=NOW,
    )
    denied = evaluate(exhausted, "background", NOW)
    assert denied.floor == 15
    assert denied.allowed is False
    assert denied.reason == "remaining_below_floor"


def test_evaluate_allows_unknown_pool_until_headers_are_seen() -> None:
    decision = evaluate(None, "background", NOW, pool="core")

    assert decision.allowed is True
    assert decision.pool == "core"
    assert decision.remaining is None
    assert decision.floor == 500


def test_evaluate_allows_after_reset_time_passes() -> None:
    stale = pool_state(remaining=0, reset_at=NOW - timedelta(seconds=1))
    current = pool_state(remaining=0, reset_at=NOW + timedelta(seconds=1))

    assert evaluate(stale, "interactive", NOW).allowed is True
    current_decision = evaluate(current, "interactive", NOW)
    assert current_decision.allowed is False
    assert current_decision.reset_at == NOW + timedelta(seconds=1)


def test_pool_state_from_headers_parses_github_rate_limit_headers() -> None:
    state = pool_state_from_headers(
        {
            "X-RateLimit-Limit": "5000",
            "X-RateLimit-Remaining": "4998",
            "X-RateLimit-Used": "2",
            "X-RateLimit-Reset": "1783348800",
            "X-RateLimit-Resource": "Core",
        },
        observed_at=NOW,
    )

    assert state == RateLimitPoolState(
        resource="core",
        limit=5000,
        remaining=4998,
        used=2,
        reset_at=datetime.fromtimestamp(1783348800, UTC),
        updated_at=NOW,
    )


def test_tracker_accepts_header_regression_when_remaining_jumps_back_up() -> None:
    governor = RateGovernor(config=RateGovernorConfig(enabled=True))
    governor.update_from_headers(
        {
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": "1783348800",
            "x-ratelimit-resource": "core",
        },
        observed_at=NOW,
    )

    denied = governor.check(
        pool="core",
        call_class="interactive",
        request_id=None,
        source="test",
        method="GET",
        url="https://api.github.com/user",
        now=NOW,
    )
    assert denied.allowed is False
    assert denied.remaining == 42

    governor.update_from_headers(
        {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-reset": "1783348800",
            "x-ratelimit-resource": "core",
        },
        observed_at=NOW,
    )
    allowed = governor.check(
        pool="core",
        call_class="interactive",
        request_id=None,
        source="test",
        method="GET",
        url="https://api.github.com/user",
        now=NOW,
    )
    assert allowed.allowed is True
    assert allowed.remaining == 4999


def test_tracker_ignores_malformed_headers() -> None:
    governor = RateGovernor(config=RateGovernorConfig(enabled=True))
    assert (
        governor.update_from_headers(
            {
                "x-ratelimit-remaining": "not-a-number",
                "x-ratelimit-reset": "1783348800",
                "x-ratelimit-resource": "core",
            },
            observed_at=NOW,
        )
        is None
    )
    assert governor.snapshot()["pools"] == {}

    governor.update_from_headers(
        {
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": "1783348800",
            "x-ratelimit-resource": "core",
        },
        observed_at=NOW,
    )
    governor.update_from_headers(
        {
            "x-ratelimit-remaining": "abc",
            "x-ratelimit-reset": "1783348800",
            "x-ratelimit-resource": "core",
        },
        observed_at=NOW,
    )
    assert governor.snapshot()["pools"]["core"]["remaining"] == 42


def test_tracker_enforces_per_request_budget() -> None:
    governor = RateGovernor(
        config=RateGovernorConfig(request_budget=2, enabled=True),
    )

    first = governor.check(
        pool="core",
        call_class="background",
        request_id="req-1",
        source="test",
        method="GET",
        url="https://api.github.com/one",
        now=NOW,
    )
    second = governor.check(
        pool="core",
        call_class="background",
        request_id="req-1",
        source="test",
        method="GET",
        url="https://api.github.com/two",
        now=NOW,
    )
    third = governor.check(
        pool="core",
        call_class="background",
        request_id="req-1",
        source="test",
        method="GET",
        url="https://api.github.com/three",
        now=NOW,
    )

    assert first.allowed is True
    assert first.request_count == 1
    assert second.allowed is True
    assert second.request_count == 2
    assert third.allowed is False
    assert third.reason == "request_budget_exceeded"
    assert third.request_count == 2
    assert third.request_budget == 2


def test_test_mode_disables_governor_unless_opted_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GHINBOX_TEST_MODE", "1")
    monkeypatch.delenv(ENV_RATE_GOVERNOR_TEST_ENABLE, raising=False)
    assert RateGovernorConfig.from_env().enabled is False

    monkeypatch.setenv(ENV_RATE_GOVERNOR_TEST_ENABLE, "1")
    assert RateGovernorConfig.from_env().enabled is True
