"""HTTP request models. The send endpoint accepts two payload shapes because
two independent BDOBB paths produce different ones."""

import base64
import binascii
import re

from pydantic import BaseModel, Field, field_validator, model_validator

# Control characters (including CR/LF) anywhere in a value that later becomes
# one field of a single space-delimited audit log line.
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")

# MIME-style base64 is legitimately line-wrapped (RFC 2045 caps lines at 76
# chars); base64.b64decode(..., validate=True) rejects the embedded newlines
# outright. Strip whitespace before validating -- base64's own alphabet never
# includes it -- so wrapped input is accepted and unwrapped consistently.
_WHITESPACE_RE = re.compile(r"\s+")


class AttachmentBody(BaseModel):
    filename: str
    content_type: str = Field(alias="contentType")
    data: str

    @field_validator("data")
    @classmethod
    def data_must_be_base64(cls, v: str) -> str:
        stripped = _WHITESPACE_RE.sub("", v)
        if not stripped:
            raise ValueError("attachment.data must not be empty")
        try:
            base64.b64decode(stripped, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"attachment.data must be valid base64: {exc}") from exc
        return stripped


class SendMessageBody(BaseModel):
    stream_id: str = Field(alias="streamId")
    markdown: str | None = None
    message_ml: str | None = Field(default=None, alias="messageML")
    text: str | None = None
    title: str | None = None
    sender: str | None = None
    attachment: AttachmentBody | None = None

    @field_validator("stream_id")
    @classmethod
    def stream_id_not_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("streamId must not be empty or whitespace-only")
        if _CONTROL_CHAR_RE.search(stripped):
            raise ValueError("streamId must not contain control characters")
        # Store the same value that was validated: it is what gets logged
        # (app/audit.py) and sent, and a stored/validated mismatch is exactly
        # how a crafted streamId could forge audit log lines.
        return stripped

    @model_validator(mode="after")
    def exactly_one_content_field(self) -> "SendMessageBody":
        provided = [f for f in (self.markdown, self.message_ml, self.text) if f is not None]
        if len(provided) != 1:
            raise ValueError("exactly one of markdown, messageML or text is required")
        return self
