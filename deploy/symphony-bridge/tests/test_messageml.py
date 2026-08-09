import random
import re

import pytest

from app.messageml import MessageMLError, markdown_to_messageml, sanitize


def test_escapes_html_before_formatting():
    out = markdown_to_messageml("<script>alert(1)</script>")
    assert "<script>" not in out
    assert "&lt;script&gt;" in out


def test_wraps_in_messageml_root():
    out = markdown_to_messageml("hello")
    assert out.startswith("<messageML>")
    assert out.endswith("</messageML>")


def test_bold_and_italic():
    out = markdown_to_messageml("**bold** and *ital*")
    assert "<b>bold</b>" in out
    assert "<i>ital</i>" in out


def test_intraword_underscores_are_not_emphasis():
    # snake_case identifiers are ordinary text in a market-data app.
    out = markdown_to_messageml("snake_case_id")
    assert "<i>" not in out
    assert "snake_case_id" in out


def test_links_become_anchors():
    out = markdown_to_messageml("[docs](https://example.com/a_b)")
    assert '<a href="https://example.com/a_b">docs</a>' in out


def test_link_url_is_not_mangled_by_emphasis():
    # The URL sits inside an attribute; emphasis substitution must not run in it.
    out = markdown_to_messageml("[d](https://x.com/a/_b_/c)")
    assert '<a href="https://x.com/a/_b_/c">d</a>' in out
    assert "<i>" not in out


def test_non_http_scheme_is_not_an_anchor():
    out = markdown_to_messageml("[click](javascript:alert(1))")
    assert "<a " not in out
    assert "javascript:alert" not in out


def test_newlines_become_breaks():
    assert "<br/>" in markdown_to_messageml("a\nb")


def test_sanitize_accepts_known_tags():
    assert sanitize("<messageML>hi <b>there</b></messageML>")


def test_sanitize_rejects_unknown_tags():
    with pytest.raises(MessageMLError):
        sanitize("<messageML><script>x</script></messageML>")


def test_sanitize_rejects_malformed_xml():
    with pytest.raises(MessageMLError):
        sanitize("<messageML><b>unclosed</messageML>")


def test_sanitize_requires_messageml_root():
    with pytest.raises(MessageMLError):
        sanitize("<div>hi</div>")


# --- Fix 1: sentinels are explicit escapes, not literal PUA bytes -------


def test_sentinel_constants_are_not_raw_bytes_in_source():
    """The sentinel literals in app/messageml.py must be written as explicit
    \\uXXXX escapes (six visible ASCII characters), never as the raw
    invisible Private Use Area bytes. Guards against Fix 1 regressing."""
    import app.messageml as messageml_module

    with open(messageml_module.__file__, "r", encoding="utf-8") as f:
        source = f.read()
    assert "\\uE000" in source
    assert "\\uE001" in source
    # The raw PUA characters themselves should not appear in the source text.
    assert "\uE000" not in source
    assert "\uE001" not in source


# --- Fix 2: emphasis must not cross code-span boundaries -----------------


def test_emphasis_marker_outside_code_does_not_pair_with_one_inside():
    out = markdown_to_messageml("set _limit and check `stop_loss` please")
    sanitize(out)  # must not raise
    assert "<code>stop_loss</code>" in out


def test_star_outside_code_does_not_pair_with_star_inside():
    out = markdown_to_messageml("note the *spread and the `px*qty` column")
    sanitize(out)  # must not raise
    assert "<code>px*qty</code>" in out


def test_code_spans_still_work():
    out = markdown_to_messageml("`code`")
    assert "<code>code</code>" in out
    sanitize(out)


# --- Fix 3: a raw sentinel in user input must not crash the converter ----


def test_raw_sentinel_in_input_does_not_raise():
    out = markdown_to_messageml("\uE000" "0" "\uE001")
    sanitize(out)  # must not raise


# --- Fix 4: parenthesized URLs keep a complete href -----------------------


def test_parenthesized_url_produces_complete_href():
    out = markdown_to_messageml(
        "[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))"
    )
    assert (
        '<a href="https://en.wikipedia.org/wiki/Mercury_(planet)">Mercury</a>'
        in out
    )
    assert ")</messageML>" not in out
    sanitize(out)


# --- Fix 4: link labels must not receive emphasis formatting -------------


def test_link_label_does_not_receive_emphasis():
    # Labels are placeheld as part of the whole anchor before the emphasis
    # passes run, so an emphasis marker straddling a link's brackets must
    # not pair with one inside the label -- see the comment in pass 2 of
    # markdown_to_messageml. If a future change re-exposes labels to the
    # emphasis passes, this must fail.
    out = markdown_to_messageml("_buy[cash_balance](https://e.com/x)")
    sanitize(out)  # must not raise
    assert "<i>" not in out
    assert '<a href="https://e.com/x">cash_balance</a>' in out


