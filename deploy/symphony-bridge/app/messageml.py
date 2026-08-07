"""markdown -> MessageML, and the sanitizer every outbound payload passes.

Order matters: escape first, then format. Link hrefs and code-span bodies
are protected with private-use-area placeholders so later formatting passes
(emphasis) cannot run inside them and produce malformed XML.
"""

import re
from xml.etree import ElementTree

ALLOWED_TAGS = frozenset({"messageML", "b", "i", "code", "br", "a", "p"})

# Private-use-area sentinels. Written as explicit escapes, never as literal
# characters: they are invisible in an editor, and if one were ever lost the
# restore regexes below would rewrite arbitrary text in the message. User
# input can never forge one of these: _escape strips the whole sentinel
# range before any placeholder is inserted.
_HREF_OPEN = "\uE000"
_HREF_CLOSE = "\uE001"
_CODE_OPEN = "\uE002"
_CODE_CLOSE = "\uE003"
_SENTINEL_CHARS = re.compile(
    "[" + "".join(re.escape(c) for c in (_HREF_OPEN, _HREF_CLOSE, _CODE_OPEN, _CODE_CLOSE)) + "]"
)

_LINK = re.compile(r"\[([^\]]+)\]\(((?:[^()\s]|\((?:[^()\s])*\))+)\)")
_HTTP_SCHEME = re.compile(r"^https?:", re.IGNORECASE)
_BOLD = re.compile(r"(?<![A-Za-z0-9])\*\*(?!\s)([^*]+?)(?<!\s)\*\*")
_BOLD_U = re.compile(r"(?<![A-Za-z0-9])__(?!\s)([^_]+?)(?<!\s)__")
_ITAL = re.compile(r"(?<![A-Za-z0-9])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)")
_ITAL_U = re.compile(r"(?<![A-Za-z0-9])_(?!\s)([^_]+?)(?<!\s)_(?!_)")
_CODE = re.compile(r"`([^`]+)`")


class MessageMLError(Exception):
    """Raised when a payload is not valid, safe MessageML."""


def _escape(text: str) -> str:
    text = (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )
    # Strip any of our own placeholder sentinels out of user input so that
    # attacker-chosen text can never masquerade as a placeholder we insert
    # later (which would desync the restore-by-index lookups below).
    return _SENTINEL_CHARS.sub("", text)


def markdown_to_messageml(md: str) -> str:
    body = _escape(md)

    hrefs: list[str] = []
    codes: list[str] = []

    def _link(match: re.Match[str]) -> str:
        label, url = match.group(1), match.group(2)
        if not _HTTP_SCHEME.match(url):
            # Not a web link -- render the label as plain text, drop the target.
            return label
        hrefs.append(url)
        return f'<a href="{_HREF_OPEN}{len(hrefs) - 1}{_HREF_CLOSE}">{label}</a>'

    def _code(match: re.Match[str]) -> str:
        # Protect the code-span body with a placeholder *before* the emphasis
        # passes run, so a `*`/`_` inside backticks can never pair with one
        # outside them.
        codes.append(match.group(1))
        return f"<code>{_CODE_OPEN}{len(codes) - 1}{_CODE_CLOSE}</code>"

    body = _LINK.sub(_link, body)
    body = _CODE.sub(_code, body)
    body = _BOLD.sub(r"<b>\1</b>", body)
    body = _BOLD_U.sub(r"<b>\1</b>", body)
    body = _ITAL.sub(r"<i>\1</i>", body)
    body = _ITAL_U.sub(r"<i>\1</i>", body)
    body = body.replace("\n", "<br/>")

    def _restore_href(match: re.Match[str]) -> str:
        try:
            return hrefs[int(match.group(1))]
        except IndexError:
            # Belt-and-braces: a sentinel that doesn't map to a captured
            # href (e.g. one that survived from somewhere unexpected)
            # falls back to the literal matched text instead of crashing.
            return match.group(0)

    def _restore_code(match: re.Match[str]) -> str:
        try:
            return codes[int(match.group(1))]
        except IndexError:
            return match.group(0)

    body = re.sub(f"{_HREF_OPEN}(\\d+){_HREF_CLOSE}", _restore_href, body)
    body = re.sub(f"{_CODE_OPEN}(\\d+){_CODE_CLOSE}", _restore_code, body)
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
