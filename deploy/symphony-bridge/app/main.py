"""FastAPI application."""

import re
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from mcp.server.transport_security import TransportSecurityMiddleware, TransportSecuritySettings
from starlette.types import ASGIApp, Receive, Scope, Send

from app.audit import log_send
from app.client import (
    Attachment,
    Conversation,
    HealthStatus,
    Room,
    SendRequest,
    SendResult,
    SymphonyClient,
)
from app.config import Config, load_config
from app.fake_client import FakeClient
from app.mcp_server import build_mcp
from app.messageml import MessageMLError, markdown_to_messageml, sanitize
from app.models import SendMessageBody

ATTRIBUTION_SUFFIX = "via BDOBB"

_TAG_RE = re.compile(r"<[^>]+>")
_CDATA_RE = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.DOTALL)

# A strict, narrow pattern for pulling an HTTP status code out of an upstream
# exception's text -- the only thing besides the exception's type name that
# is ever allowed into the audit log's `result` field. See the `except`
# block in send_message for why str(exc) itself never goes there.
_HTTP_STATUS_RE = re.compile(r"\b[45]\d\d\b")

# XML 1.0 Char production excludes these even when escaped: C0 controls
# other than tab/CR/LF, and (on a narrow build) lone surrogates. A `sender`
# containing one would make sanitize(final) reject our own assembly.
_XML_ILLEGAL_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")

_ML_OPEN = "<messageML>"
_ML_CLOSE = "</messageML>"
# The canonical serialization ElementTree.tostring() produces for a root
# element with no text and no children -- the one self-closing shape
# sanitize() itself can actually hand back (see _extract_body below).
_ML_SELF_CLOSED = "<messageML />"


def _escape_plain(text: str) -> str:
    """Escape text for a MessageML text node without interpreting markdown.
    Same character set markdown_to_messageml escapes -- but no rendering.
    XML-illegal control characters are stripped first: unlike the message
    body (which reaches sanitize() directly and is correctly rejected as
    malformed XML), `sender` is spliced into `final` after body validation,
    so a stray control byte there would only surface as our own re-validation
    failing on our own assembly -- a 500, not a 400."""
    text = _XML_ILLEGAL_RE.sub("", text)
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def _extract_body(message_ml: str) -> str:
    """Pull the inner content out of a document that has already passed
    sanitize(). sanitize() no longer returns the caller's original string
    verbatim -- it re-serializes from the parsed tree -- so most of the
    shapes a naive removeprefix/removesuffix splice used to have to worry
    about (surrounding whitespace, root attributes) can no longer reach here
    at all: ElementTree.fromstring() discards surrounding whitespace, and
    sanitize()'s own attribute-allowlist check rejects a root with any
    attribute (messageML allows none) before this function ever runs. One
    shape *can* still reach here: an empty root re-serializes to the
    self-closing form "<messageML />" (a space before "/>", ElementTree's
    canonical form for an element with no text and no children), handled
    explicitly below. Require the exact literal form otherwise
    (whitespace-trimmed) so splicing is safe; reject anything else instead
    of silently producing unbalanced XML."""
    stripped = message_ml.strip()
    if stripped == _ML_SELF_CLOSED:
        # In the current /messages flow this never actually fires:
        # send_message's _is_empty_content(safe) check rejects an empty body
        # with 422 before attribute() (and so _extract_body) ever runs on
        # it. Handled explicitly anyway, rather than left to accidentally
        # fall through to the mismatch rejection below (which happens to
        # also reject it, but only because "<messageML />" doesn't match
        # the literal-string checks that follow -- not because anyone
        # decided it should) -- so this stays correct on its own terms if
        # that check ordering ever changes.
        return ""
    if not stripped.startswith(_ML_OPEN) or not stripped.endswith(_ML_CLOSE):
        raise MessageMLError(
            "root element must be exactly <messageML>...</messageML> "
            "(no root attributes, no self-closing root)"
        )
    return stripped[len(_ML_OPEN) : -len(_ML_CLOSE)]


