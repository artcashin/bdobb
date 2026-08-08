import base64
import logging
import re
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


# -- Task 4 Fix 3: `streamId` must not be able to forge audit log lines.


def test_stream_id_with_newline_is_422():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1\nsend source=127.0.0.1 stream=forged sha256=deadbeef result=ok",
        "text": "hi",
    })
    assert res.status_code == 422
    assert fake.sent == []


def test_stream_id_with_control_character_is_422():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1\x07bell", "text": "hi"})
    assert res.status_code == 422
    assert fake.sent == []


def test_stream_id_is_stored_and_logged_stripped(caplog):
    # What gets validated must be what gets logged and sent -- a mismatch
    # (e.g. storing the raw value while a stripped copy was validated) is
    # exactly how a crafted streamId could forge audit lines.
    api, fake = build()
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        res = api.post("/messages", json={"streamId": "  room-1  ", "text": "hi"})
    assert res.status_code == 200
    assert fake.sent[0].stream_id == "room-1"
    assert "stream=room-1 sha256=" in caplog.text


# -- Task 4 Fix 4: an unauthenticated `sender` must not be able to force a 500.


def test_sender_with_control_character_is_accepted_not_500():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1", "text": "hi", "sender": "Art\x01\x0bCashin",
    })
    assert res.status_code == 200
    sent = fake.sent[0].message_ml
    ElementTree.fromstring(sent)  # must still be well-formed XML
    assert "\x01" not in sent
    assert "\x0b" not in sent


def test_message_body_with_control_character_still_400s():
    # Same illegal byte, different path: the body reaches sanitize() (and
    # ElementTree parsing) directly and is correctly rejected there -- only
    # the sender-splice path used to slip past that check and 500 instead.
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1", "messageML": "<messageML>hi\x01there</messageML>",
    })
    assert res.status_code == 400
    assert fake.sent == []


# -- Task 4 Fix 5: CDATA content counts as content, not markup, for the
# empty-content check.


def test_cdata_only_content_is_accepted_not_treated_as_empty():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML><![CDATA[a<b&c]]></messageML>",
    })
    assert res.status_code == 200
    assert fake.sent


def test_text_before_cdata_still_passes():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML>ok<![CDATA[a<b]]></messageML>",
    })
    assert res.status_code == 200
    assert fake.sent


# -- Task 4 Fix 6: MIME line-wrapped base64 attachments must be accepted;
# empty base64 data must be rejected.


def test_line_wrapped_base64_attachment_is_accepted():
    api, fake = build()
    wrapped = "YWJj\nZGVm\n"  # base64("abcdef"), split across MIME-style lines
    res = api.post("/messages", json={
        "streamId": "room-1",
        "text": "hi",
        "attachment": {"filename": "t.csv", "contentType": "text/csv", "data": wrapped},
    })
    assert res.status_code == 200
    assert fake.sent[0].attachment.data == "YWJjZGVm"


def test_empty_base64_attachment_data_is_422():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "text": "hi",
        "attachment": {"filename": "t.csv", "contentType": "text/csv", "data": ""},
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


# Redaction of arbitrary upstream exception text is unwinnable: real
# Symphony / HTTP-client errors echo the request payload in many shapes, and
# an exact-substring redaction (matching only a byte-for-byte echo of the
# *whole* assembled document) misses nearly all of them -- a partial echo, a
# reflowed/reformatted echo, or an encoded echo all sail through untouched.
# The fix is structural instead: the audit record is built only from values
# this service itself constructs (the exception's type name, plus an HTTP
# status code if one can be pulled out with a narrow, strict pattern) and
# never from str(exc) at all. str(exc) still reaches the caller in the 502
# detail -- the caller already has the body, so nothing new is disclosed
# there.

# Short enough to survive even a 40-char echo prefixed with other text.
_LEAK_MARKER = "ACME-Q3-CONFIDENTIAL"


