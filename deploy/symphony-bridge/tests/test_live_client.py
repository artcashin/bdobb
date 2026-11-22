"""Unit tests for app/live_client.py that need neither a pod nor the BDK.

`LiveClient` only imports `symphony.bdk.*` lazily, inside its methods (see
its module docstring) -- that seam means two things are testable in CI, with
the BDK absent, that were previously untested anywhere:

1. The attachment-encoding path (`_send_with_attachment`): base64-decoding
   `Attachment.data`, setting `.name` on the resulting file-like object (the
   BDK's multipart uploader reads the filename off exactly that attribute),
   and wrapping it in a one-element list the way `messages.send_message`
   expects. None of that touches `self._session()`, so a stub `messages`
   object with a `send_message` method is enough -- no BDK required.
2. That a missing BDK install produces `ModuleNotFoundError` naming
   `symphony` -- the failure a real deployment hits first if the `live`
   extra isn't installed (see Dockerfile and its comment). This is exercised
   here for real: this verification venv genuinely has no `symphony.bdk`
   installed, so no mocking is needed to prove it.
"""

import base64

import pytest

from app.client import Attachment, SendRequest
from app.config import load_config
from app.live_client import LiveClient


class _StubMessages:
    """Stands in for `bdk.messages()` -- records exactly what LiveClient
    hands it, never touches the network or the BDK."""

    def __init__(self):
        self.calls = []

    async def send_message(self, stream_id, message_ml, attachment=None):
        self.calls.append((stream_id, message_ml, attachment))

        class _Sent:
            message_id = "stub-message-id"

        return _Sent()


def _client() -> LiveClient:
    # cfg content is irrelevant here -- these tests never reach _session(),
    # so no pod host / credentials are actually used.
    return LiveClient(load_config({}))


async def test_send_with_attachment_decodes_bytes_and_names_the_blob():
    client = _client()
    messages = _StubMessages()
    att = Attachment(
        filename="widget-title.csv",
        content_type="text/csv",
        data=base64.b64encode(b"a,b,c\n1,2,3\n").decode(),
    )
    request = SendRequest(
        stream_id="room-1", message_ml="<messageML>table</messageML>", attachment=att
    )

    sent = await client._send_with_attachment(messages, request, att)

    assert sent.message_id == "stub-message-id"
    assert len(messages.calls) == 1
    stream_id, message_ml, attachment_arg = messages.calls[0]
    assert stream_id == "room-1"
    assert message_ml == "<messageML>table</messageML>"
    # One-element list, as the BDK's send_message expects for `attachment`.
    assert isinstance(attachment_arg, list)
    assert len(attachment_arg) == 1
    blob = attachment_arg[0]
    # The BDK's multipart uploader reads the filename off exactly this
    # attribute (see app/live_client.py's module docstring).
    assert blob.name == "widget-title.csv"
    assert blob.read() == b"a,b,c\n1,2,3\n"


async def test_missing_bdk_raises_modulenotfounderror_naming_symphony():
    # No mocking: this verification venv has no `symphony.bdk` installed,
    # by design (see the task brief / README) -- so this is the real failure
    # a live deployment hits first if the `live` extra isn't installed.
    client = _client()
    with pytest.raises(ModuleNotFoundError, match="symphony"):
        await client.send_message(
            SendRequest(
                stream_id="room-1", message_ml="<messageML>hi</messageML>", attachment=None
            )
        )