# --- Round-trip property: sanitize(markdown_to_messageml(s)) never raises -
#
# A curated string list (the previous version of this test) can't find a
# bug class this narrow: none of a handful of hand-picked finance strings
# combine a link with a code span, and the bold/italic-crossing repros are
# six-character inputs like "__*__*" that nobody would think to hand-write.
# This generates a large, fixed-seed corpus from the relevant alphabet
# instead, so it reliably finds -- and keeps finding -- inputs like that.
#
# The alphabet includes a backtick and explicit composed link templates
# whose label and/or URL each carry a code span, emphasis, or parentheses
# (e.g. "`[L](U)`", "[`L`](U)", "[L](`U`)", "_L[L](U)**"). Without those,
# the generator can build a code span or a link, but essentially never both
# in the same input -- and the region where the href-attribute bug (a code
# span placeholder landing inside a link's URL capture) lives is exactly
# "link containing a code span". This was measured, not assumed: see
# test_generator_catches_href_attribute_bug below, which reconstructs the
# broken href guard and confirms this generator fails against it.

_SENTINEL_RANGE = re.compile("[\uE000-\uE003]")

_FUZZ_SEED = 20260807
_FUZZ_COUNT = 8000

_MARKER_CHARS = list("_*()[]<>&\"/:.` ") + list("0123456789")
_WORDS = [
    "buy", "sell", "AAPL", "stop_loss", "price", "target", "bid_ask_spread",
    "10y_2y_spread", "the", "and", "is", "not", "moving_average_50d", "px",
]
_URL_FRAGMENTS = [
    "https://e.com/x",
    "https://e.com/a_b",
    "https://sec.gov/f_(2023)",
    "javascript:alert(1)",
]
_SENTINELS = ["\uE000", "\uE001", "\uE002", "\uE003"]

# Composed link templates: a link whose label and/or URL contains a code
# span, emphasis marker, or parentheses. These are the shapes that exercise
# "protected span lands inside another pass's capture group" bugs -- the
# href-attribute bug (Fix 1) and the earlier label/emphasis-crossing bug
# (see pass 2's comment in app/messageml.py) both live here.
_LINK_LABELS = ["buy", "stop_loss", "the list", "AAPL", "a(b)", "cash_balance"]
_LINK_URLS = [
    "https://e.com/x",
    "https://e.com/a_b",
    "https://sec.gov/f_(2023)",
    "https://api.e.com/list",
]
_LINK_TEMPLATES = [
    "[{label}]({url})",
    "`[{label}]({url})`",
    "[`{label}`]({url})",
    "[{label}](`{url}`)",
    "[{label}](http:`x`)",
    "_{label}[{label}]({url})**",
    "[the `{label}` endpoint]({url})",
]


def _composed_link(rng: random.Random) -> str:
    label = rng.choice(_LINK_LABELS)
    url = rng.choice(_LINK_URLS)
    template = rng.choice(_LINK_TEMPLATES)
    return template.format(label=label, url=url)


def _generate_fuzz_inputs(rng: random.Random, count: int) -> list[str]:
    inputs = []
    for _ in range(count):
        num_parts = rng.randint(1, 12)
        parts = []
        for _ in range(num_parts):
            bucket = rng.random()
            if bucket < 0.35:
                parts.append(rng.choice(_MARKER_CHARS))
            elif bucket < 0.55:
                parts.append(rng.choice(_WORDS))
            elif bucket < 0.65:
                parts.append(str(rng.randint(0, 9999)))
            elif bucket < 0.78:
                parts.append(rng.choice(_URL_FRAGMENTS))
            elif bucket < 0.93:
                parts.append(_composed_link(rng))
            else:
                parts.append(rng.choice(_SENTINELS))
            if rng.random() < 0.3:
                parts.append(" ")
        inputs.append("".join(parts))
    return inputs


def test_property_no_raise_and_no_sentinel_leak_on_generated_inputs():
    """sanitize(markdown_to_messageml(s)) must not raise, and the output must
    never contain a U+E000-U+E003 sentinel, for any input. Fixed seed makes
    any failure reproducible."""
    rng = random.Random(_FUZZ_SEED)
    for s in _generate_fuzz_inputs(rng, _FUZZ_COUNT):
        out = markdown_to_messageml(s)
        sanitize(out)  # must not raise
        assert not _SENTINEL_RANGE.search(out), f"sentinel leaked for input {s!r}: {out!r}"


