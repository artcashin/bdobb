"""Symphony BDK implementation. The BDK owns session and key-manager token
refresh, which is why the spec chose it over hand-rolled REST -- and it also
owns Multipart file naming/mime-typing for attachments (see
_send_with_attachment below).

Untested against a real pod at the time of writing -- there is no sandbox pod
or bot credentials available in this environment (see tests/test_live.py).
Every method/field name below was cross-checked against the actual
`symphony-bdk-python` v2.11.2 source on GitHub (finos/symphony-bdk-python),
not guessed from the task brief's sketch -- the brief's own sketch had two
concrete bugs relative to that source, both fixed here:

1. `BdkConfigLoader.load_from_content()` takes a JSON/YAML **string**, not a
   dict (`BdkConfigParser.parse` calls `json.loads` on it) -- the brief
   passed the dict directly, which would raise ``TypeError`` immediately.
   Fixed by `json.dumps(...)`-ing the config dict first.
2. `StreamService.list_streams()` requires a `StreamFilter` object (not
   `None`) and returns a `StreamList`, whose actual items live under
   `.value` -- not the list itself. `StreamService.search_rooms()` takes a
   `V2RoomSearchCriteria` object (not a bare string) and returns a
   `V3RoomSearchResults` whose rooms live under `.rooms`, each a
   `V3RoomDetail` with `.room_attributes` (name/description) and
   `.room_system_info` (id) -- not flat `.name`/`.id`/`.description`
   attributes. Fixed by constructing the real filter/criteria types and
   unwrapping the real response shape.

What remains genuinely unverified (no pod to run this against):
- Whether `SymphonyBdk(config)` construction ever performs blocking I/O
  (reading the private key file, say) that would want `asyncio.to_thread`.
  Its `__init__`, read from source, does no I/O eagerly -- everything is
  built lazily behind the auth session -- so this should be safe to call
  directly, but that has not been exercised against a real key file.
- The exact wire-level error shapes/messages a real pod returns on auth or
  send failure (used here only via `str(exc)`, never parsed).
- `Attachment.content_type` is accepted by our protocol but the BDK's own
  multipart upload path (`ApiClient.files_parameters`) ignores whatever
  content-type is passed and instead derives one from
  `mimetypes.guess_type(filename)` -- confirmed by reading that method's
  source. There is no argument in this BDK's `send_message` that lets a
  caller override it, so `Attachment.content_type` is accepted (as required
  by the shared protocol) but has no effect against a real pod.
"""

import base64
import io
import json

from app.client import (
    Attachment,
    Conversation,
    HealthStatus,
    Room,
    SendRequest,
    SendResult,
)
from app.config import Config


class LiveClient:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._bdk = None

    async def _session(self):
        """Lazily build the BDK session so importing this module -- and
        constructing a LiveClient -- never requires the BDK package or
        credentials. If the `symphony-bdk-python` package isn't installed,
        this raises ModuleNotFoundError with Python's own clear message
        (no import happens at module scope, so app startup / the rest of
        the test suite is unaffected either way)."""
        if self._bdk is None:
            from symphony.bdk.core.config.loader import BdkConfigLoader
            from symphony.bdk.core.symphony_bdk import SymphonyBdk

            config = BdkConfigLoader.load_from_content(
                json.dumps(
                    {
                        "host": self._cfg.pod_host,
                        "agent": {"host": self._cfg.agent_host},
                        "bot": {
                            "username": self._cfg.bot_username,
                            "privateKey": {"path": self._cfg.bot_key_path},
                        },
                    }
                )
            )
            self._bdk = SymphonyBdk(config)
        return self._bdk

    async def health(self) -> HealthStatus:
        try:
            bdk = await self._session()
            # sessions().get_session() exercises the real bot auth flow (RSA
            # signing against the pod, session-token retrieval) -- a
            # stronger signal than a bare agent ping that the bot identity
            # this bridge posts as is actually usable.
            await bdk.sessions().get_session()
            return HealthStatus(connected=True, detail="pod session established")
        except Exception as exc:  # noqa: BLE001 -- deliberately broad: a health
            # check's entire job is to turn "anything went wrong talking to the
            # pod" into connected=False rather than raising, so the caller
            # (GET /health) can report status instead of 500ing.
            return HealthStatus(connected=False, detail=str(exc))

    async def send_message(self, request: SendRequest) -> SendResult:
        bdk = await self._session()
        messages = bdk.messages()
        if request.attachment is not None:
            sent = await self._send_with_attachment(messages, request, request.attachment)
        else:
            sent = await messages.send_message(request.stream_id, request.message_ml)
        return SendResult(message_id=sent.message_id)

    async def _send_with_attachment(self, messages, request: SendRequest, att: Attachment):
        # Attachment.data is base64 with no `data:` prefix (the shared
        # dataclass makes no assumptions about encoding) -- decoding to raw
        # bytes belongs here, the one place that knows the BDK wants a real
        # file-like object.
        blob = io.BytesIO(base64.b64decode(att.data))
        # The BDK's multipart uploader reads the filename off `.name`
        # (`os.path.basename(file_instance.name)`) and derives the
        # content-type from that filename itself, ignoring
        # `att.content_type` entirely -- see module docstring.
        blob.name = att.filename
        return await messages.send_message(
            request.stream_id, request.message_ml, attachment=[blob]
        )

    async def list_conversations(self) -> list[Conversation]:
        from symphony.bdk.gen.pod_model.stream_filter import StreamFilter

        bdk = await self._session()
        # No stream_types/include_inactive_streams -- an unfiltered
        # StreamFilter() returns every stream type the bot is a member of,
        # same "no filter configured" default used elsewhere in this
        # service (see Config.allowed_destinations).
        result = await bdk.streams().list_streams(StreamFilter())
        streams = result.value if result is not None else []
        conversations = []
        for s in streams:
            # Only room-type streams carry room_attributes; IMs/MIMs don't
            # have a name in this API at all, so those fall back to the
            # stream id, same fallback shape the brief's sketch used (just
            # reached through the real field, not a nonexistent flat one).
            room = getattr(s, "room_attributes", None)
            name = room.name if room is not None and room.name else s.id
            conversations.append(Conversation(stream_id=s.id, name=name))
        return conversations

    async def search_rooms(self, query: str) -> list[Room]:
        from symphony.bdk.gen.pod_model.v2_room_search_criteria import V2RoomSearchCriteria

        bdk = await self._session()
        result = await bdk.streams().search_rooms(V2RoomSearchCriteria(query=query))
        rooms = result.rooms if result is not None and result.rooms else []
        return [
            Room(
                stream_id=r.room_system_info.id,
                name=r.room_attributes.name,
                description=r.room_attributes.description or "",
            )
            for r in rooms
        ]
