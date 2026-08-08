"""FastAPI application."""

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


def attribute(message_ml: str, sender: str | None) -> str:
    """Append the attribution line. Built from a trusted template and applied
    after sanitization -- request text never reaches it unescaped."""
    who = markdown_to_messageml(sender).removeprefix("<messageML>").removesuffix("</messageML>") \
        if sender else ""
    label = f"{who} {ATTRIBUTION_SUFFIX}".strip()
    inner = message_ml.removeprefix("<messageML>").removesuffix("</messageML>")
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
        if cfg.allowed_destinations is not None and body.stream_id not in cfg.allowed_destinations:
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

        final = attribute(safe, body.sender)
        attachment = (
            Attachment(
                filename=body.attachment.filename,
                content_type=body.attachment.content_type,
                data=body.attachment.data,
            )
            if body.attachment
            else None
        )

        source = request.client.host if request.client else "unknown"
        try:
            result = await get_client().send_message(
                SendRequest(stream_id=body.stream_id, message_ml=final, attachment=attachment)
            )
        except Exception as exc:  # surface Symphony's error, never a silent success
            log_send(source=source, stream_id=body.stream_id, body=final, result=f"error: {exc}")
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
