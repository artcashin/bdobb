import pytest

from app.config import Config, load_config
from app.main import _parse_bind, create_app


def test_parse_bind_host_and_port():
    assert _parse_bind("127.0.0.1:8099") == ("127.0.0.1", 8099)


def test_parse_bind_bare_port():
    # A colonless numeric value is a port, not a host -- the old
    # `"8099".partition(":")` gave host="8099", port=8099.
    assert _parse_bind("8099") == ("127.0.0.1", 8099)


def test_parse_bind_bare_host():
    assert _parse_bind("0.0.0.0") == ("0.0.0.0", 8099)


def test_parse_bind_low_port():
    assert _parse_bind("0.0.0.0:1") == ("0.0.0.0", 1)


def test_parse_bind_rejects_non_numeric_port():
    with pytest.raises(ValueError, match="BRIDGE_BIND"):
        _parse_bind("host:not-a-port")


def test_parse_bind_rejects_out_of_range_port():
    with pytest.raises(ValueError, match="BRIDGE_BIND"):
        _parse_bind("host:70000")


def test_parse_bind_rejects_empty_value():
    with pytest.raises(ValueError, match="BRIDGE_BIND"):
        _parse_bind("")


def test_create_app_accepts_a_preloaded_config():
    # main() loads Config once and hands it through, rather than letting
    # create_app() call load_config() again from scratch.
    cfg: Config = load_config({"BRIDGE_FAKE": "1", "BRIDGE_BIND": "0.0.0.0:9"})
    app = create_app(config=cfg)
    assert app.state.config is cfg