def _is_empty_content(message_ml: str) -> bool:
    """True if the document has no content once tags are stripped.
    CDATA content counts as content, not markup -- but _TAG_RE alone can't
    tell the difference: CDATA text is free to contain a bare "<", which
    makes the tag-regex run past the section's own "]]>" hunting for the
    next ">", swallowing the whole section (markers and text together) as
    though it were one big tag. Pull each CDATA section's text out first,
    with any "<"/">" of its own removed so it can never be misread as
    markup, before the ordinary tag-strip below ever sees it."""
    without_cdata = _CDATA_RE.sub(lambda m: m.group(1).replace("<", "").replace(">", ""), message_ml)
    return _TAG_RE.sub("", without_cdata).strip() == ""


def attribute(message_ml: str, sender: str | None) -> str:
    """Append the attribution line. Built from a trusted template and applied
    after sanitization -- request text never reaches it unescaped. `sender`
    is escaped as plain text, never rendered as markdown."""
    inner = _extract_body(message_ml)
    who = _escape_plain(sender) if sender else ""
    label = f"{who} {ATTRIBUTION_SUFFIX}".strip()
    return f"<messageML>{inner}<br/><i>📤 {label}</i></messageML>"


def build_client(cfg: Config) -> SymphonyClient:
    if cfg.fake:
        return FakeClient()
    from app.live_client import LiveClient  # imported lazily; needs the BDK

    return LiveClient(cfg)


class _LazyClient:
    """A SymphonyClient that resolves `get_client()` at call time, not at
    construction time. build_mcp() needs a concrete client up front, but
    resolving one eagerly at mount time would reintroduce the exact bug just
    fixed in the discovery endpoints: main() injects no client, so the
    resolved-client box in create_app() starts out empty, and forcing a
    build at app-creation time breaks a cold start in live mode -- before
    app/live_client.py even exists (Task 7), calling get_client() here would
    crash server startup outright instead of only failing the first send."""

    def __init__(self, get_client: Callable[[], SymphonyClient]) -> None:
        self._get_client = get_client

    def resolve(self) -> SymphonyClient:
        """Force client construction now, separately from any send. Exists so
        a caller (app/mcp_server.py's post_to_symphony) can resolve the real
        client *before* its own send try/except, keeping a build_client()
        failure from being caught by that broad except and misfiled as a
        rejected send -- mirroring POST /messages, which calls get_client()
        outside its own send try for the same reason."""
        return self._get_client()

    async def health(self) -> HealthStatus:
        return await self.resolve().health()

    async def send_message(self, request: SendRequest) -> SendResult:
        return await self.resolve().send_message(request)

    async def list_conversations(self) -> list[Conversation]:
        return await self.resolve().list_conversations()

    async def search_rooms(self, query: str) -> list[Room]:
        return await self.resolve().search_rooms(query)


class _HostOriginGate:
    """Pure-ASGI middleware that applies the identical Host/Origin allowlist
    the mounted MCP route already enforces (via TransportSecurityMiddleware)
    to every other route on this app -- /health, /messages, /conversations,
    /search/rooms.

    Why this exists at all: the control isn't defending against a tailnet
    attacker (who could set any Host header directly) -- CORS already blocks
    a plain cross-origin browser request with no help from this. It defends
    against a *confused deputy*: a DNS-rebinding page the user's own browser
    has open. A short-TTL attacker-controlled name resolves first to itself
    (passing same-origin checks at page-load time) and then, after the TTL
    expires, to this bridge's address -- at which point the browser's own
    `fetch` calls it "same-origin" (no preflight, whatever Origin the page's
    real origin was) with a `Host` header of the attacker's name, which
    never matches this allowlist. Without Host/Origin validation on *every*
    route (not just /mcp), the same rebinding trick reaches /messages and
    posts as the bot outside BDOBB's confirmation gate.

    A raw ASGI middleware, not Starlette's BaseHTTPMiddleware, so it never
    buffers or otherwise interferes with a streaming response body (the /mcp
    route's SSE stream) if this ever runs upstream of one. `is_post=False` is
    passed unconditionally to `validate_request`: that argument only gates
    the library's Content-Type check, a requirement of the MCP transport's
    own body parsing, not of DNS-rebinding protection -- every route here
    already validates its own body shape independently (FastAPI's Pydantic
    model for POST /messages, nothing for the GETs), so re-imposing it here
    would be a new, untested behavior change with no relationship to the
    vulnerability this middleware exists to close.
    """

    def __init__(self, app: ASGIApp, security: TransportSecurityMiddleware) -> None:
        self._app = app
        self._security = security

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        response = await self._security.validate_request(request, is_post=False)
        if response is not None:
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)


