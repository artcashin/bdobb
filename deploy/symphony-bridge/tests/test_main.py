from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from app.config import Config, load_config
from app.main import _default_allowed_hosts, _parse_bind, _security_settings, create_app


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


# -- Fix 1: the default Host allowlist (used when BRIDGE_ALLOWED_HOSTS is
# unset) is loopback plus whatever BRIDGE_BIND resolves to.


def test_default_allowed_hosts_includes_loopback_and_the_bind_host():
    hosts = _default_allowed_hosts("bridge.tailnet.ts.net:8099")
    assert hosts == frozenset(
        {"127.0.0.1:*", "localhost:*", "[::1]:*", "bridge.tailnet.ts.net:*"}
    )


def test_default_allowed_hosts_skips_0000_bind_no_usable_host_to_add():
    # "0.0.0.0" means "listen on every interface" -- it is never itself a
    # client's Host header, so adding it would look like a restriction while
    # actually matching nothing real.
    assert _default_allowed_hosts("0.0.0.0:8099") == frozenset(
        {"127.0.0.1:*", "localhost:*", "[::1]:*"}
    )


def test_security_settings_honors_an_explicit_allowed_hosts_override():
    cfg = load_config({"BRIDGE_FAKE": "1", "BRIDGE_ALLOWED_HOSTS": "bridge.example:9"})
    settings = _security_settings(cfg)
    assert settings.enable_dns_rebinding_protection is True
    assert settings.allowed_hosts == ["bridge.example:9"]
    assert settings.allowed_origins == ["http://bridge.example:9", "https://bridge.example:9"]


def test_create_app_accepts_a_preloaded_config():
    # main() loads Config once and hands it through, rather than letting
    # create_app() call load_config() again from scratch.
    cfg: Config = load_config({"BRIDGE_FAKE": "1", "BRIDGE_BIND": "0.0.0.0:9"})
    app = create_app(config=cfg)
    assert app.state.config is cfg


# -- Fix 3: the parent app's own lifespan must still run, composed with the
# MCP sub-app's -- not silently discarded by wiring
# `app.router.lifespan_context = mcp_app.router.lifespan_context` in its
# place (the previous implementation). That direct assignment made
# `app.router.lifespan_context` literally *be* the sub-app's own bound
# method: no other code could ever run alongside it again, and a real
# `@app.on_event`/lifespan-based startup hook -- registered before or after
# `create_app()` returns -- would vanish silently, with no error and no
# warning.
#
# FastAPI's `on_event` shim only wires into the router's default lifespan;
# once *any* explicit `lifespan=` is passed to `FastAPI(...)` (both the old,
# buggy implementation and this one pass one), `on_event` handlers stop
# running by FastAPI's own design, not because of anything this fix does --
# so `on_event` can't be used to observe the difference between the two
# implementations. What the fix actually changes, and what's testable
# black-box, is whether `app.router.lifespan_context` is still a normal,
# further-composable async context manager (this fix) or has become a bound
# method of a *different* object standing in for it (the bug): wrapping
# another lifespan around it must run that wrapper's own code *and* still
# start the MCP session manager underneath, proving the composition survives
# instead of one side silently disappearing.


def test_parent_lifespan_still_runs_when_a_startup_hook_is_registered():
    app = create_app({"BRIDGE_FAKE": "1"})
    events: list[str] = []
    inner_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def with_a_startup_hook(started_app):
        events.append("hook-startup")
        async with inner_lifespan(started_app):
            yield
        events.append("hook-shutdown")

    app.router.lifespan_context = with_a_startup_hook

    with TestClient(app, base_url="http://127.0.0.1:8099") as api:
        assert events == ["hook-startup"]
        # The MCP sub-app's own lifespan must still be live underneath the
        # hook -- a session-less GET reaches the protocol's own "Missing
        # session ID" 400, not the "Task group is not initialized" crash a
        # discarded sub-lifespan would produce.
        res = api.get("/mcp", headers={"Accept": "text/event-stream"})
        assert res.status_code == 400

    assert events == ["hook-startup", "hook-shutdown"]
