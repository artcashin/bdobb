"""Fix 1: DNS-rebinding protection must reject an attacker-controlled Host
header on every route this bridge serves -- not just /mcp -- and must not
reject a legitimate client that sends no Origin header at all (the ordinary
shape for a non-browser caller: Host set, Origin absent).

Why this matters here specifically: CORS already blocks a plain
cross-origin browser `fetch` with no help from a Host allowlist. What a Host/
Origin allowlist actually stops is DNS rebinding -- a page whose origin
(and Origin header) is some short-TTL attacker-controlled name that later
resolves to this bridge's own address. Once rebound, the browser's request is
same-origin (no preflight, no CORS block) but carries a `Host` header of the
attacker's name -- exactly what this allowlist exists to catch. Fixing this
only for /mcp and leaving /messages and the discovery endpoints unguarded
would leave the identical exposure open on every other route.
"""

from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app

# Matches the default allowlist app/main.py computes when BRIDGE_ALLOWED_HOSTS
# is unset: loopback plus whatever BRIDGE_BIND resolves to (the default,
# "127.0.0.1:8099"). A request whose Host header is this value is legitimate;
# any other Host is a rebind.
_LEGIT_BASE_URL = "http://127.0.0.1:8099"
_REBOUND_HOST = "evil.example"


def _build():
    fake = FakeClient()
    app = create_app({"BRIDGE_FAKE": "1"}, client=fake)
    return app, fake


# -- Rebound Host is rejected everywhere, not just /mcp.


def test_rebound_host_is_rejected_on_messages():
    app, fake = _build()
    api = TestClient(app, base_url=_LEGIT_BASE_URL)
    res = api.post(
        "/messages",
        json={"streamId": "room-1", "text": "hi"},
        headers={"host": _REBOUND_HOST},
    )
    assert res.status_code == 421
    assert fake.sent == []  # the send path this bug reopened: nothing went out


def test_rebound_host_is_rejected_on_a_discovery_endpoint():
    app, _ = _build()
    api = TestClient(app, base_url=_LEGIT_BASE_URL)
    res = api.get("/conversations", headers={"host": _REBOUND_HOST})
    assert res.status_code == 421


def test_rebound_host_is_rejected_on_mcp():
    app, _ = _build()
    with TestClient(app, base_url=_LEGIT_BASE_URL) as api:
        res = api.get(
            "/mcp",
            headers={"host": _REBOUND_HOST, "Accept": "text/event-stream"},
        )
        assert res.status_code == 421


# -- A legitimate client (Host set, no Origin header at all) is accepted
# everywhere. TestClient sends no Origin header unless one is passed
# explicitly, so these requests already match that shape without extra setup.


def test_legit_no_origin_client_is_accepted_on_messages():
    app, fake = _build()
    api = TestClient(app, base_url=_LEGIT_BASE_URL)
    res = api.post("/messages", json={"streamId": "room-1", "text": "hi"})
    assert res.status_code == 200
    assert len(fake.sent) == 1


def test_legit_no_origin_client_is_accepted_on_a_discovery_endpoint():
    app, _ = _build()
    api = TestClient(app, base_url=_LEGIT_BASE_URL)
    res = api.get("/conversations")
    assert res.status_code == 200


def test_legit_no_origin_client_is_accepted_on_mcp():
    app, _ = _build()
    with TestClient(app, base_url=_LEGIT_BASE_URL) as api:
        res = api.get("/mcp", headers={"Accept": "text/event-stream"})
        # Not the rebinding-rejection code -- what happens next (a 400
        # "Missing session ID," the protocol's own answer to a session-less
        # GET) is a separate, already-covered concern, not this test's.
        assert res.status_code != 421