# Always allowed, regardless of operator config -- matches the MCP library's
# own auto-enabled default for a loopback bind.
_LOOPBACK_ALLOWED_HOSTS = frozenset({"127.0.0.1:*", "localhost:*", "[::1]:*"})
# Bind hosts that are either already covered by the loopback set above, or
# that name every interface rather than one this bridge is actually reachable
# at -- "0.0.0.0" tells the OS to listen everywhere, but a client's Host
# header is never literally "0.0.0.0", so adding it to the allowlist would
# permit nothing real while looking like it permits something.
_NOT_A_USABLE_HOST_HEADER = frozenset({"127.0.0.1", "localhost", "::1", "0.0.0.0", ""})


def _default_allowed_hosts(bind: str) -> frozenset[str]:
    """The allowlist used when BRIDGE_ALLOWED_HOSTS is not set: loopback plus
    whatever BRIDGE_BIND resolves to, so a tailnet deployment bound to its
    tailnet hostname or IP keeps working with zero extra config. A bind host
    of "0.0.0.0" gives no usable Host value to add -- the operator must set
    BRIDGE_ALLOWED_HOSTS explicitly (their tailnet hostname) in that case."""
    host, _ = _parse_bind(bind)
    hosts = set(_LOOPBACK_ALLOWED_HOSTS)
    if host not in _NOT_A_USABLE_HOST_HEADER:
        hosts.add(f"{host}:*")
    return frozenset(hosts)


def _security_settings(cfg: Config) -> TransportSecuritySettings:
    """One TransportSecuritySettings, shared by the MCP route's own transport
    security and by _HostOriginGate above -- one mechanism, one allowlist,
    applied app-wide, rather than two independent implementations of Host
    validation that could drift apart."""
    hosts = cfg.allowed_hosts if cfg.allowed_hosts is not None else _default_allowed_hosts(cfg.bind)
    origins = frozenset(f"{scheme}://{host}" for host in hosts for scheme in ("http", "https"))
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=sorted(hosts),
        allowed_origins=sorted(origins),
    )


