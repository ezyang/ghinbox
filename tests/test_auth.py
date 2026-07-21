from ghinbox import auth


def test_refresh_auth_keeps_verified_browser_session(monkeypatch) -> None:
    login_calls: list[tuple[str, bool]] = []

    monkeypatch.setattr(auth, "has_valid_auth", lambda account: True)
    monkeypatch.setattr(auth, "verify_auth", lambda account: True)
    monkeypatch.setattr(auth, "load_username", lambda account: "octocat")
    monkeypatch.setattr(
        auth,
        "login_interactive",
        lambda account, force=False, save_username_flag=False: (
            login_calls.append((account, force)) or (True, None)
        ),
    )

    assert auth.refresh_auth("default") == (True, "octocat")
    assert login_calls == []


def test_refresh_auth_opens_login_only_after_verification_fails(monkeypatch) -> None:
    login_calls: list[tuple[str, bool]] = []

    monkeypatch.setattr(auth, "has_valid_auth", lambda account: True)
    monkeypatch.setattr(auth, "verify_auth", lambda account: False)

    def fake_login(
        account: str, force: bool = False, save_username_flag: bool = False
    ) -> tuple[bool, str | None]:
        login_calls.append((account, force))
        return True, "octocat"

    monkeypatch.setattr(auth, "login_interactive", fake_login)

    assert auth.refresh_auth("default") == (True, "octocat")
    assert login_calls == [("default", True)]
