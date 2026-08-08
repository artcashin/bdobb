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

# Length cap on the exception text kept in the audit log's `result` field.
_MAX_AUDIT_REASON_LEN = 200

_TAG_RE = re.compile(r"<[^>]+>")

_ML_OPEN = "<messageML>"
_ML_CLOSE = "</messageML>"


def _escape_plain(text: str) -> str:
    """Escape text for a MessageML text node without interpreting markdown.
    Same character set markdown_to_messageml escapes -- but no rendering."""
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def _extract_body(message_ml: str) -> str:
    """Pull the inner content out of a document that has already passed
    sanitize(). sanitize() deliberately returns the caller's original string
    verbatim -- so it accepts surrounding whitespace, root attributes, and
    self-closing roots that a naive removeprefix/removesuffix splice would
    mishandle. Require the exact literal form here (whitespace-trimmed) so
    splicing is safe; reject anything else instead of silently producing
    unbalanced XML."""
    stripped = message_ml.strip()
    if not stripped.startswith(_ML_OPEN) or not stripped.endswith(_ML_CLOSE):
        raise MessageMLError(
            "root element must be exactly <messageML>...</messageML> "
            "(no root attributes, no self-closing root)"
        )
    return stripped[len(_ML_OPEN) : -len(_ML_CLOSE)]


def _is_empty_content(message_ml: str) -> bool:
    """True if the document has no content once tags are stripped."""
    return _TAG_RE.sub("", message_ml).strip() == ""


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
) -> FastAPI:
    cfg: Config = load_config(env)
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
        # spliced-together form. `safe` was validated before attribution was
        # appended; nothing may go out that hasn't been validated as it will
        # actually be transmitted. A failure here means our own assembly
        # produced something malformed -- a server bug, not a client error.
        try:
            sanitize(final)
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
            # The exception text is unbounded and uncontrolled -- Symphony
            # and HTTP-client errors routinely echo the request payload.
            # Scrub any occurrence of the body before it goes anywhere near
            # the log; the full text is only ever returned to the caller,
            # who already has the body.
            reason = str(exc).replace(final, "[redacted]") if final else str(exc)
            reason = reason[:_MAX_AUDIT_REASON_LEN]
            log_send(
                source=source,
                stream_id=body.stream_id,
                body=final,
                result=f"error: {type(exc).__name__}: {reason}",
            )
            raise HTTPException(status_code=502, detail=f"Symphony send failed: {exc}") from exc

        log_send(source=source, stream_id=body.stream_id, body=final, result="ok")
        return JSONResponse({"messageId": result.message_id})

    return app


def main() -> None:
    cfg = load_config()
    host, _, port = cfg.bind.partition(":")
    uvicorn.run(create_app(), host=host or "127.0.0.1", port=int(port or "8099"))


if __name__ == "__main__":
    main()
