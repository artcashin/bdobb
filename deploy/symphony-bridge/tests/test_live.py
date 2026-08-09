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

import os

import pytest

from app.client import SendRequest
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


async def test_lists_conversations():
    assert await LiveClient(load_config()).list_conversations() is not None
