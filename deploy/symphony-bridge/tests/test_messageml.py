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


# --- Round-trip property: sanitize(markdown_to_messageml(s)) never raises -
#
# A curated string list (the previous version of this test) can't find a
# bug class this narrow: none of a handful of hand-picked finance strings
# combine a link with a code span, and the bold/italic-crossing repros are
# six-character inputs like "__*__*" that nobody would think to hand-write.
# This generates a large, fixed-seed corpus from the relevant alphabet
# instead, so it reliably finds -- and keeps finding -- inputs like that.

_SENTINEL_RANGE = re.compile("[\uE000-\uE003]")

_FUZZ_SEED = 20260807
_FUZZ_COUNT = 5000

_MARKER_CHARS = list("_*()[]<>&\"/:. ") + list("0123456789")
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


def _generate_fuzz_inputs(rng: random.Random, count: int) -> list[str]:
    inputs = []
    for _ in range(count):
        num_parts = rng.randint(1, 12)
        parts = []
        for _ in range(num_parts):
            bucket = rng.random()
            if bucket < 0.4:
                parts.append(rng.choice(_MARKER_CHARS))
            elif bucket < 0.65:
                parts.append(rng.choice(_WORDS))
            elif bucket < 0.8:
                parts.append(str(rng.randint(0, 9999)))
            elif bucket < 0.93:
                parts.append(rng.choice(_URL_FRAGMENTS))
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
