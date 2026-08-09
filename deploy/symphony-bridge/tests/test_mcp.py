from fastapi.testclient import TestClient

from app.config import load_config
from app.fake_client import FakeClient
from app.main import create_app
from app.mcp_server import build_mcp


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
    with TestClient(create_app({"BRIDGE_FAKE": "1"}, client=FakeClient())) as api:
        res = api.get("/mcp", headers={"Accept": "text/event-stream"})
        assert res.status_code != 404
