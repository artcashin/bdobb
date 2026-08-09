from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app


def build():
    return TestClient(create_app({"BRIDGE_FAKE": "1"}, client=FakeClient()))


def test_conversations_returns_stream_ids_and_names():
    res = build().get("/conversations")
    assert res.status_code == 200
    items = res.json()["conversations"]
    assert items
    assert set(items[0]) == {"streamId", "name"}


def test_search_rooms_requires_a_query():
    assert build().get("/search/rooms").status_code == 422


def test_search_rooms_returns_matches():
    res = build().get("/search/rooms", params={"q": "trading"})
    assert res.status_code == 200
    rooms = res.json()["rooms"]
    assert rooms
    assert set(rooms[0]) == {"streamId", "name", "description"}


def test_search_rooms_returns_an_empty_list_for_no_matches():
    res = build().get("/search/rooms", params={"q": "zzzz"})
    assert res.status_code == 200
    assert res.json()["rooms"] == []


def test_search_rooms_empty_query_returns_all_rooms():
    res = build().get("/search/rooms", params={"q": ""})
    assert res.status_code == 200
    assert len(res.json()["rooms"]) == 3
