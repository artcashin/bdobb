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
- `list_conversations`/`search_rooms` return at most 50 items each (the
  BDK's own `list_streams`/`search_rooms` default `limit`); neither paginates
  via the BDK's `list_all_streams`/`search_all_rooms` generators. Silent
  truncation past 50 conversations/matching rooms on a real pod -- see the
  comments at each call site and the README.
- The retry budget (`"retry": {"maxAttempts": 2}` in `_session`, below) is
  deliberately narrower than the BDK's own default (10 attempts, up to ~9
  minutes of backoff) -- this bounds request latency but makes a
  send-during-a-transient-failure at-least-once, not exactly-once. See the
  comment there.
- `Dockerfile` installs the `live` extra (`pip install ".[live]"`) so the
  image can actually run live mode -- see the comment in `Dockerfile` for why
  that extra was previously never installed and the choice made here.
- Whether `LiveClient.__init__` no longer raising (it only stores `cfg`)
  changed the operator-facing failure classification for a missing BDK on a
  real deployment: the `symphony.bdk` import now happens inside
  `send_message`/`list_conversations`/`search_rooms`/`health` (via
  `_session`), not at client construction, so a missing BDK install now
  surfaces as `send_message`'s own `except Exception` in `app/main.py` --
  502, audited -- rather than `get_client()`'s 503, unaudited. No invariant
  is broken (the audit record still carries only service-constructed
  strings), but this is a real classification change from what an earlier
  version of this code path did, and it is the single most likely first-run
  failure mode until the `live` extra is actually installed and exercised
  against a real pod. See `tests/test_messages.py` for the test pinning it.
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
                        # BdkRetryConfig's own defaults are max_attempts=10,
                        # 500ms initial backoff, x2 multiplier, capped at 5
                        # minutes per attempt -- unbounded enough that a pod
                        # outage would make a single POST /messages block for
                        # roughly 8-9 minutes before this bridge ever returns,
                        # with nothing else here imposing a timeout. Bounded
                        # to 2 attempts (one retry) instead: worst case adds
                        # about one initial-interval's worth of latency
                        # (~500ms) to a failed call, not minutes. Trade-off:
                        # the BDK's retry -- bounded or not -- resends a
                        # request that may have already been delivered (e.g.
                        # the pod accepted it but the response was lost), so
                        # this keeps send_message at-least-once, not
                        # exactly-once, on transient failures. That was
                        # already true with the unbounded default; this only
                        # bounds how long the caller waits to find out.
                        "retry": {"maxAttempts": 2},
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
        # `message_id` is documented `[optional]` on the generated `V4Message`
        # model, which is deserialized via `_from_openapi_data` -- unlike
        # `__init__`, that classmethod does not pre-seed absent optional
        # fields, so a plain `sent.message_id` can raise `ApiAttributeError`
        # and turn a *successful* send into a 502 (confirmed empirically;
        # see task-7-report.md). `SendResult.message_id` is already
        # `str | None`, so getattr(..., None) costs nothing here.
        return SendResult(message_id=getattr(sent, "message_id", None))

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
        #
        # list_streams()'s own default limit=50 applies here -- this bridge
        # passes neither `skip` nor `limit`, so a bot in more than 50 streams
        # silently only sees the first 50 (oldest-created-first). The BDK
        # offers `list_all_streams()`, an async-generator that paginates
        # automatically; not used here to keep this a single call rather than
        # an unbounded fetch of a bot's entire stream history. Documented,
        # not silent -- see README.md's `/conversations` entry.
        result = await bdk.streams().list_streams(StreamFilter())
        # `value` is genuinely schema-required for `StreamList` (its own
        # `__init__` raises without it, and its generated docstring carries
        # no "[optional]" marker, unlike every field read below) -- kept as a
        # plain attribute access rather than getattr, to keep that
        # distinction visible instead of blanket-guarding a field the schema
        # itself guarantees.
        streams = result.value if result is not None else []
        conversations = []
        for s in streams:
            # Generated response models are deserialized via
            # `_from_openapi_data`, which -- unlike `__init__` -- does not
            # pre-seed absent optional fields, so reading an absent optional
            # attribute raises `ApiAttributeError` instead of returning None
            # (confirmed empirically; see task-7-report.md). `room_attributes`,
            # its `.name`, and `StreamAttributes.id` are all documented
            # `[optional]` on their generated models -- getattr(..., None)
            # at every level one of those is read, not just where it was
            # originally guarded. Only room-type streams carry
            # room_attributes at all; IMs/MIMs fall back to the stream id,
            # same fallback shape the brief's sketch used (just reached
            # through the real, possibly-absent fields, not flat ones
            # guaranteed present).
            room = getattr(s, "room_attributes", None)
            room_name = getattr(room, "name", None) if room is not None else None
            stream_id = getattr(s, "id", None)
            conversations.append(
                Conversation(stream_id=stream_id or "", name=room_name or stream_id or "")
            )
        return conversations

    async def search_rooms(self, query: str) -> list[Room]:
        from symphony.bdk.gen.pod_model.v2_room_search_criteria import V2RoomSearchCriteria

        bdk = await self._session()
        # search_rooms()'s own default limit=50 applies here too (same cap,
        # same reason, as list_conversations above) -- more than 50 matching
        # rooms silently truncates. The BDK offers `search_all_rooms()` for
        # the unbounded case; not used here for the same reason. Documented
        # in README.md's `/search/rooms` entry.
        result = await bdk.streams().search_rooms(V2RoomSearchCriteria(query=query))
        # Generated response models are deserialized via `_from_openapi_data`,
        # which -- unlike `__init__` -- does not pre-seed absent optional
        # fields, so reading an absent optional attribute raises
        # `ApiAttributeError` instead of returning None (confirmed
        # empirically; see task-7-report.md). `rooms`, `room_attributes`,
        # `room_system_info`, and every leaf read off them (`.name`,
        # `.description`, `.id`) are all documented `[optional]` on their
        # generated models -- getattr(..., None) at every level, not just the
        # parts originally guarded. Without this, `GET /search/rooms` (which
        # has no try/except of its own) 500s on any ordinary room with no
        # description, not just a malformed response.
        rooms = getattr(result, "rooms", None) or []
        out = []
        for r in rooms:
            attrs = getattr(r, "room_attributes", None)
            info = getattr(r, "room_system_info", None)
            out.append(
                Room(
                    stream_id=getattr(info, "id", None) or "",
                    name=getattr(attrs, "name", None) or "",
                    description=getattr(attrs, "description", None) or "",
                )
            )
        return out
