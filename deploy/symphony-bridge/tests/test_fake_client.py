from app.client import Attachment, SendRequest
from app.fake_client import FakeClient


async def test_health_reports_connected():
    status = await FakeClient().health()
    assert status.connected is True


async def test_send_returns_a_message_id():
    client = FakeClient()
    result = await client.send_message(
        SendRequest(stream_id="room-1", message_ml="<messageML>hi</messageML>", attachment=None)
    )
    assert result.message_id


async def test_send_records_what_it_was_asked_to_send():
    client = FakeClient()
    await client.send_message(
        SendRequest(stream_id="room-1", message_ml="<messageML>hi</messageML>", attachment=None)
    )
    assert len(client.sent) == 1
    assert client.sent[0].stream_id == "room-1"


async def test_send_records_attachments():
    client = FakeClient()
    await client.send_message(
        SendRequest(
            stream_id="room-1",
            message_ml="<messageML>table</messageML>",
            attachment=Attachment(filename="t.csv", content_type="text/csv", data="YQ=="),
        )
    )
    assert client.sent[0].attachment is not None
    assert client.sent[0].attachment.filename == "t.csv"


async def test_message_ids_are_unique():
    client = FakeClient()
    req = SendRequest(stream_id="r", message_ml="<messageML>x</messageML>", attachment=None)
    first = await client.send_message(req)
    second = await client.send_message(req)
    assert first.message_id != second.message_id


async def test_list_conversations_returns_stable_fixtures():
    conversations = await FakeClient().list_conversations()
    assert len(conversations) >= 1
    assert all(c.stream_id and c.name for c in conversations)


async def test_search_rooms_filters_by_query():
    client = FakeClient()
    hits = await client.search_rooms("trading")
    assert all("trading" in room.name.lower() for room in hits)


async def test_search_rooms_is_case_insensitive():
    client = FakeClient()
    assert await client.search_rooms("TRADING") == await client.search_rooms("trading")
