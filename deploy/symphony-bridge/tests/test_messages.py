from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app


def build(env=None, client=None):
    fake = client or FakeClient()
    return TestClient(create_app({"BRIDGE_FAKE": "1", **(env or {})}, client=fake)), fake


def test_accepts_the_share_target_shape():
    # Spec F2-5: {streamId, markdown, title} must work with no BDOBB code.
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "markdown": "**hi**", "title": "T"})
    assert res.status_code == 200
    assert "<b>hi</b>" in fake.sent[0].message_ml


def test_accepts_the_widget_share_shape():
    # What the shipped client sends.
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML>hello</messageML>",
    })
    assert res.status_code == 200
    assert "hello" in fake.sent[0].message_ml


def test_accepts_an_attachment():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML>table</messageML>",
        "attachment": {"filename": "t.csv", "contentType": "text/csv", "data": "YQ=="},
    })
    assert res.status_code == 200
    assert fake.sent[0].attachment.filename == "t.csv"


def test_accepts_plain_text():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "text": "plain"})
    assert res.status_code == 200
    assert "plain" in fake.sent[0].message_ml


def test_rejects_a_body_with_no_content():
    api, _ = build()
    res = api.post("/messages", json={"streamId": "room-1"})
    assert res.status_code == 422


def test_rejects_more_than_one_content_field():
    api, _ = build()
    res = api.post("/messages", json={"streamId": "room-1", "text": "a", "markdown": "b"})
    assert res.status_code == 422


def test_attribution_includes_the_sender():
    api, fake = build()
    api.post("/messages", json={"streamId": "room-1", "text": "hi", "sender": "Art"})
    assert "Art via BDOBB" in fake.sent[0].message_ml


def test_attribution_degrades_without_a_sender():
    api, fake = build()
    api.post("/messages", json={"streamId": "room-1", "text": "hi"})
    sent = fake.sent[0].message_ml
    assert "via BDOBB" in sent
    assert "None" not in sent


def test_sender_cannot_inject_markup():
    api, fake = build()
    api.post("/messages", json={
        "streamId": "room-1", "text": "hi", "sender": "<script>x</script>",
    })
    assert "<script>" not in fake.sent[0].message_ml


def test_rejects_pre_rendered_messageml_with_a_disallowed_tag():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML><script>x</script></messageML>",
    })
    assert res.status_code == 400
    assert fake.sent == []


def test_allowlist_permits_a_listed_destination():
    api, fake = build({"BRIDGE_ALLOWED_DESTINATIONS": "room-1,room-2"})
    res = api.post("/messages", json={"streamId": "room-1", "text": "hi"})
    assert res.status_code == 200
    assert len(fake.sent) == 1


def test_allowlist_rejects_an_unlisted_destination_rather_than_dropping_it():
    api, fake = build({"BRIDGE_ALLOWED_DESTINATIONS": "room-1"})
    res = api.post("/messages", json={"streamId": "room-999", "text": "hi"})
    assert res.status_code == 403
    assert fake.sent == []


def test_no_allowlist_permits_any_destination():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "anything", "text": "hi"})
    assert res.status_code == 200
    assert len(fake.sent) == 1
