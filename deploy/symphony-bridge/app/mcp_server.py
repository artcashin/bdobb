"""The MCP surface. One tool, deliberately -- Rita's tool budget is finite and
this is a send path, not a general Symphony proxy."""

from mcp.server.mcpserver import MCPServer

from app.audit import log_send
from app.client import SendRequest, SymphonyClient
from app.config import Config
from app.messageml import MessageMLError, markdown_to_messageml, sanitize


def build_mcp(client: SymphonyClient, cfg: Config) -> MCPServer:
    mcp = MCPServer("symphony-bridge")

    @mcp.tool()
    async def post_to_symphony(stream_id: str, message: str) -> str:
        """Post a message to a Symphony conversation. Markdown is converted to
        MessageML. Requires the user's approval in BDOBB before it runs."""
        # Deferred: app.main imports app.mcp_server (to mount it), so a
        # module-level import here would be circular.
        from app.main import _HTTP_STATUS_RE, _is_empty_content, attribute

        if cfg.allowed_destinations is not None and stream_id not in cfg.allowed_destinations:
            # Same posture as POST /messages: a denied destination is a
            # security event, not a no-op -- log it (hash only) before refusing.
            log_send(
                source="rita/mcp",
                stream_id=stream_id,
                body=message,
                result="refused: destination not allowed",
            )
            return f"Refused: {stream_id} is not in the configured destination allowlist."

        # Same pipeline as POST /messages: sanitize, check for empty content,
        # attribute, then re-sanitize the assembled document -- and send
        # *that* re-serialization (sanitize's return value), not the
        # hand-assembled string. Rita has no sender name to offer, so
        # attribution degrades to "via BDOBB" rather than the model
        # inventing one.
        try:
            safe = sanitize(markdown_to_messageml(message))
            if _is_empty_content(safe):
                raise MessageMLError("message content must not be empty")
            body = sanitize(attribute(safe, None))
        except MessageMLError as exc:
            return f"Refused: {exc}"

        try:
            result = await client.send_message(
                SendRequest(stream_id=stream_id, message_ml=body, attachment=None)
            )
        except Exception as exc:  # noqa: BLE001 -- deliberately broad, and never silent:
            # an MCP tool call has no HTTP status to raise, so surfacing
            # Symphony's error means returning text, not re-raising (a raised
            # exception here becomes an opaque ToolError, losing this
            # function's own audit-safe formatting). str(exc) is unbounded
            # and adversarial (see app.main.send_message); the audit record
            # is built only from values this service itself constructs,
            # never from str(exc). The full text still reaches the caller
            # below (Rita, who already has the message), and nowhere else.
            status_match = _HTTP_STATUS_RE.search(str(exc))
            reason = type(exc).__name__
            if status_match:
                reason = f"{reason} status={status_match.group()}"
            log_send(source="rita/mcp", stream_id=stream_id, body=body, result=f"error: {reason}")
            return f"Send failed: {exc}"

        log_send(source="rita/mcp", stream_id=stream_id, body=body, result="ok")
        return f"Sent to {stream_id} (message id {result.message_id})."

    return mcp
