import hashlib
import hmac
import json
from urllib.parse import urlencode

from fastapi.testclient import TestClient

from ghinbox.api.app import app
from ghinbox.api import webhook_routes


SECRET = "webhook-test-secret"
REPOSITORY = "ezyang/ghinbox"


def _payload(*, ref: str = "refs/heads/main") -> bytes:
    return json.dumps({"ref": ref, "repository": {"full_name": REPOSITORY}}).encode()


def _headers(payload: bytes, *, secret: str = SECRET) -> dict[str, str]:
    signature = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return {
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": f"sha256={signature}",
        "Content-Type": "application/json",
    }


def _form_payload(*, ref: str = "refs/heads/main") -> bytes:
    return urlencode({"payload": _payload(ref=ref).decode()}).encode()


def _ping_payload() -> bytes:
    return urlencode(
        {
            "payload": json.dumps(
                {
                    "zen": "Keep it logically awesome.",
                    "repository": {"full_name": REPOSITORY},
                }
            )
        }
    ).encode()


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("GHINBOX_WEBHOOK_SECRET", SECRET)
    monkeypatch.setenv("GHINBOX_WEBHOOK_REPOSITORY", REPOSITORY)


def test_signed_main_push_updates_checkout(monkeypatch) -> None:
    _configure(monkeypatch)
    calls: list[None] = []
    monkeypatch.setattr(
        webhook_routes,
        "update_from_origin_main",
        lambda: calls.append(None) or "updated",
    )
    payload = _payload()

    response = TestClient(app).post(
        "/webhooks/github/push",
        content=payload,
        headers=_headers(payload),
    )

    assert response.status_code == 200
    assert response.json() == {"status": "updated"}
    assert calls == [None]


def test_signed_non_main_push_is_ignored(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setattr(
        webhook_routes,
        "update_from_origin_main",
        lambda: (_ for _ in ()).throw(AssertionError("unexpected update")),
    )
    payload = _payload(ref="refs/heads/feature")

    response = TestClient(app).post(
        "/webhooks/github/push",
        content=payload,
        headers=_headers(payload),
    )

    assert response.status_code == 202
    assert response.json() == {"status": "ignored", "reason": "not main"}


def test_invalid_signature_is_rejected(monkeypatch) -> None:
    _configure(monkeypatch)
    payload = _payload()

    response = TestClient(app).post(
        "/webhooks/github/push",
        content=payload,
        headers=_headers(payload, secret="incorrect-secret"),
    )

    assert response.status_code == 403


def test_signed_form_encoded_ping_is_acknowledged_without_update(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setattr(
        webhook_routes,
        "update_from_origin_main",
        lambda: (_ for _ in ()).throw(AssertionError("unexpected update")),
    )
    payload = _ping_payload()
    headers = _headers(payload)
    headers["X-GitHub-Event"] = "ping"
    headers["Content-Type"] = "application/x-www-form-urlencoded"

    response = TestClient(app).post(
        "/webhooks/github/push",
        content=payload,
        headers=headers,
    )

    assert response.status_code == 202
    assert response.json() == {"status": "ignored", "reason": "not push"}


def test_signed_form_encoded_main_push_updates_checkout(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setattr(webhook_routes, "update_from_origin_main", lambda: "updated")
    payload = _form_payload()
    headers = _headers(payload)
    headers["Content-Type"] = "application/x-www-form-urlencoded"

    response = TestClient(app).post(
        "/webhooks/github/push",
        content=payload,
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"status": "updated"}


def test_update_fetches_and_fast_forwards_only(monkeypatch) -> None:
    calls: list[tuple[str, ...]] = []
    outputs = iter(["main", "", "old-head", "", "", "new-head"])

    def fake_git(*args: str) -> str:
        calls.append(args)
        return next(outputs)

    monkeypatch.setattr(webhook_routes, "_git", fake_git)

    assert webhook_routes.update_from_origin_main() == "updated"
    assert calls == [
        ("branch", "--show-current"),
        ("status", "--porcelain", "--untracked-files=normal"),
        ("rev-parse", "HEAD"),
        ("fetch", "origin", "refs/heads/main:refs/remotes/origin/main"),
        ("merge", "--ff-only", "origin/main"),
        ("rev-parse", "HEAD"),
    ]


def test_update_rejects_dirty_checkout_before_fetch(monkeypatch) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_git(*args: str) -> str:
        calls.append(args)
        return "main" if args[0] == "branch" else "modified.py"

    monkeypatch.setattr(webhook_routes, "_git", fake_git)

    try:
        webhook_routes.update_from_origin_main()
    except webhook_routes.UpdateError as error:
        assert str(error) == "checkout contains local changes"
    else:
        raise AssertionError("dirty checkout should not be updated")
    assert calls == [
        ("branch", "--show-current"),
        ("status", "--porcelain", "--untracked-files=normal"),
    ]
