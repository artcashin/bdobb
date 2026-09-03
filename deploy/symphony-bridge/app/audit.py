"""Send logging. Records who asked, where it went, and what happened -- and a
hash of the content rather than the content itself."""

import hashlib
import logging

logger = logging.getLogger("symphony_bridge.audit")


def content_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def log_send(*, source: str, stream_id: str, body: str, result: str) -> None:
    logger.info(
        "send source=%s stream=%s sha256=%s result=%s",
        source,
        stream_id,
        content_hash(body),
        result,
    )
