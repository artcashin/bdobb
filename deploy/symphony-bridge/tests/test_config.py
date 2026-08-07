from app.config import load_config


def test_fake_mode_off_by_default():
    cfg = load_config({})
    assert cfg.fake is False


def test_fake_mode_on_when_set_to_one():
    cfg = load_config({"BRIDGE_FAKE": "1"})
    assert cfg.fake is True


def test_allowed_destinations_is_none_when_unset():
    # None means "no allowlist configured", which is different from an
    # empty allowlist (which would permit nothing).
    cfg = load_config({})
    assert cfg.allowed_destinations is None


def test_allowed_destinations_parses_and_strips():
    cfg = load_config({"BRIDGE_ALLOWED_DESTINATIONS": "abc , def,ghi"})
    assert cfg.allowed_destinations == frozenset({"abc", "def", "ghi"})


def test_blank_allowed_destinations_is_none_not_empty_set():
    cfg = load_config({"BRIDGE_ALLOWED_DESTINATIONS": "   "})
    assert cfg.allowed_destinations is None


def test_reads_pod_settings():
    cfg = load_config({
        "SYMPHONY_POD_HOST": "pod.example.com",
        "SYMPHONY_AGENT_HOST": "agent.example.com",
        "SYMPHONY_BOT_USERNAME": "test-bot",
        "SYMPHONY_BOT_KEY_PATH": "/run/secrets/bot.pem",
        "BRIDGE_BIND": "127.0.0.1:8099",
    })
    assert cfg.pod_host == "pod.example.com"
    assert cfg.agent_host == "agent.example.com"
    assert cfg.bot_username == "test-bot"
    assert cfg.bot_key_path == "/run/secrets/bot.pem"
    assert cfg.bind == "127.0.0.1:8099"


def test_comma_only_allowlist_is_none_not_an_empty_set():
    # An empty frozenset would mean "permit nothing" -- every send blocked.
    for raw in (",", " , ", ",,"):
        assert load_config({"BRIDGE_ALLOWED_DESTINATIONS": raw}).allowed_destinations is None