def create_app(
    env: Mapping[str, str] | None = None,
    client: SymphonyClient | None = None,
    config: Config | None = None,
) -> FastAPI:
    # `config`, when given, is used as-is instead of re-reading `env`/os.environ --
    # lets a caller that already loaded a Config (main(), below) hand it through
    # instead of paying for a second, independent load_config() call.
    cfg: Config = config if config is not None else load_config(env)

    # A one-element mutable box rather than `app.state.client`: the FastAPI
    # `app` object doesn't exist yet at this point (its `lifespan=` -- see
    # below -- must be built first, from the MCP sub-app, which itself needs
    # `get_client` up front via `_LazyClient`). Resolved lazily on first send,
    # not at app-creation time: /health must keep working in live mode even
    # before a real client can be built (no pod session yet), and building
    # one is only ever needed to send.
    resolved_client: list[SymphonyClient | None] = [client]

    def get_client() -> SymphonyClient:
        if resolved_client[0] is None:
            resolved_client[0] = build_client(cfg)
        return resolved_client[0]

    security_settings = _security_settings(cfg)

    mcp = build_mcp(_LazyClient(get_client), cfg)
    # mcp==2.0.0 renamed FastMCP to MCPServer and reshaped this API (verified
    # against the installed version's own source; see task-6-report.md for
    # the API surface used). `streamable_http_app()` returns a throwaway
    # Starlette app whose only purpose here is to hand us its one route
    # (registered at the default streamable_http_path, "/mcp") and its
    # lifespan context; that route is appended directly onto this app's own
    # router below, rather than mounted, so the final route table has no
    # catch-all "/" entry that a route registered after this call could be
    # silently swallowed by.
    #
    # `streamable_http_path="/"` mounted at an outer "/mcp" prefix -- the
    # obvious-looking alternative -- does NOT produce the same URL without a
    # redirect: Starlette's Mount strips the "/mcp" prefix before dispatch, so
    # a request to exactly "/mcp" (no trailing slash) is forwarded to the
    # sub-app with an empty remaining path, which its own router does not
    # match against a route registered at "/" -- it 307-redirects to "/mcp/"
    # instead (confirmed by direct test). That silently reintroduces the
    # trailing-slash gotcha this service's README explicitly warns about.
    # Lifting the route out and appending it directly avoids both problems:
    # no catch-all, and no redirect on the bare "/mcp" path (confirmed by
    # direct test: GET /mcp -> 400 "Missing session ID", same as before).
    mcp_app = mcp.streamable_http_app(transport_security=security_settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Composes the sub-app's lifespan into this app's own, rather than
        # replacing it outright (`app.router.lifespan_context =
        # mcp_app.router.lifespan_context`, the previous approach): the
        # session manager's task group is created inside `run()`, entered via
        # this context, and skipping it makes every /mcp request raise "Task
        # group is not initialized. Make sure to use run()." at request time
        # -- but silently replacing FastAPI's default lifespan also means any
        # future `@app.on_event("startup")`/`lifespan`-based hook on *this*
        # app would never run, with no warning (confirmed by direct test).
        async with mcp_app.router.lifespan_context(mcp_app):
            yield

    app = FastAPI(title="symphony-bridge", version="1.0.0", lifespan=lifespan)
    app.state.config = cfg
    # One mechanism, applied app-wide: the same TransportSecuritySettings
    # that gate the /mcp route below also gate every other route, via this
    # middleware. See _HostOriginGate's own docstring for why a Host/Origin
    # allowlist is the right control here (DNS rebinding, not tailnet
    # reachability) and why it must not be limited to /mcp alone.
    app.add_middleware(_HostOriginGate, security=TransportSecurityMiddleware(security_settings))

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"status": "ok", "fake": cfg.fake}

    @app.post("/messages")
    async def send_message(body: SendMessageBody, request: Request) -> JSONResponse:
        source = request.client.host if request.client else "unknown"

        if cfg.allowed_destinations is not None and body.stream_id not in cfg.allowed_destinations:
            # A denied destination is a security event, not a no-op: log it
            # (hash only, same as every other outcome) before rejecting.
            raw_content = body.message_ml or body.markdown or body.text or ""
            log_send(
                source=source,
                stream_id=body.stream_id,
                body=raw_content,
                result="refused: destination not allowed",
            )
            raise HTTPException(
                status_code=403,
                detail=f"destination {body.stream_id} is not in BRIDGE_ALLOWED_DESTINATIONS",
            )

        if body.message_ml is not None:
            raw = body.message_ml
        elif body.markdown is not None:
            raw = markdown_to_messageml(body.markdown)
        else:
            raw = markdown_to_messageml(body.text or "")

        try:
            safe = sanitize(raw)
        except MessageMLError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if _is_empty_content(safe):
            raise HTTPException(status_code=422, detail="message content must not be empty")

        try:
            final = attribute(safe, body.sender)
        except MessageMLError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        # Re-validate the document actually being sent, in its final,
        # spliced-together form -- and send *that* re-serialization, not the
        # hand-assembled string. `safe` was validated before attribution was
        # appended; nothing may go out that hasn't been validated as it will
        # actually be transmitted. Using the return value here (rather than
        # discarding it and keeping the hand-assembled `final`) is what makes
        # that literally true instead of just checked: sanitize() is "the
        # final authority" specifically because its output, not its input,
        # is what reaches Symphony. A failure here means our own assembly
        # produced something malformed -- a server bug, not a client error.
        try:
            final = sanitize(final)
        except MessageMLError as exc:
            raise HTTPException(
                status_code=500, detail=f"internal error assembling message: {exc}"
            ) from exc

        attachment = (
            Attachment(
                filename=body.attachment.filename,
                content_type=body.attachment.content_type,
                data=body.attachment.data,
            )
            if body.attachment
            else None
        )

        try:
            client = get_client()
        except Exception as exc:
            # Construction failure means the service can't serve at all --
            # it is not a rejected send, and must not be audited as one.
            raise HTTPException(
                status_code=503, detail=f"Symphony client unavailable: {exc}"
            ) from exc

        try:
            result = await client.send_message(
                SendRequest(stream_id=body.stream_id, message_ml=final, attachment=attachment)
            )
        except Exception as exc:  # surface Symphony's error, never a silent success
            # str(exc) is unbounded and adversarial -- Symphony and
            # HTTP-client errors routinely echo all or part of the request
            # payload, in shapes no substring redaction reliably catches
            # (partial echoes, <br/> reflowed to newlines, JSON-wrapped,
            # base64-encoded...). Redacting arbitrary upstream text is
            # unwinnable, so this is structural instead: the audit record is
            # built only from values this service itself constructs -- the
            # exception's type name, and, if one can be pulled out with the
            # strict, narrow _HTTP_STATUS_RE, an HTTP status code. str(exc)
            # itself never reaches the audit logger. The full text still
            # reaches the caller below (who already has the body), and
            # nowhere else.
            status_match = _HTTP_STATUS_RE.search(str(exc))
            reason = type(exc).__name__
            if status_match:
                reason = f"{reason} status={status_match.group()}"
            log_send(
                source=source,
                stream_id=body.stream_id,
                body=final,
                result=f"error: {reason}",
            )
            raise HTTPException(status_code=502, detail=f"Symphony send failed: {exc}") from exc

        log_send(source=source, stream_id=body.stream_id, body=final, result="ok")
        return JSONResponse({"messageId": result.message_id})

    @app.get("/conversations")
    async def conversations() -> dict[str, object]:
        items = await get_client().list_conversations()
        return {"conversations": [{"streamId": c.stream_id, "name": c.name} for c in items]}

    @app.get("/search/rooms")
    async def search_rooms(q: str) -> dict[str, object]:
        rooms = await get_client().search_rooms(q)
        return {
            "rooms": [
                {"streamId": r.stream_id, "name": r.name, "description": r.description}
                for r in rooms
            ]
        }

    # Append the MCP sub-app's own route(s) directly onto this app's router
    # (see the long comment above, by `mcp_app`'s construction, for why this
    # replaces the earlier `app.mount("/", mcp_app)`). `mcp_app.routes` holds
    # exactly one entry in this app's configuration (no auth, no custom
    # routes passed to build_mcp) but this stays correct if that ever
    # changes, rather than unpacking and asserting exactly one.
    app.router.routes.extend(mcp_app.routes)

    return app


