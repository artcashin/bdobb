from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app


def build():
    return TestClient(create_app({"BRIDGE_FAKE": "1"}, client=FakeClient()))


def build_cold():
    """Build the app the way main() does: fake mode, no client injected, so
    app.state.client starts out None and only get_client() can resolve it."""
    return TestClient(create_app({"BRIDGE_FAKE": "1"}))


def test_conversations_returns_stream_ids_and_names():
    res = build().get("/conversations")
    assert res.status_code == 200
    items = res.json()["conversations"]
    assert items
    assert all(set(item) == {"streamId", "name"} for item in items)


def test_search_rooms_requires_a_query():
    assert build().get("/search/rooms").status_code == 422


def test_search_rooms_returns_matches():
    res = build().get("/search/rooms", params={"q": "trading"})
    assert res.status_code == 200
    rooms = res.json()["rooms"]
    assert rooms
    assert all(set(room) == {"streamId", "name", "description"} for room in rooms)
    assert rooms == [
        {
            "streamId": "fake-trading-desk",
            "name": "Trading Desk",
            "description": "Desk chatter",
        }
    ]


def test_search_rooms_returns_an_empty_list_for_no_matches():
    res = build().get("/search/rooms", params={"q": "zzzz"})
    assert res.status_code == 200
    assert res.json()["rooms"] == []


async def test_search_rooms_empty_query_returns_all_rooms():
    res = build().get("/search/rooms", params={"q": ""})
    assert res.status_code == 200
    all_rooms = await FakeClient().list_conversations()
    assert len(res.json()["rooms"]) == len(all_rooms)


async def test_search_rooms_whitespace_query_returns_all_rooms():
    # Pins fake_client.py's docstring: an empty *or all-whitespace* query
    # matches every room. search_rooms() strips the query before matching,
    # so a lone space doesn't accidentally act as a substring filter that
    # only happens to match "Trading Desk" (the one name with a space in it).
    res = build().get("/search/rooms", params={"q": "   "})
    assert res.status_code == 200
    all_rooms = await FakeClient().list_conversations()
    assert len(res.json()["rooms"]) == len(all_rooms)


def test_conversations_and_search_rooms_work_on_a_cold_app():
    # app.state.client is None until get_client() first runs -- the handlers
    # must call get_client(), not read app.state.client directly, or every
    # discovery request on a freshly started server 500s until an unrelated
    # POST /messages happens to populate the memo first.
    client = build_cold()
    assert client.get("/conversations").status_code == 200
    assert client.get("/search/rooms", params={"q": "trading"}).status_code == 200
