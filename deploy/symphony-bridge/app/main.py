"""FastAPI application."""

import re
from collections.abc import Mapping

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.audit import log_send
from app.client import Attachment, SendRequest, SymphonyClient
from app.config import Config, load_config
from app.fake_client import FakeClient
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


def create_app(
    env: Mapping[str, str] | None = None,
    client: SymphonyClient | None = None,
    config: Config | None = None,
) -> FastAPI:
    # `config`, when given, is used as-is instead of re-reading `env`/os.environ --
    # lets a caller that already loaded a Config (main(), below) hand it through
    # instead of paying for a second, independent load_config() call.
    cfg: Config = config if config is not None else load_config(env)
    app = FastAPI(title="symphony-bridge", version="1.0.0")
    app.state.config = cfg
    # Resolved lazily on first send, not at app-creation time: /health must
    # keep working in live mode even before a real client can be built (no
    # pod session yet), and building one is only ever needed to send.
    app.state.client = client

    def get_client() -> SymphonyClient:
        if app.state.client is None:
            app.state.client = build_client(cfg)
        return app.state.client

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
