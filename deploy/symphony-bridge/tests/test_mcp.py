import logging

from fastapi.testclient import TestClient

from app.config import load_config
from app.fake_client import FakeClient
from app.main import create_app
from app.mcp_server import build_mcp

AUDIT_LOGGER = "symphony_bridge.audit"

# Fix 1: the Host/Origin allowlist defaults to loopback + whatever BRIDGE_BIND
# resolves to ("127.0.0.1:8099" unless overridden) -- TestClient's own default
# base_url ("http://testserver") matches none of it and would 421 every
# request, so every real-app TestClient in this file targets a base_url that
# does.
_BASE_URL = "http://127.0.0.1:8099"


async def test_tool_sends_through_the_client():
    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_FAKE": "1"}))
    tools = await mcp.list_tools()
    assert [t.name for t in tools] == ["post_to_symphony"]
    assert len(tools[0].description or "") < 400  # keep Rita's budget small


async def test_tool_attributes_like_the_http_path():
    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_FAKE": "1"}))
    await mcp.call_tool("post_to_symphony", {"stream_id": "room-1", "message": "hi"})
    assert "via BDOBB" in fake.sent[0].message_ml


async def test_tool_writes_an_audit_record(caplog):
    import logging

    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_FAKE": "1"}))
    with caplog.at_level(logging.INFO):
        await mcp.call_tool("post_to_symphony", {"stream_id": "room-1", "message": "secret"})
    assert "room-1" in caplog.text
    assert "secret" not in caplog.text


async def test_tool_respects_the_destination_allowlist():
    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_ALLOWED_DESTINATIONS": "room-1"}))
    result = await mcp.call_tool("post_to_symphony", {"stream_id": "room-999", "message": "hi"})
    assert fake.sent == []
    assert "not in" in str(result).lower() or "allow" in str(result).lower()


# -- Fix 2: a client-construction failure must not be misfiled as a rejected
# send. `_LazyClient.resolve()` (app/main.py) lets post_to_symphony resolve
# the real client *before* its own send try/except; a plain SymphonyClient
# with a raising `resolve()` (no `_LazyClient` indirection needed) exercises
# exactly that seam without going through a real build_client()/live-mode
# import failure.


class _UnbuildableClient:
    def resolve(self):
        raise RuntimeError("no pod session yet")

    async def send_message(self, request):  # pragma: no cover -- must never run
        raise AssertionError("send_message must not be reached when resolve() fails")


async def test_client_construction_failure_on_mcp_path_has_no_audit_record(caplog):
    mcp = build_mcp(_UnbuildableClient(), load_config({"BRIDGE_FAKE": "1"}))
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        result = await mcp.call_tool("post_to_symphony", {"stream_id": "room-1", "message": "hi"})
    assert caplog.text == ""  # no send was rejected or attempted -- nothing to audit
    assert "unavailable" in str(result).lower()
    assert "room-1" not in str(result)  # distinct from the ordinary refusal/error text


# -- Cold start: the app built exactly the way main() builds it (no injected
# client) must still be able to serve a real /mcp tools/call. Drives the
# actual mounted route over the streamable-HTTP wire protocol -- not just
# `build_mcp()` in isolation -- via an in-process ASGI transport (no real
# socket) so the full session negotiation, the app-wide Host/Origin gate
# (Fix 1), and the lazily-built FakeClient (BRIDGE_FAKE=1, no client=...
# passed to create_app, matching main()) are all exercised together.


async def test_cold_start_mcp_tools_call_succeeds():
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    app = create_app({"BRIDGE_FAKE": "1"})  # no client injected -- cold, like main()
    transport = httpx2.ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=transport, base_url=_BASE_URL) as http_client,
        streamable_http_client(f"{_BASE_URL}/mcp", http_client=http_client) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool(
            "post_to_symphony", {"stream_id": "room-1", "message": "hi"}
        )
    assert result.is_error is False
    assert "sent" in result.content[0].text.lower()


def test_mcp_is_mounted_without_a_trailing_slash():
    # /mcp, not /mcp/ -- the 307 redirect is a known gotcha for this stack.
    #
    # Needs a `with` block: the installed mcp==2.0.0 MCPServer's streamable-
    # HTTP transport requires its session manager's `run()` context to be
    # entered (via the app's ASGI lifespan) before it will serve a request at
    # all -- without it, every request raises "Task group is not initialized.
    # Make sure to use run()." TestClient only drives the lifespan protocol
    # when used as a context manager; a bare TestClient(...).get(...) never
    # sends lifespan.startup, matching real uvicorn behaviour (which always
    # runs the lifespan) rather than diverging from it.
    with TestClient(
        create_app({"BRIDGE_FAKE": "1"}, client=FakeClient()), base_url=_BASE_URL
    ) as api:
        res = api.get("/mcp", headers={"Accept": "text/event-stream"})
        assert res.status_code != 404