def test_generator_catches_href_attribute_bug():
    """Validates the validator: reconstruct the broken href guard (accept a
    placeholder-bearing URL, i.e. revert Fix 1) and confirm the repaired
    generator actually fails against it within its input budget. A property
    test that cannot catch a bug that shipped is decoration."""
    import app.messageml as messageml_module

    # Re-run the whole pipeline with the pre-Fix-1 guard (drop the
    # _PLACEHOLDER.search(url) check) via a small local reimplementation
    # that shares the module's regexes and escaping, so it's a faithful
    # stand-in for the old, broken code.
    def _broken_markdown_to_messageml(md: str) -> str:
        body = messageml_module._escape(md)
        spans: list[str] = []

        def _protect(markup: str) -> str:
            spans.append(markup)
            return f"{messageml_module._SPAN_OPEN}{len(spans) - 1}{messageml_module._SPAN_CLOSE}"

        def _code(m: re.Match[str]) -> str:
            return _protect(f"<code>{m.group(1)}</code>")

        body = messageml_module._CODE.sub(_code, body)

        def _link(m: re.Match[str]) -> str:
            label, url = m.group(1), m.group(2)
            if not messageml_module._HTTP_SCHEME.match(url):  # Fix 1 reverted: no placeholder guard
                return label
            return _protect(f'<a href="{url}">{label}</a>')

        body = messageml_module._LINK.sub(_link, body)
        body = messageml_module._BOLD.sub(lambda m: _protect(f"<b>{m.group(1)}</b>"), body)
        body = messageml_module._BOLD_U.sub(lambda m: _protect(f"<b>{m.group(1)}</b>"), body)
        body = messageml_module._ITAL.sub(lambda m: _protect(f"<i>{m.group(1)}</i>"), body)
        body = messageml_module._ITAL_U.sub(lambda m: _protect(f"<i>{m.group(1)}</i>"), body)
        body = body.replace("\n", "<br/>")

        def _resolve(text: str, resolved: list[str]) -> str:
            def _sub(m: re.Match[str]) -> str:
                idx = int(m.group(1))
                if 0 <= idx < len(resolved):
                    return resolved[idx]
                return m.group(0)

            return messageml_module._PLACEHOLDER.sub(_sub, text)

        resolved: list[str] = []
        for span in spans:
            resolved.append(_resolve(span, resolved))
        body = _resolve(body, resolved)
        return f"<messageML>{body}</messageML>"

    rng = random.Random(_FUZZ_SEED)
    failures = 0
    for s in _generate_fuzz_inputs(rng, _FUZZ_COUNT):
        out = _broken_markdown_to_messageml(s)
        try:
            sanitize(out)
        except MessageMLError:
            failures += 1
    assert failures > 0, "repaired generator failed to catch the reverted href guard"


# --- Attribute validation: hole 1 from the spec (attributes were entirely
# unvalidated) -------------------------------------------------------------


def test_href_javascript_scheme_is_rejected():
    with pytest.raises(MessageMLError):
        sanitize('<messageML><a href="javascript:alert(1)">x</a></messageML>')


def test_href_data_scheme_is_rejected():
    with pytest.raises(MessageMLError):
        sanitize('<messageML><a href="data:text/html,<script>alert(1)</script>">x</a></messageML>')


def test_href_relative_url_is_rejected():
    with pytest.raises(MessageMLError):
        sanitize('<messageML><a href="/relative/path">x</a></messageML>')


def test_href_http_scheme_is_accepted():
    out = sanitize('<messageML><a href="http://example.com">x</a></messageML>')
    assert 'href="http://example.com"' in out


def test_href_https_scheme_is_accepted():
    out = sanitize('<messageML><a href="https://example.com">x</a></messageML>')
    assert 'href="https://example.com"' in out


def test_onclick_attribute_on_b_is_rejected():
    with pytest.raises(MessageMLError):
        sanitize('<messageML><b onclick="alert(1)">x</b></messageML>')


def test_unexpected_attribute_on_a_is_rejected():
    with pytest.raises(MessageMLError):
        sanitize('<messageML><a href="https://example.com" onclick="alert(1)">x</a></messageML>')


# --- Pass-through closure: hole 2 from the spec (sanitize validated the
# parsed tree but returned the caller's original string, so anything the
# parser discarded rather than surfaced as an element rode along unchanged)
# --------------------------------------------------------------------------


def test_doctype_is_rejected():
    with pytest.raises(MessageMLError):
        sanitize("<messageML><!DOCTYPE messageML><b>x</b></messageML>")


def test_internal_entity_declaration_is_rejected():
    payload = (
        "<messageML><!DOCTYPE messageML ["
        '<!ENTITY xxe "expanded">'
        "]><b>&xxe;</b></messageML>"
    )
    with pytest.raises(MessageMLError):
        sanitize(payload)


