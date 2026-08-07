from fastapi.testclient import TestClient

from app.main import create_app


def test_health_reports_ok_and_fake_mode():
    client = TestClient(create_app({"BRIDGE_FAKE": "1"}))
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["fake"] is True


def test_health_reports_live_mode_when_not_faking():
    client = TestClient(create_app({}))
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["fake"] is False


def test_health_never_leaks_credentials():
    # A health endpoint is the easiest place to accidentally dump config.
    client = TestClient(create_app({
        "BRIDGE_FAKE": "1",
        "SYMPHONY_BOT_USERNAME": "test-bot",
        "SYMPHONY_BOT_KEY_PATH": "/run/secrets/bot.pem",
    }))
    text = client.get("/health").text
    assert "test-bot" not in text
    assert "bot.pem" not in text