_DEFAULT_BIND_HOST = "127.0.0.1"
_DEFAULT_BIND_PORT = 8099


def _parse_bind(bind: str) -> tuple[str, int]:
    """Parse BRIDGE_BIND as "host:port", a bare port ("8099"), or a bare host
    ("0.0.0.0") -- each falling back to the default for the piece it omits.
    `"8099".partition(":")` used to be trusted directly: for a colonless value
    that yields host="8099" (the whole string) and an empty port, so a bare
    port silently became the wrong *host* and uvicorn failed at bind time with
    a confusing socket error instead of a clear config one. Anything that
    still doesn't resolve to a usable host/port pair raises here, naming
    BRIDGE_BIND, instead of reaching uvicorn at all."""
    value = bind.strip()
    if not value:
        raise ValueError(
            f'BRIDGE_BIND is empty; expected e.g. "{_DEFAULT_BIND_HOST}:{_DEFAULT_BIND_PORT}"'
        )

    if ":" in value:
        host, _, port_str = value.rpartition(":")
        host = host or _DEFAULT_BIND_HOST
    elif value.isdigit():
        host, port_str = _DEFAULT_BIND_HOST, value
    else:
        host, port_str = value, str(_DEFAULT_BIND_PORT)

    if not port_str.isdigit():
        raise ValueError(f"BRIDGE_BIND={bind!r} has a non-numeric port")
    port = int(port_str)
    if not (0 < port < 65536):
        raise ValueError(f"BRIDGE_BIND={bind!r} has an out-of-range port {port}")
    return host, port


def main() -> None:
    cfg = load_config()
    host, port = _parse_bind(cfg.bind)
    uvicorn.run(create_app(config=cfg), host=host, port=port)


if __name__ == "__main__":
    main()