def _raising_client(build_message):
    class _Client:
        async def send_message(self, request):
            raise RuntimeError(build_message(request.message_ml))

    return _Client()


def _audit_records(caplog):
    return [r for r in caplog.records if r.name == AUDIT_LOGGER]


def test_symphony_send_failure_returns_502_with_the_symphony_error():
    # The caller-facing detail is a different concern from the audit log:
    # the caller already sent the body, so echoing it back in the 502
    # discloses nothing new.
    api = TestClient(
        create_app(
            {"BRIDGE_FAKE": "1"}, client=_raising_client(lambda ml: f"upstream said {ml}")
        )
    )
    res = api.post("/messages", json={"streamId": "room-1", "text": _LEAK_MARKER})
    assert res.status_code == 502
    assert _LEAK_MARKER in res.json()["detail"]


# Realistic shapes a Symphony/HTTP-client error's str(exc) can take -- each
# echoes the assembled document (`ml`, the full final <messageML>...
# </messageML> the fake client received) in a way the old exact-substring
# redaction did not catch.
_EXCEPTION_SHAPES = {
    "full_echo": lambda ml: f"upstream said {ml}",
    "first_40_chars_echo": lambda ml: f"upstream said {ml[:40]}",
    "inner_content_without_root_tags": lambda ml: (
        f"invalid content: {ml.removeprefix('<messageML>').removesuffix('</messageML>')}"
    ),
    "json_wrapped": lambda ml: f'upstream said {{"messageML": {ml!r}}}',
    "br_reflowed_to_newline": lambda ml: f"payload was {ml.replace('<br/>', chr(10))}",
    "base64_encoded": lambda ml: f"payload(b64)={base64.b64encode(ml.encode()).decode()}",
}


def test_symphony_send_failure_audit_never_leaks_the_body(caplog):
    for shape_name, build_message in _EXCEPTION_SHAPES.items():
        api = TestClient(create_app({"BRIDGE_FAKE": "1"}, client=_raising_client(build_message)))
        caplog.clear()
        with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
            res = api.post(
                "/messages", json={"streamId": f"room-{shape_name}", "text": _LEAK_MARKER}
            )
        assert res.status_code == 502, shape_name
        records = _audit_records(caplog)
        assert records, f"no audit record for shape {shape_name!r}"
        joined = "\n".join(r.getMessage() for r in records)
        assert _LEAK_MARKER not in joined, f"body marker leaked for shape {shape_name!r}: {joined}"
        assert "RuntimeError" in joined, f"exception type missing for shape {shape_name!r}"


_AUDIT_ERROR_RESULT_RE = re.compile(r"result=error: RuntimeError(?: status=\d{3})?$")


def test_symphony_send_failure_audit_result_is_exception_type_only(caplog):
    # Stronger than "the marker is absent": the audit `result` field must
    # contain *nothing* derived from str(exc) beyond the exception's type
    # name and (optionally) a status code -- not merely this one marker.
    api = TestClient(
        create_app(
            {"BRIDGE_FAKE": "1"},
            client=_raising_client(lambda ml: f"HTTP 400 from agent; payload was {ml}"),
        )
    )
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        res = api.post("/messages", json={"streamId": "room-1", "text": _LEAK_MARKER})
    assert res.status_code == 502
    records = _audit_records(caplog)
    assert len(records) == 1
    assert _AUDIT_ERROR_RESULT_RE.search(records[0].getMessage())


# -- Fix 7: allowlist denials are a security event and must be logged.


def test_allowlist_denial_is_logged_with_hash_and_no_body(caplog):
    api = TestClient(create_app({"BRIDGE_ALLOWED_DESTINATIONS": "room-1"}))
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER):
        res = api.post("/messages", json={"streamId": "room-999", "text": "secret payload"})
    assert res.status_code == 403
    assert "refused: destination not allowed" in caplog.text
    assert "room-999" in caplog.text
    assert "secret payload" not in caplog.text
