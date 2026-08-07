"""markdown -> MessageML, and the sanitizer every outbound payload passes.

Order matters, and so does isolation. A naive sequence of regex passes over
one mutable string is unsafe: as soon as pass N emits markup, pass N+1 is
running over text that includes pass N's output, and can match *inside* it.
That single defect produced three separate bugs (emphasis inside href
attributes, emphasis inside code spans, bold/italic pairing across each
other's boundaries) before this module was restructured to make the whole
class impossible instead of patching instances of it.

The fix: every pass that emits markup immediately replaces the emitted
region -- tags and content together -- with an opaque private-use-area
placeholder token before the next pass runs. No later pass ever sees text
a previous pass produced; it only ever sees literal source text or opaque
tokens it cannot match into. All placeholders are resolved in a single
final step, in dependency order (see markdown_to_messageml for the proof
that this order can never leave a placeholder unresolved).

Passes run in dependency order, and every one of them placeholds its
*entire* emitted span -- tags and content together, not just an attribute
inside it -- before the next pass runs:
  1. code spans (contents are literal, by definition -- so this also fixes
     "link inside a code span", since the link syntax is never seen by the
     link pass at all)
  2. links (the whole anchor, href and label, is one opaque unit -- so an
     emphasis marker before a link can't pair with one inside its label
     either; link labels do not get emphasis formatting as a result)
  3. bold (**), bold (__), italic (*), italic (_) -- each one's entire
     emitted <b>/<i> span is placeheld before the next emphasis pass runs,
     so two emphasis passes can never pair a marker across each other's
     tag boundary.
"""

import re
from xml.etree import ElementTree

ALLOWED_TAGS = frozenset({"messageML", "b", "i", "code", "br", "a", "p"})

# Private-use-area sentinels marking a placeholder token: OPEN, a decimal
# index into the `spans` list built in markdown_to_messageml, then CLOSE.
# Written as explicit escapes, never as literal characters: they are
# invisible in an editor, and if one were ever lost the restore regex
# below would simply fail to fire instead of corrupting text. User input
# can never forge one of these -- _escape strips the whole sentinel range
# before any placeholder is inserted.
_SPAN_OPEN = "\uE000"
_SPAN_CLOSE = "\uE001"
# No longer generated (a single OPEN/CLOSE pair covers every protected
# span now), but still stripped from user input below as defense in
# depth: nothing legitimate should ever produce one of these either.
_RESERVED_A = "\uE002"
_RESERVED_B = "\uE003"
_SENTINEL_CHARS = re.compile(
    "[" + "".join(re.escape(c) for c in (_SPAN_OPEN, _SPAN_CLOSE, _RESERVED_A, _RESERVED_B)) + "]"
)
_PLACEHOLDER = re.compile(f"{_SPAN_OPEN}(\\d+){_SPAN_CLOSE}")

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

    # `spans[i]` holds a fully-formed markup string (e.g. "<code>x</code>"
    # or "<b>y</b>") that has been removed from `body` and replaced with
    # the placeholder token f"{_SPAN_OPEN}{i}{_SPAN_CLOSE}".
    #
    # Invariant: spans[i] can only ever contain a placeholder referencing
    # some j < i -- never i itself, never anything >= i. Proof: a span is
    # only ever built from text already present in `body` (or in a
    # match's capture group) *at the time its pass runs*, and any
    # placeholder token appearing in that text must have been produced by
    # an earlier _protect() call, which by construction already has a
    # strictly smaller index. Passes never revisit text they already
    # placeheld, so nothing a pass emits can reference itself or a span
    # created later.
    #
    # That invariant is exactly what makes the final restore below
    # correct: resolving spans in ascending index order, each one using
    # only already-fully-resolved earlier entries, guarantees by
    # induction that resolved[i] is complete (contains no placeholder)
    # before it is ever read -- so a single ascending pass resolves
    # everything and no placeholder can be left dangling.
    spans: list[str] = []

    def _protect(markup: str) -> str:
        spans.append(markup)
        return f"{_SPAN_OPEN}{len(spans) - 1}{_SPAN_CLOSE}"

    # 1. Code spans first. Their contents are literal -- nothing inside
    #    backticks (a link, an emphasis marker) is ever interpreted. This
    #    is also what stops a link inside backticks from leaking a raw
    #    href placeholder: the link syntax is consumed as inert text here
    #    before the link pass ever runs.
    def _code(match: re.Match[str]) -> str:
        return _protect(f"<code>{match.group(1)}</code>")

    body = _CODE.sub(_code, body)

    # 2. Links. The whole anchor -- href *and* label -- is placeheld as one
    #    opaque unit. (An earlier version of this fix shielded only the
    #    href and left the label exposed for nested emphasis; a 130k-input
    #    fuzz run found that an emphasis marker before the link could still
    #    pair with a marker inside the label, e.g. "_buy[cash_balance](u)",
    #    crossing the `<a href="...">` tag boundary the same way the
    #    bold/italic bug did. Link labels do not get emphasis formatting
    #    as a result -- untested, and not worth reopening this bug class
    #    for.)
    def _link(match: re.Match[str]) -> str:
        label, url = match.group(1), match.group(2)
        if not _HTTP_SCHEME.match(url):
            # Not a web link -- render the label as plain text, drop the target.
            return label
        return _protect(f'<a href="{url}">{label}</a>')

    body = _LINK.sub(_link, body)

    # 3. Emphasis. Each pass's entire emitted span -- both tags and the
    #    text between them -- is placeheld immediately, before the next
    #    emphasis pass runs. A later pass therefore never sees an earlier
    #    pass's <b> or <i> output at all, so it cannot pair one of its
    #    markers with a leftover marker character sitting inside that
    #    output: bold and italic can no longer cross.
    body = _BOLD.sub(lambda m: _protect(f"<b>{m.group(1)}</b>"), body)
    body = _BOLD_U.sub(lambda m: _protect(f"<b>{m.group(1)}</b>"), body)
    body = _ITAL.sub(lambda m: _protect(f"<i>{m.group(1)}</i>"), body)
    body = _ITAL_U.sub(lambda m: _protect(f"<i>{m.group(1)}</i>"), body)

    body = body.replace("\n", "<br/>")

    def _resolve(text: str, resolved: list[str]) -> str:
        def _sub(match: re.Match[str]) -> str:
            idx = int(match.group(1))
            if 0 <= idx < len(resolved):
                return resolved[idx]
            # Unreachable given the invariant above; falls back to the
            # literal matched text instead of crashing if it ever were.
            return match.group(0)

        return _PLACEHOLDER.sub(_sub, text)

    resolved: list[str] = []
    for span in spans:
        resolved.append(_resolve(span, resolved))
    body = _resolve(body, resolved)

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
