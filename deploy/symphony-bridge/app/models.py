"""HTTP request models. The send endpoint accepts two payload shapes because
two independent BDOBB paths produce different ones."""

from pydantic import BaseModel, Field, model_validator


class AttachmentBody(BaseModel):
    filename: str
    content_type: str = Field(alias="contentType")
    data: str


class SendMessageBody(BaseModel):
    stream_id: str = Field(alias="streamId")
    markdown: str | None = None
    message_ml: str | None = Field(default=None, alias="messageML")
    text: str | None = None
    title: str | None = None
    sender: str | None = None
    attachment: AttachmentBody | None = None

    @model_validator(mode="after")
    def exactly_one_content_field(self) -> "SendMessageBody":
        provided = [f for f in (self.markdown, self.message_ml, self.text) if f is not None]
        if len(provided) != 1:
            raise ValueError("exactly one of markdown, messageML or text is required")
        return self