def test_external_dtd_system_reference_is_rejected():
    payload = (
        '<messageML><!DOCTYPE messageML SYSTEM "http://evil.example/evil.dtd">'
        "<b>x</b></messageML>"
    )
    with pytest.raises(MessageMLError):
        sanitize(payload)


def test_comment_is_silently_dropped():
    # Decision: comments carry nothing to validate or forbid on their own,
    # and ElementTree's parser never surfaces them as tree nodes -- so
    # re-serializing from the parsed tree silently drops them rather than
    # explicitly rejecting the document. Nothing of the comment survives to
    # reach Symphony either way.
    out = sanitize("<messageML><!-- evil --><b>x</b></messageML>")
    assert "evil" not in out
    assert "<b>x</b>" in out


def test_processing_instruction_is_silently_dropped():
    out = sanitize('<messageML><?evil data?><b>x</b></messageML>')
    assert "evil" not in out
    assert "<b>x</b>" in out


def test_round_trip_converter_link_still_passes_sanitize():
    out = markdown_to_messageml("[docs](https://example.com/a_b)")
    safe = sanitize(out)  # must not raise
    assert '<a href="https://example.com/a_b">docs</a>' in safe


# --- Idempotence: sanitize(sanitize(x)) == sanitize(x) ---------------------
#
# ElementTree's text-node escaper (_escape_cdata) escapes &, < and > but not
# CR. A CR *character reference* in the input (e.g. "&#13;") parses to a raw
# "\r" text-node character, which tostring() then emits back out unescaped.
# A second sanitize() pass parses that raw "\r" as literal source text, and
# the XML spec's line-ending-normalization rule (which a parser applies to
# raw CR bytes, not to character references) silently turns it into "\n" --
# so the first pass's output was not stable under a second pass. (Attribute
# values never had this problem: ElementTree's _escape_attrib already emits
# "&#13;" there.) Fixed in sanitize() by re-escaping any raw CR left in the
# serialized output back to "&#13;".


def test_sanitize_cr_reference_round_trips_stably():
    once = sanitize("<messageML>&#13;</messageML>")
    twice = sanitize(once)
    assert once == twice == "<messageML>&#13;</messageML>"


# Small generator dedicated to sanitize() idempotence: builds arbitrary,
# always-well-formed MessageML documents out of allowed tags, a plain <a>
# anchor, and a handful of "interesting" character/entity leaves -- CR in
# three notations (decimal, hex, zero-padded decimal), a bare CR, a bare LF,
# CRLF, and the other XML metacharacter entities -- nested up to 3 levels
# deep inside <b>/<i>/<code>. Every leaf is either plain text or a
# self-contained tag, so recursive .format() nesting can never produce
# unbalanced or malformed XML.
_IDEMPOTENCE_SEED = 20260808

_IDEMPOTENCE_LEAVES = [
    "&#13;", "&#xD;", "&#013;", "&#10;",
    "&amp;", "&lt;", "&gt;", "&quot;",
    "\r", "\n", "\r\n",
    "plain text", "x", " ", "",
    "<br/>",
    '<a href="https://e.com/x">label</a>',
]
_IDEMPOTENCE_WRAPPERS = ["<b>{0}</b>", "<i>{0}</i>", "<code>{0}</code>"]


def _random_idempotence_fragment(rng: random.Random, depth: int = 0) -> str:
    if depth < 3 and rng.random() < 0.4:
        template = rng.choice(_IDEMPOTENCE_WRAPPERS)
        inner = "".join(
            _random_idempotence_fragment(rng, depth + 1) for _ in range(rng.randint(0, 2))
        )
        return template.format(inner)
    return rng.choice(_IDEMPOTENCE_LEAVES)


def _generate_idempotence_docs(rng: random.Random, count: int) -> list[str]:
    docs = []
    for _ in range(count):
        body = "".join(_random_idempotence_fragment(rng) for _ in range(rng.randint(1, 6)))
        docs.append(f"<messageML>{body}</messageML>")
    return docs


def test_sanitize_is_idempotent_on_generated_corpus():
    """A dedicated, fixed-seed sweep over documents built to specifically
    exercise CR in its various notations (the class a larger, independent
    50,000-document sweep found to be the only non-idempotence class).
    Kept small here to stay fast in the normal test run; see the fix
    report for the larger ad hoc sweep."""
    rng = random.Random(_IDEMPOTENCE_SEED)
    violations = []
    for doc in _generate_idempotence_docs(rng, 3000):
        once = sanitize(doc)
        twice = sanitize(once)
        if once != twice:
            violations.append((doc, once, twice))
    assert violations == [], f"{len(violations)} idempotence violations, e.g. {violations[0]}"
