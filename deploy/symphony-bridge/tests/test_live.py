"""Opt-in. Requires a real sandbox pod and bot credentials:

    SYMPHONY_LIVE=1 SYMPHONY_POD_HOST=... SYMPHONY_AGENT_HOST=... \
    SYMPHONY_BOT_USERNAME=... SYMPHONY_BOT_KEY_PATH=... \
    SYMPHONY_TEST_STREAM=... python -m pytest tests/test_live.py -v

Also requires the `live` extra installed (`pip install -e .[live]`) so
`app.live_client`'s lazy `symphony.bdk` import succeeds once a test actually
runs.

Never runs in CI. Safe to collect with SYMPHONY_LIVE unset and with no BDK
installed at all: `app.live_client` only imports `symphony.bdk.*` inside its
methods, never at module scope, so importing `LiveClient` here -- even
without the BDK installed -- cannot raise. That is what keeps this file
skipping cleanly instead of erroring at collection time, which is the one
thing it must never do to CI.
"""

import base64
import os

import pytest

from app.client import Attachment, SendRequest
from app.config import load_config
from app.live_client import LiveClient

pytestmark = pytest.mark.skipif(
    os.environ.get("SYMPHONY_LIVE") != "1",
    reason="live suite; set SYMPHONY_LIVE=1 with real pod credentials",
)


async def test_authenticates_against_the_pod():
    status = await LiveClient(load_config()).health()
    assert status.connected is True


async def test_sends_a_real_message():
    stream = os.environ["SYMPHONY_TEST_STREAM"]
    result = await LiveClient(load_config()).send_message(
        SendRequest(
            stream_id=stream,
            message_ml="<messageML>bridge live test</messageML>",
            attachment=None,
        )
    )
    assert result.message_id


async def test_sends_a_real_message_with_an_attachment():
    # Fix 6: the live suite previously covered auth, a plain send, and
    # list_streams unwrapping, but never the attachment path -- one of the
    # two shapes Fix 1's ApiAttributeError defect actually lived in
    # (`sent.message_id` after a `send_message(..., attachment=[...])` call
    # is the exact same access as the plain-send case, but only this
    # exercises `_send_with_attachment`'s blob-naming/encoding against a
    # real pod, not just against the stub in tests/test_live_client.py).
    stream = os.environ["SYMPHONY_TEST_STREAM"]
    result = await LiveClient(load_config()).send_message(
        SendRequest(
            stream_id=stream,
            message_ml="<messageML>bridge live attachment test</messageML>",
            attachment=Attachment(
                filename="bridge-live-test.txt",
                content_type="text/plain",
                data=base64.b64encode(b"bridge live test attachment").decode(),
            ),
        )
    )
    assert result.message_id


async def test_lists_conversations():
    conversations = await LiveClient(load_config()).list_conversations()
    assert isinstance(conversations, list)
    # Stronger than "is not None": that tautology only proves no exception
    # was raised. This proves list_streams()'s StreamList.value actually
    # unwrapped into real Conversation objects with the shapes this bridge
    # promises (non-empty str stream_id, str name) -- the exact unwrapping
    # Fix 1 was about.
    assert conversations, "bot has no streams -- can't confirm the unwrapping"
    assert all(isinstance(c.stream_id, str) and c.stream_id for c in conversations)
    assert all(isinstance(c.name, str) for c in conversations)


async def test_searches_rooms():
    # Fix 6: the live suite never exercised search_rooms() at all -- the
    # other shape Fix 1's ApiAttributeError defect lived in (an ordinary
    # room with no description used to 500 GET /search/rooms outright).
    # SYMPHONY_TEST_ROOM_QUERY lets an operator point this at a query known
    # to match something on their pod; the default is broad enough to
    # plausibly match on most pods, but even zero matches still proves
    # search_rooms() and its V3RoomSearchResults/V3RoomDetail unwrapping run
    # to completion against a real pod without raising.
    query = os.environ.get("SYMPHONY_TEST_ROOM_QUERY", "a")
    rooms = await LiveClient(load_config()).search_rooms(query)
    assert isinstance(rooms, list)
    for room in rooms:
        assert isinstance(room.stream_id, str)
        assert isinstance(room.name, str)
        # "" not None even when absent upstream -- see Fix 1.
        assert isinstance(room.description, str)
