import logging
from xml.etree import ElementTree

from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app

AUDIT_LOGGER = "symphony_bridge.audit"


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


# -- Fix 1: attribute() must not produce malformed XML for bodies sanitize
# accepts verbatim (whitespace padding, root attributes, self-closing root).


def test_trailing_newline_after_messageml_is_assembled_correctly():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1", "messageML": "<messageML>hi</messageML>\n",
    })
    assert res.status_code == 200
    sent = fake.sent[0].message_ml
    root = ElementTree.fromstring(sent)  # raises if malformed / junk after root
    assert root.tag == "messageML"


def test_trailing_space_after_messageml_is_assembled_correctly():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1", "messageML": "<messageML>hi</messageML> ",
    })
    assert res.status_code == 200
    sent = fake.sent[0].message_ml
    ElementTree.fromstring(sent)


def test_leading_newline_before_messageml_is_assembled_correctly():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1", "messageML": "\n<messageML>hi</messageML>",
    })
    assert res.status_code == 200
    sent = fake.sent[0].message_ml
    ElementTree.fromstring(sent)


def test_root_attributes_are_rejected_not_spliced_into_junk():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1", "messageML": '<messageML foo="bar">hi</messageML>',
    })
    assert res.status_code == 400
    assert fake.sent == []


def test_self_closing_root_is_rejected():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "messageML": "<messageML/>"})
    # An empty self-closing root also has no content -- caught by the
    # empty-content guard (Fix 4) before the splice would even be attempted.
    assert res.status_code == 422
    assert fake.sent == []


# -- Fix 3: `sender` must be escaped, never rendered as markdown.


def test_sender_asterisks_are_literal_not_rendered():
    api, fake = build()
    api.post("/messages", json={"streamId": "room-1", "text": "hi", "sender": "*evil*"})
    sent = fake.sent[0].message_ml
    assert "<i>evil</i>" not in sent
    assert "*evil*" in sent


def test_sender_link_syntax_is_literal_not_rendered():
    api, fake = build()
    api.post("/messages", json={
        "streamId": "room-1", "text": "hi", "sender": "[click](https://evil.com)",
    })
    sent = fake.sent[0].message_ml
    assert "<a href=" not in sent
    assert "[click](https://evil.com)" in sent


# -- Fix 4: endpoint guards the brief's own constraints required.


def test_blank_stream_id_is_422():
    api, _ = build()
    res = api.post("/messages", json={"streamId": "   ", "text": "hi"})
    assert res.status_code == 422


def test_empty_text_is_422_not_an_attribution_only_message():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "text": ""})
    assert res.status_code == 422
    assert fake.sent == []


def test_whitespace_only_text_is_422():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "text": "   "})
    assert res.status_code == 422
    assert fake.sent == []


def test_invalid_base64_attachment_data_is_422():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "text": "hi",
        "attachment": {"filename": "t.csv", "contentType": "text/csv", "data": "not-base64!!"},
    })
    assert res.status_code == 422
    assert fake.sent == []


# -- Fix 5: client construction failure must be its own error, not a send failure.


def test_client_construction_failure_is_503_with_no_audit_record(caplog):
    # Live mode (BRIDGE_FAKE unset), no client override: get_client() must
    # try to import app.live_client, which does not exist in this repo.
    api = TestClient(create_app({}))
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        res = api.post("/messages", json={"streamId": "room-1", "text": "hi"})
    assert res.status_code == 503
    assert "stream=room-1" not in caplog.text


# -- Fix 6: a failed send must surface the Symphony error, never a silent
# success or a bare 500 -- and must not put the message body in the audit log.


class _RaisingClient:
    async def send_message(self, request):
        raise RuntimeError(f"HTTP 400 from agent; request payload was {request.message_ml}")


def test_symphony_send_failure_returns_502_with_the_symphony_error():
    api = TestClient(create_app({"BRIDGE_FAKE": "1"}, client=_RaisingClient()))
    res = api.post("/messages", json={"streamId": "room-1", "text": "CONFIDENTIAL"})
    assert res.status_code == 502
    assert "CONFIDENTIAL" in res.json()["detail"]


def test_symphony_send_failure_is_audited_with_exception_type_and_no_body(caplog):
    api = TestClient(create_app({"BRIDGE_FAKE": "1"}, client=_RaisingClient()))
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        res = api.post("/messages", json={"streamId": "room-1", "text": "CONFIDENTIAL"})
    assert res.status_code == 502
    assert "RuntimeError" in caplog.text
    assert "room-1" in caplog.text
    assert "CONFIDENTIAL" not in caplog.text


# -- Fix 7: allowlist denials are a security event and must be logged.


def test_allowlist_denial_is_logged_with_hash_and_no_body(caplog):
    api = TestClient(create_app({"BRIDGE_ALLOWED_DESTINATIONS": "room-1"}))
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        res = api.post("/messages", json={"streamId": "room-999", "text": "secret payload"})
    assert res.status_code == 403
    assert "refused: destination not allowed" in caplog.text
    assert "room-999" in caplog.text
    assert "secret payload" not in caplog.text
