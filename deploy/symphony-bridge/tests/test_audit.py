import logging

from app.audit import log_send


def test_logs_destination_and_result(caplog):
    with caplog.at_level(logging.INFO):
        log_send(source="127.0.0.1", stream_id="room-1", body="secret text", result="ok")
    record = caplog.text
    assert "room-1" in record
    assert "ok" in record
    assert "127.0.0.1" in record


def test_never_logs_the_message_body(caplog):
    with caplog.at_level(logging.INFO):
        log_send(source="127.0.0.1", stream_id="room-1", body="secret text", result="ok")
    assert "secret text" not in caplog.text


def test_logs_a_content_hash_instead_of_the_body(caplog):
    with caplog.at_level(logging.INFO):
        log_send(source="127.0.0.1", stream_id="room-1", body="secret text", result="ok")
    # sha256("secret text") begins with this.
    assert "486a2d2a" in caplog.text
