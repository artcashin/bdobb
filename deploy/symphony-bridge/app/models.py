"""HTTP request models. The send endpoint accepts two payload shapes because
two independent BDOBB paths produce different ones."""

import base64
import binascii

from pydantic import BaseModel, Field, field_validator, model_validator


class AttachmentBody(BaseModel):
    filename: str
    content_type: str = Field(alias="contentType")
    data: str

    @field_validator("data")
    @classmethod
    def data_must_be_base64(cls, v: str) -> str:
        try:
            base64.b64decode(v, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"attachment.data must be valid base64: {exc}") from exc
        return v


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
        if not v.strip():
            raise ValueError("streamId must not be empty or whitespace-only")
        return v

    @model_validator(mode="after")
    def exactly_one_content_field(self) -> "SendMessageBody":
        provided = [f for f in (self.markdown, self.message_ml, self.text) if f is not None]
        if len(provided) != 1:
            raise ValueError("exactly one of markdown, messageML or text is required")
        return self
