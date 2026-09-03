from fastapi.testclient import TestClient

from app.main import create_app

# Fix 1: the Host/Origin allowlist defaults to loopback + whatever BRIDGE_BIND
# resolves to ("127.0.0.1:8099" unless overridden) -- TestClient's own default
# base_url ("http://testserver") matches none of it and would 421 every
# request, so every TestClient here targets a base_url that does.
_BASE_URL = "http://127.0.0.1:8099"


def test_health_reports_ok_and_fake_mode():
    client = TestClient(create_app({"BRIDGE_FAKE": "1"}), base_url=_BASE_URL)
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["fake"] is True


def test_health_reports_live_mode_when_not_faking():
    client = TestClient(create_app({}), base_url=_BASE_URL)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["fake"] is False


def test_health_never_leaks_credentials():
    # A health endpoint is the easiest place to accidentally dump config.
    client = TestClient(create_app({
        "BRIDGE_FAKE": "1",
        "SYMPHONY_BOT_USERNAME": "test-bot",
        "SYMPHONY_BOT_KEY_PATH": "/run/secrets/bot.pem",
    }), base_url=_BASE_URL)
    text = client.get("/health").text
    assert "test-bot" not in text
    assert "bot.pem" not in text
