"""Credential-free implementation. This is a first-class feature, not a test
double: it is what makes every endpoint verifiable before a sandbox pod exists,
and CI runs entirely against it."""

import itertools

from app.client import (
    Conversation,
    HealthStatus,
    Room,
    SendRequest,
    SendResult,
)

_FIXTURE_ROOMS = (
    Room(stream_id="fake-trading-desk", name="Trading Desk", description="Desk chatter"),
    Room(stream_id="fake-research", name="Research", description="Research notes"),
    Room(stream_id="fake-ops", name="Operations", description="Ops alerts"),
)


class FakeClient:
    """Accepts everything the live client accepts and records it."""

    def __init__(self) -> None:
        self.sent: list[SendRequest] = []
        self._ids = itertools.count(1)

    async def health(self) -> HealthStatus:
        return HealthStatus(connected=True, detail="fake client; no pod session")

    async def send_message(self, request: SendRequest) -> SendResult:
        self.sent.append(request)
        return SendResult(message_id=f"fake-msg-{next(self._ids)}")

    async def list_conversations(self) -> list[Conversation]:
        return [Conversation(stream_id=r.stream_id, name=r.name) for r in _FIXTURE_ROOMS]

    async def search_rooms(self, query: str) -> list[Room]:
        needle = query.lower()
        return [r for r in _FIXTURE_ROOMS if needle in r.name.lower()]
