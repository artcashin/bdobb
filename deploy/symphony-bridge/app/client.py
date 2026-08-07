"""The seam. Everything above this file is transport-agnostic; the only code
that knows Symphony exists is an implementation of SymphonyClient."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Attachment:
    filename: str
    content_type: str
    data: str  # base64, no data: prefix


@dataclass(frozen=True)
class SendRequest:
    stream_id: str
    message_ml: str
    attachment: Attachment | None


@dataclass(frozen=True)
class SendResult:
    message_id: str | None


@dataclass(frozen=True)
class Conversation:
    stream_id: str
    name: str


@dataclass(frozen=True)
class Room:
    stream_id: str
    name: str
    description: str


@dataclass(frozen=True)
class HealthStatus:
    connected: bool
    detail: str


class SymphonyClient(Protocol):
    async def health(self) -> HealthStatus: ...

    async def send_message(self, request: SendRequest) -> SendResult: ...

    async def list_conversations(self) -> list[Conversation]: ...

    async def search_rooms(self, query: str) -> list[Room]: ...
