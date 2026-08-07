"""markdown -> MessageML, and the sanitizer every outbound payload passes.

Order matters: escape first, then format. Link hrefs are protected with
private-use-area placeholders so the emphasis passes cannot run inside an
attribute value and produce malformed XML.
"""

import re
from xml.etree import ElementTree

ALLOWED_TAGS = frozenset({"messageML", "b", "i", "code", "br", "a", "p"})

# Private-use-area sentinels. Written as explicit escapes, never as literal
# characters: they are invisible in an editor, and if one were ever lost the
# restore regex below would rewrite every digit run in the message.
_HREF_OPEN = ""
_HREF_CLOSE = ""

_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_HTTP_SCHEME = re.compile(r"^https?:", re.IGNORECASE)
_BOLD = re.compile(r"(?<![A-Za-z0-9])\*\*(?!\s)([^*]+?)(?<!\s)\*\*")
_BOLD_U = re.compile(r"(?<![A-Za-z0-9])__(?!\s)([^_]+?)(?<!\s)__")
_ITAL = re.compile(r"(?<![A-Za-z0-9])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)")
_ITAL_U = re.compile(r"(?<![A-Za-z0-9])_(?!\s)([^_]+?)(?<!\s)_(?!_)")
_CODE = re.compile(r"`([^`]+)`")


class MessageMLError(Exception):
    """Raised when a payload is not valid, safe MessageML."""


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def markdown_to_messageml(md: str) -> str:
    body = _escape(md)

    hrefs: list[str] = []

    def _link(match: re.Match[str]) -> str:
        label, url = match.group(1), match.group(2)
        if not _HTTP_SCHEME.match(url):
            # Not a web link -- render the label as plain text, drop the target.
            return label
        hrefs.append(url)
        return f'<a href="{_HREF_OPEN}{len(hrefs) - 1}{_HREF_CLOSE}">{label}</a>'

    body = _LINK.sub(_link, body)
    body = _BOLD.sub(r"<b>\1</b>", body)
    body = _BOLD_U.sub(r"<b>\1</b>", body)
    body = _ITAL.sub(r"<i>\1</i>", body)
    body = _ITAL_U.sub(r"<i>\1</i>", body)
    body = _CODE.sub(r"<code>\1</code>", body)
    body = body.replace("\n", "<br/>")

    def _restore(match: re.Match[str]) -> str:
        return hrefs[int(match.group(1))]

    body = re.sub(f"{_HREF_OPEN}(\\d+){_HREF_CLOSE}", _restore, body)
    return f"<messageML>{body}</messageML>"


def sanitize(message_ml: str) -> str:
    """Return the payload unchanged if it is well-formed MessageML using only
    allowed tags. Raise MessageMLError otherwise."""
    try:
        root = ElementTree.fromstring(message_ml)
    except ElementTree.ParseError as exc:
        raise MessageMLError(f"not well-formed XML: {exc}") from exc

    if root.tag != "messageML":
        raise MessageMLError(f"root element must be <messageML>, got <{root.tag}>")

    for element in root.iter():
        if element.tag not in ALLOWED_TAGS:
            raise MessageMLError(f"disallowed tag <{element.tag}>")

    return message_ml
