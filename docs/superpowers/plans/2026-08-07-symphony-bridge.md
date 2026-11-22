# symphony-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `symphony-bridge` service — the bot-identity container that BDOBB's shipped Symphony client already posts to, but which has never existed.

**Architecture:** One FastAPI process, one image. Four HTTP endpoints plus an MCP endpoint at `/mcp`. The only code that knows Symphony exists is a `SymphonyClient` protocol with two implementations: `LiveClient` (Python BDK) and `FakeClient` (no credentials). Everything above that seam — validation, MessageML rendering and sanitization, attribution, destination allowlisting, audit logging — is transport-agnostic and testable without a Symphony account.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, pydantic, pytest, ruff, Docker. Symphony Python BDK for the live client only.

**Spec:** `docs/superpowers/specs/2026-08-07-symphony-bridge-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **The bot RSA private key exists only in the container**, as a mounted secret. Never in the repo, never in BDOBB config, never on the desktop.
- **No credential, key path, pod hostname, or bot username may appear in any tracked file.** Tests use obviously-fake values (`pod.example.com`, `test-bot`).
- **`BRIDGE_ALLOWED_DESTINATIONS` is enforced when set.** A request for a destination outside it is **rejected with an error**, never silently dropped.
- **Every send is logged** with: requesting source, destination, content hash, result. **Message bodies are never logged.**
- **`sender` is self-asserted and must never be treated as authentication.** It is a courtesy label.
- **Attribution is `📤 *{sender} via BDOBB*`**, degrading to `📤 *via BDOBB*` when `sender` is absent. It is applied **after** sanitization, from a trusted template — never assembled from unescaped request text.
- **The MCP path is `/mcp`, not `/mcp/`.** The trailing-slash 307 redirect is a known gotcha for this stack's MCP servers.
- **Rita's tool descriptors must stay well under ~2k tokens** (BDOBB's ceiling is 64,000 chars).
- **Python 3.12**, following `key-maint`'s conventions: `app/` + `tests/`, `pyproject.toml`, `pytest`, `ruff`.
- **A failed send surfaces the Symphony error in the response body** — never a silent success.

---

## File Structure

**New — the service** (all under `deploy/symphony-bridge/`):

| File | Responsibility |
|---|---|
| `pyproject.toml` | Package metadata, deps, pytest/ruff config |
| `Dockerfile` | `python:3.12-slim` image |
| `compose.example.yml` | Local bring-up example |
| `app/__init__.py` | Package marker |
| `app/config.py` | Environment parsing into a frozen `Config` |
| `app/messageml.py` | markdown → MessageML, and the sanitizer every payload passes |
| `app/client.py` | `SymphonyClient` protocol + the dataclasses it exchanges |
| `app/fake_client.py` | Credential-free implementation |
| `app/live_client.py` | Python BDK implementation |
| `app/audit.py` | Structured send logging |
| `app/models.py` | Pydantic request/response models for the HTTP API |
| `app/main.py` | FastAPI app, the four endpoints, `/mcp` mount |
| `app/mcp_server.py` | The `post_to_symphony` MCP tool |
| `tests/` | One test module per app module |

**Modified — BDOBB client** (required by the attribution decision):

| File | Change |
|---|---|
| `src/lib/chatShare.ts` | Add optional `sender` to the `POST /messages` payload |
| `src/lib/types.ts` | Add `symphonyDisplayName` to `Settings` |
| `src/lib/persistence.ts` | Default + validate the new field |
| `src/components/dialogs/settings/SymphonyTab.tsx` | Display-name input |
| `.github/workflows/ci.yml` | A Python job |
| `deploy/symphony-bridge/README.md` | Reconcile with what was built |

---

## Task 1: Scaffold, config, health endpoint, CI

**Files:**
- Create: `deploy/symphony-bridge/pyproject.toml`
- Create: `deploy/symphony-bridge/Dockerfile`
- Create: `deploy/symphony-bridge/app/__init__.py`
- Create: `deploy/symphony-bridge/app/config.py`
- Create: `deploy/symphony-bridge/app/main.py`
- Create: `deploy/symphony-bridge/tests/__init__.py`
- Create: `deploy/symphony-bridge/tests/test_config.py`
- Create: `deploy/symphony-bridge/tests/test_health.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `Config` (frozen dataclass with fields `pod_host`, `agent_host`, `bot_username`, `bot_key_path`, `bind`, `allowed_destinations: frozenset[str] | None`, `fake: bool`); `load_config(env: Mapping[str, str] | None = None) -> Config`; `create_app() -> FastAPI`.

- [ ] **Step 1: Write the failing config tests**

Create `deploy/symphony-bridge/tests/test_config.py`:

```python
from app.config import load_config


def test_fake_mode_off_by_default():
    cfg = load_config({})
    assert cfg.fake is False


def test_fake_mode_on_when_set_to_one():
    cfg = load_config({"BRIDGE_FAKE": "1"})
    assert cfg.fake is True


def test_allowed_destinations_is_none_when_unset():
    # None means "no allowlist configured", which is different from an
    # empty allowlist (which would permit nothing).
    cfg = load_config({})
    assert cfg.allowed_destinations is None


def test_allowed_destinations_parses_and_strips():
    cfg = load_config({"BRIDGE_ALLOWED_DESTINATIONS": "abc , def,ghi"})
    assert cfg.allowed_destinations == frozenset({"abc", "def", "ghi"})


def test_blank_allowed_destinations_is_none_not_empty_set():
    cfg = load_config({"BRIDGE_ALLOWED_DESTINATIONS": "   "})
    assert cfg.allowed_destinations is None


def test_reads_pod_settings():
    cfg = load_config({
        "SYMPHONY_POD_HOST": "pod.example.com",
        "SYMPHONY_AGENT_HOST": "agent.example.com",
        "SYMPHONY_BOT_USERNAME": "test-bot",
        "SYMPHONY_BOT_KEY_PATH": "/run/secrets/bot.pem",
        "BRIDGE_BIND": "127.0.0.1:8099",
    })
    assert cfg.pod_host == "pod.example.com"
    assert cfg.agent_host == "agent.example.com"
    assert cfg.bot_username == "test-bot"
    assert cfg.bot_key_path == "/run/secrets/bot.pem"
    assert cfg.bind == "127.0.0.1:8099"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.config'`

- [ ] **Step 3: Write `pyproject.toml`**

Create `deploy/symphony-bridge/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "symphony-bridge"
version = "1.0.0"
description = "Bot-identity bridge between BDOBB and Symphony Messaging"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.110",
    "uvicorn>=0.29",
    "pydantic>=2.6",
    "mcp>=1.2",
]

[project.optional-dependencies]
dev = ["pytest", "pytest-asyncio", "httpx", "ruff"]
live = ["sym-api-client-python>=0.3"]

[tool.setuptools]
packages = ["app"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
asyncio_mode = "auto"

[tool.ruff]
line-length = 100
```

- [ ] **Step 4: Write `app/config.py`**

Create `deploy/symphony-bridge/app/__init__.py` as an empty file, then `deploy/symphony-bridge/app/config.py`:

```python
"""Environment parsing. The service is configured entirely by env vars plus a
mounted key file -- nothing is read from a config file in the image."""

import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    pod_host: str
    agent_host: str
    bot_username: str
    bot_key_path: str
    bind: str
    # None means no allowlist is configured (all destinations permitted).
    # An empty frozenset would mean "permit nothing", which is why blank input
    # must normalise to None rather than to an empty set.
    allowed_destinations: frozenset[str] | None
    fake: bool


def load_config(env: Mapping[str, str] | None = None) -> Config:
    e = os.environ if env is None else env
    raw_allowed = e.get("BRIDGE_ALLOWED_DESTINATIONS", "").strip()
    parsed = frozenset(part.strip() for part in raw_allowed.split(",") if part.strip())
    # `or None` collapses EVERY input that yields no members -- blank,
    # whitespace-only, and comma-only alike -- to "no allowlist configured".
    # An empty frozenset would mean "permit nothing" and silently break all
    # sending, which is the failure this three-state contract exists to avoid.
    allowed = parsed or None
    return Config(
        pod_host=e.get("SYMPHONY_POD_HOST", ""),
        agent_host=e.get("SYMPHONY_AGENT_HOST", ""),
        bot_username=e.get("SYMPHONY_BOT_USERNAME", ""),
        bot_key_path=e.get("SYMPHONY_BOT_KEY_PATH", ""),
        bind=e.get("BRIDGE_BIND", "127.0.0.1:8099"),
        allowed_destinations=allowed,
        fake=e.get("BRIDGE_FAKE", "") == "1",
    )
```

- [ ] **Step 5: Run the config tests to verify they pass**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_config.py -v`
Expected: PASS, 6 tests

- [ ] **Step 6: Write the failing health test**

Create `deploy/symphony-bridge/tests/__init__.py` as an empty file, then `deploy/symphony-bridge/tests/test_health.py`:

```python
from fastapi.testclient import TestClient

from app.main import create_app


def test_health_reports_ok_and_fake_mode():
    client = TestClient(create_app({"BRIDGE_FAKE": "1"}))
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["fake"] is True


def test_health_reports_live_mode_when_not_faking():
    client = TestClient(create_app({}))
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["fake"] is False


def test_health_never_leaks_credentials():
    # A health endpoint is the easiest place to accidentally dump config.
    client = TestClient(create_app({
        "BRIDGE_FAKE": "1",
        "SYMPHONY_BOT_USERNAME": "test-bot",
        "SYMPHONY_BOT_KEY_PATH": "/run/secrets/bot.pem",
    }))
    text = client.get("/health").text
    assert "test-bot" not in text
    assert "bot.pem" not in text
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 8: Write `app/main.py`**

Create `deploy/symphony-bridge/app/main.py`:

```python
"""FastAPI application. Endpoints are added in later tasks; this establishes
the app factory and /health."""

from collections.abc import Mapping

import uvicorn
from fastapi import FastAPI

from app.config import Config, load_config


def create_app(env: Mapping[str, str] | None = None) -> FastAPI:
    cfg: Config = load_config(env)
    app = FastAPI(title="symphony-bridge", version="1.0.0")
    app.state.config = cfg

    @app.get("/health")
    def health() -> dict[str, object]:
        # Deliberately reports posture only -- never configuration values.
        return {"status": "ok", "fake": cfg.fake}

    return app


def main() -> None:
    cfg = load_config()
    host, _, port = cfg.bind.partition(":")
    uvicorn.run(create_app(), host=host or "127.0.0.1", port=int(port or "8099"))


if __name__ == "__main__":
    main()
```

- [ ] **Step 9: Run the health tests to verify they pass**

Run: `cd deploy/symphony-bridge && python -m pytest tests/ -v`
Expected: PASS, 9 tests

- [ ] **Step 10: Write the Dockerfile**

Create `deploy/symphony-bridge/Dockerfile`, following `key-maint`'s shape:

```dockerfile
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /opt/symphony-bridge
COPY pyproject.toml ./
COPY app/ ./app/
RUN pip install .
CMD ["python", "-m", "app.main"]
```

- [ ] **Step 11: Add the Python CI job**

In `.github/workflows/ci.yml`, add a job alongside the existing ones. Read the file first and match its indentation and style; the existing jobs are `check`, `reference`, and the Tauri shell validation.

```yaml
  bridge:
    name: symphony-bridge (Python)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: deploy/symphony-bridge
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install dependencies
        run: pip install -e ".[dev]"
      - name: Lint
        run: ruff check app tests
      - name: Test
        run: python -m pytest -q
```

- [ ] **Step 12: Verify lint and tests are clean**

Run: `cd deploy/symphony-bridge && pip install -e ".[dev]" && ruff check app tests && python -m pytest -q`
Expected: ruff reports no issues; pytest reports 9 passed.

- [ ] **Step 13: Commit**

```bash
git add deploy/symphony-bridge .github/workflows/ci.yml
git commit -m "feat(bridge): scaffold the service with config, health, and CI"
```

---

## Task 2: MessageML conversion and sanitization

**Files:**
- Create: `deploy/symphony-bridge/app/messageml.py`
- Create: `deploy/symphony-bridge/tests/test_messageml.py`

**Interfaces:**
- Produces: `markdown_to_messageml(md: str) -> str`; `sanitize(message_ml: str) -> str`; `MessageMLError(Exception)`.
- Consumed by Task 4 (`POST /messages`) and Task 6 (the MCP tool).

**Why this exists even though BDOBB already converts markdown:** the share-target path (spec F2-5) sends raw markdown with no BDOBB code involved, and the spec makes the bridge responsible for sanitizing *everything* outbound. The bridge is the final authority; a payload arriving as pre-rendered MessageML still passes `sanitize`.

- [ ] **Step 1: Write the failing tests**

Create `deploy/symphony-bridge/tests/test_messageml.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_messageml.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.messageml'`

- [ ] **Step 3: Write `app/messageml.py`**

```python
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
_HREF_OPEN = "\uE000"
_HREF_CLOSE = "\uE001"

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
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_messageml.py -v`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add deploy/symphony-bridge/app/messageml.py deploy/symphony-bridge/tests/test_messageml.py
git commit -m "feat(bridge): markdown to MessageML conversion and sanitizer"
```

---

## Task 3: The client seam and the fake

**Files:**
- Create: `deploy/symphony-bridge/app/client.py`
- Create: `deploy/symphony-bridge/app/fake_client.py`
- Create: `deploy/symphony-bridge/tests/test_fake_client.py`

**Interfaces:**
- Produces: dataclasses `Attachment(filename: str, content_type: str, data: str)`, `SendRequest(stream_id: str, message_ml: str, attachment: Attachment | None)`, `SendResult(message_id: str | None)`, `Conversation(stream_id: str, name: str)`, `Room(stream_id: str, name: str, description: str)`, `HealthStatus(connected: bool, detail: str)`; the `SymphonyClient` protocol; `FakeClient`.
- Consumed by Tasks 4, 5, 6, 7.

- [ ] **Step 1: Write the failing tests**

Create `deploy/symphony-bridge/tests/test_fake_client.py`:

```python
from app.client import Attachment, SendRequest
from app.fake_client import FakeClient


async def test_health_reports_connected():
    status = await FakeClient().health()
    assert status.connected is True


async def test_send_returns_a_message_id():
    client = FakeClient()
    result = await client.send_message(
        SendRequest(stream_id="room-1", message_ml="<messageML>hi</messageML>", attachment=None)
    )
    assert result.message_id


async def test_send_records_what_it_was_asked_to_send():
    client = FakeClient()
    await client.send_message(
        SendRequest(stream_id="room-1", message_ml="<messageML>hi</messageML>", attachment=None)
    )
    assert len(client.sent) == 1
    assert client.sent[0].stream_id == "room-1"


async def test_send_records_attachments():
    client = FakeClient()
    await client.send_message(
        SendRequest(
            stream_id="room-1",
            message_ml="<messageML>table</messageML>",
            attachment=Attachment(filename="t.csv", content_type="text/csv", data="YQ=="),
        )
    )
    assert client.sent[0].attachment is not None
    assert client.sent[0].attachment.filename == "t.csv"


async def test_message_ids_are_unique():
    client = FakeClient()
    req = SendRequest(stream_id="r", message_ml="<messageML>x</messageML>", attachment=None)
    first = await client.send_message(req)
    second = await client.send_message(req)
    assert first.message_id != second.message_id


async def test_list_conversations_returns_stable_fixtures():
    conversations = await FakeClient().list_conversations()
    assert len(conversations) >= 1
    assert all(c.stream_id and c.name for c in conversations)


async def test_search_rooms_filters_by_query():
    client = FakeClient()
    hits = await client.search_rooms("trading")
    assert all("trading" in room.name.lower() for room in hits)


async def test_search_rooms_is_case_insensitive():
    client = FakeClient()
    assert await client.search_rooms("TRADING") == await client.search_rooms("trading")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_fake_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.client'`

- [ ] **Step 3: Write `app/client.py`**

```python
"""The seam. Everything above this file is transport-agnostic; the only code
that knows Symphony exists is an implementation of SymphonyClient."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Attachment:
    filename: str
    content_type: str
    data: str  # base64, no data: prefix


@dataclass(frozen=True)
class SendRequest:
    stream_id: str
    message_ml: str
    attachment: Attachment | None


@dataclass(frozen=True)
class SendResult:
    message_id: str | None


@dataclass(frozen=True)
class Conversation:
    stream_id: str
    name: str


@dataclass(frozen=True)
class Room:
    stream_id: str
    name: str
    description: str


@dataclass(frozen=True)
class HealthStatus:
    connected: bool
    detail: str


class SymphonyClient(Protocol):
    async def health(self) -> HealthStatus: ...

    async def send_message(self, request: SendRequest) -> SendResult: ...

    async def list_conversations(self) -> list[Conversation]: ...

    async def search_rooms(self, query: str) -> list[Room]: ...
```

- [ ] **Step 4: Write `app/fake_client.py`**

```python
"""Credential-free implementation. This is a first-class feature, not a test
double: it is what makes every endpoint verifiable before a sandbox pod exists,
and CI runs entirely against it."""

import itertools

from app.client import (
    Conversation,
    HealthStatus,
    Room,
    SendRequest,
    SendResult,
)

_FIXTURE_ROOMS = (
    Room(stream_id="fake-trading-desk", name="Trading Desk", description="Desk chatter"),
    Room(stream_id="fake-research", name="Research", description="Research notes"),
    Room(stream_id="fake-ops", name="Operations", description="Ops alerts"),
)


class FakeClient:
    """Accepts everything the live client accepts and records it."""

    def __init__(self) -> None:
        self.sent: list[SendRequest] = []
        self._ids = itertools.count(1)

    async def health(self) -> HealthStatus:
        return HealthStatus(connected=True, detail="fake client; no pod session")

    async def send_message(self, request: SendRequest) -> SendResult:
        self.sent.append(request)
        return SendResult(message_id=f"fake-msg-{next(self._ids)}")

    async def list_conversations(self) -> list[Conversation]:
        return [Conversation(stream_id=r.stream_id, name=r.name) for r in _FIXTURE_ROOMS]

    async def search_rooms(self, query: str) -> list[Room]:
        needle = query.lower()
        return [r for r in _FIXTURE_ROOMS if needle in r.name.lower()]
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_fake_client.py -v`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add deploy/symphony-bridge/app/client.py deploy/symphony-bridge/app/fake_client.py deploy/symphony-bridge/tests/test_fake_client.py
git commit -m "feat(bridge): SymphonyClient seam and the credential-free fake"
```

---

## Task 4: `POST /messages`

This is the endpoint the shipped BDOBB client actually calls, and the only one on the critical path.

**Files:**
- Create: `deploy/symphony-bridge/app/models.py`
- Create: `deploy/symphony-bridge/app/audit.py`
- Modify: `deploy/symphony-bridge/app/main.py`
- Create: `deploy/symphony-bridge/tests/test_messages.py`
- Create: `deploy/symphony-bridge/tests/test_audit.py`

**Interfaces:**
- Consumes: `markdown_to_messageml`, `sanitize`, `MessageMLError` (Task 2); `SendRequest`, `Attachment`, `SymphonyClient` (Task 3); `Config` (Task 1).
- Produces: `SendMessageBody` (pydantic); `attribute(message_ml: str, sender: str | None) -> str`; `log_send(...)`; `create_app` now accepts an optional `client` override for tests.

- [ ] **Step 1: Write the failing audit tests**

Create `deploy/symphony-bridge/tests/test_audit.py`:

```python
import logging

from app.audit import log_send


def test_logs_destination_and_result(caplog):
    with caplog.at_level(logging.INFO):
        log_send(source="127.0.0.1", stream_id="room-1", body="secret text", result="ok")
    record = caplog.text
    assert "room-1" in record
    assert "ok" in record
    assert "127.0.0.1" in record


def test_never_logs_the_message_body(caplog):
    with caplog.at_level(logging.INFO):
        log_send(source="127.0.0.1", stream_id="room-1", body="secret text", result="ok")
    assert "secret text" not in caplog.text


def test_logs_a_content_hash_instead_of_the_body(caplog):
    with caplog.at_level(logging.INFO):
        log_send(source="127.0.0.1", stream_id="room-1", body="secret text", result="ok")
    # sha256("secret text") begins with this.
    assert "e0a5c1a3" in caplog.text
```

- [ ] **Step 2: Run to verify failure**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_audit.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.audit'`

- [ ] **Step 3: Write `app/audit.py`**

```python
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
```

- [ ] **Step 4: Run the audit tests**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_audit.py -v`
Expected: PASS, 3 tests. If the hash assertion fails, print `content_hash("secret text")` and correct the expected prefix in the test — the hash is a fact, not a choice.

- [ ] **Step 5: Write the failing endpoint tests**

Create `deploy/symphony-bridge/tests/test_messages.py`:

```python
from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app


def build(env=None, client=None):
    fake = client or FakeClient()
    return TestClient(create_app({"BRIDGE_FAKE": "1", **(env or {})}, client=fake)), fake


def test_accepts_the_share_target_shape():
    # Spec F2-5: {streamId, markdown, title} must work with no BDOBB code.
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "markdown": "**hi**", "title": "T"})
    assert res.status_code == 200
    assert "<b>hi</b>" in fake.sent[0].message_ml


def test_accepts_the_widget_share_shape():
    # What the shipped client sends.
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML>hello</messageML>",
    })
    assert res.status_code == 200
    assert "hello" in fake.sent[0].message_ml


def test_accepts_an_attachment():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML>table</messageML>",
        "attachment": {"filename": "t.csv", "contentType": "text/csv", "data": "YQ=="},
    })
    assert res.status_code == 200
    assert fake.sent[0].attachment.filename == "t.csv"


def test_accepts_plain_text():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "room-1", "text": "plain"})
    assert res.status_code == 200
    assert "plain" in fake.sent[0].message_ml


def test_rejects_a_body_with_no_content():
    api, _ = build()
    res = api.post("/messages", json={"streamId": "room-1"})
    assert res.status_code == 422


def test_rejects_more_than_one_content_field():
    api, _ = build()
    res = api.post("/messages", json={"streamId": "room-1", "text": "a", "markdown": "b"})
    assert res.status_code == 422


def test_attribution_includes_the_sender():
    api, fake = build()
    api.post("/messages", json={"streamId": "room-1", "text": "hi", "sender": "Art"})
    assert "Art via BDOBB" in fake.sent[0].message_ml


def test_attribution_degrades_without_a_sender():
    api, fake = build()
    api.post("/messages", json={"streamId": "room-1", "text": "hi"})
    sent = fake.sent[0].message_ml
    assert "via BDOBB" in sent
    assert "None" not in sent


def test_sender_cannot_inject_markup():
    api, fake = build()
    api.post("/messages", json={
        "streamId": "room-1", "text": "hi", "sender": "<script>x</script>",
    })
    assert "<script>" not in fake.sent[0].message_ml


def test_rejects_pre_rendered_messageml_with_a_disallowed_tag():
    api, fake = build()
    res = api.post("/messages", json={
        "streamId": "room-1",
        "messageML": "<messageML><script>x</script></messageML>",
    })
    assert res.status_code == 400
    assert fake.sent == []


def test_allowlist_permits_a_listed_destination():
    api, fake = build({"BRIDGE_ALLOWED_DESTINATIONS": "room-1,room-2"})
    res = api.post("/messages", json={"streamId": "room-1", "text": "hi"})
    assert res.status_code == 200
    assert len(fake.sent) == 1


def test_allowlist_rejects_an_unlisted_destination_rather_than_dropping_it():
    api, fake = build({"BRIDGE_ALLOWED_DESTINATIONS": "room-1"})
    res = api.post("/messages", json={"streamId": "room-999", "text": "hi"})
    assert res.status_code == 403
    assert fake.sent == []


def test_no_allowlist_permits_any_destination():
    api, fake = build()
    res = api.post("/messages", json={"streamId": "anything", "text": "hi"})
    assert res.status_code == 200
    assert len(fake.sent) == 1
```

- [ ] **Step 6: Run to verify failure**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_messages.py -v`
Expected: FAIL — `create_app() got an unexpected keyword argument 'client'`

- [ ] **Step 7: Write `app/models.py`**

```python
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
```

- [ ] **Step 8: Add the endpoint to `app/main.py`**

Replace `app/main.py` with:

```python
"""FastAPI application."""

from collections.abc import Mapping

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.audit import log_send
from app.client import Attachment, SendRequest, SymphonyClient
from app.config import Config, load_config
from app.fake_client import FakeClient
from app.messageml import MessageMLError, markdown_to_messageml, sanitize
from app.models import SendMessageBody

ATTRIBUTION_SUFFIX = "via BDOBB"


def attribute(message_ml: str, sender: str | None) -> str:
    """Append the attribution line. Built from a trusted template and applied
    after sanitization -- request text never reaches it unescaped."""
    who = markdown_to_messageml(sender).removeprefix("<messageML>").removesuffix("</messageML>") \
        if sender else ""
    label = f"{who} {ATTRIBUTION_SUFFIX}".strip()
    inner = message_ml.removeprefix("<messageML>").removesuffix("</messageML>")
    return f"<messageML>{inner}<br/><i>📤 {label}</i></messageML>"


def build_client(cfg: Config) -> SymphonyClient:
    if cfg.fake:
        return FakeClient()
    from app.live_client import LiveClient  # imported lazily; needs the BDK

    return LiveClient(cfg)


def create_app(
    env: Mapping[str, str] | None = None,
    client: SymphonyClient | None = None,
) -> FastAPI:
    cfg: Config = load_config(env)
    app = FastAPI(title="symphony-bridge", version="1.0.0")
    app.state.config = cfg
    app.state.client = client if client is not None else build_client(cfg)

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"status": "ok", "fake": cfg.fake}

    @app.post("/messages")
    async def send_message(body: SendMessageBody, request: Request) -> JSONResponse:
        if cfg.allowed_destinations is not None and body.stream_id not in cfg.allowed_destinations:
            raise HTTPException(
                status_code=403,
                detail=f"destination {body.stream_id} is not in BRIDGE_ALLOWED_DESTINATIONS",
            )

        if body.message_ml is not None:
            raw = body.message_ml
        elif body.markdown is not None:
            raw = markdown_to_messageml(body.markdown)
        else:
            raw = markdown_to_messageml(body.text or "")

        try:
            safe = sanitize(raw)
        except MessageMLError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        final = attribute(safe, body.sender)
        attachment = (
            Attachment(
                filename=body.attachment.filename,
                content_type=body.attachment.content_type,
                data=body.attachment.data,
            )
            if body.attachment
            else None
        )

        source = request.client.host if request.client else "unknown"
        try:
            result = await app.state.client.send_message(
                SendRequest(stream_id=body.stream_id, message_ml=final, attachment=attachment)
            )
        except Exception as exc:  # surface Symphony's error, never a silent success
            log_send(source=source, stream_id=body.stream_id, body=final, result=f"error: {exc}")
            raise HTTPException(status_code=502, detail=f"Symphony send failed: {exc}") from exc

        log_send(source=source, stream_id=body.stream_id, body=final, result="ok")
        return JSONResponse({"messageId": result.message_id})

    return app


def main() -> None:
    cfg = load_config()
    host, _, port = cfg.bind.partition(":")
    uvicorn.run(create_app(), host=host or "127.0.0.1", port=int(port or "8099"))


if __name__ == "__main__":
    main()
```

- [ ] **Step 9: Run the endpoint tests**

Run: `cd deploy/symphony-bridge && python -m pytest tests/ -v`
Expected: PASS, 32 tests

- [ ] **Step 10: Commit**

```bash
git add deploy/symphony-bridge
git commit -m "feat(bridge): POST /messages with both payload shapes, attribution, allowlist and audit"
```

---

## Task 5: `GET /conversations` and `GET /search/rooms`

Neither has a caller in the shipped BDOBB client — they exist for the Symphony tab's destination picker, which is not built. Keep them thin. Their value here is that their shapes get pinned by tests rather than guessed at later.

**Files:**
- Modify: `deploy/symphony-bridge/app/main.py`
- Create: `deploy/symphony-bridge/tests/test_discovery.py`

**Interfaces:**
- Consumes: `list_conversations`, `search_rooms` (Task 3).
- Produces: `GET /conversations` → `{"conversations": [{"streamId", "name"}]}`; `GET /search/rooms?q=` → `{"rooms": [{"streamId", "name", "description"}]}`.

- [ ] **Step 1: Write the failing tests**

Create `deploy/symphony-bridge/tests/test_discovery.py`:

```python
from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app


def build():
    return TestClient(create_app({"BRIDGE_FAKE": "1"}, client=FakeClient()))


def test_conversations_returns_stream_ids_and_names():
    res = build().get("/conversations")
    assert res.status_code == 200
    items = res.json()["conversations"]
    assert items
    assert set(items[0]) == {"streamId", "name"}


def test_search_rooms_requires_a_query():
    assert build().get("/search/rooms").status_code == 422


def test_search_rooms_returns_matches():
    res = build().get("/search/rooms", params={"q": "trading"})
    assert res.status_code == 200
    rooms = res.json()["rooms"]
    assert rooms
    assert set(rooms[0]) == {"streamId", "name", "description"}


def test_search_rooms_returns_an_empty_list_for_no_matches():
    res = build().get("/search/rooms", params={"q": "zzzz"})
    assert res.status_code == 200
    assert res.json()["rooms"] == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_discovery.py -v`
Expected: FAIL — 404 responses, since the routes do not exist.

- [ ] **Step 3: Add the routes to `app/main.py`**

Insert these inside `create_app`, after the `/messages` handler and before `return app`:

```python
    @app.get("/conversations")
    async def conversations() -> dict[str, object]:
        items = await app.state.client.list_conversations()
        return {"conversations": [{"streamId": c.stream_id, "name": c.name} for c in items]}

    @app.get("/search/rooms")
    async def search_rooms(q: str) -> dict[str, object]:
        rooms = await app.state.client.search_rooms(q)
        return {
            "rooms": [
                {"streamId": r.stream_id, "name": r.name, "description": r.description}
                for r in rooms
            ]
        }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd deploy/symphony-bridge && python -m pytest tests/ -v`
Expected: PASS, 36 tests

- [ ] **Step 5: Commit**

```bash
git add deploy/symphony-bridge
git commit -m "feat(bridge): conversation listing and room search"
```

---

## Task 6: The MCP endpoint

**Files:**
- Create: `deploy/symphony-bridge/app/mcp_server.py`
- Modify: `deploy/symphony-bridge/app/main.py`
- Create: `deploy/symphony-bridge/tests/test_mcp.py`

**Interfaces:**
- Consumes: `SymphonyClient` (Task 3); `attribute` and `log_send` (Task 4); `markdown_to_messageml`, `sanitize` (Task 2).
- Produces: `build_mcp(client: SymphonyClient, cfg: Config) -> FastMCP` exposing one tool, `post_to_symphony(stream_id: str, message: str) -> str`.

**Rita's sends are sends.** They must carry the same attribution as the HTTP path (spec F2-9) and must be audit-logged like any other send (Global Constraints). The tool takes no `sender` parameter — attribution degrades to `📤 *via BDOBB*` — because adding one would spend Rita's tool budget on a value the model would be inventing anyway.

**Constraint:** the tool descriptor must stay well under ~2k tokens. One tool, one short docstring, two scalar parameters.

- [ ] **Step 1: Write the failing test**

Create `deploy/symphony-bridge/tests/test_mcp.py`:

```python
from fastapi.testclient import TestClient

from app.config import load_config
from app.fake_client import FakeClient
from app.main import create_app
from app.mcp_server import build_mcp


async def test_tool_sends_through_the_client():
    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_FAKE": "1"}))
    tools = await mcp.list_tools()
    assert [t.name for t in tools] == ["post_to_symphony"]
    assert len(tools[0].description or "") < 400  # keep Rita's budget small


async def test_tool_attributes_like_the_http_path():
    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_FAKE": "1"}))
    await mcp.call_tool("post_to_symphony", {"stream_id": "room-1", "message": "hi"})
    assert "via BDOBB" in fake.sent[0].message_ml


async def test_tool_writes_an_audit_record(caplog):
    import logging

    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_FAKE": "1"}))
    with caplog.at_level(logging.INFO):
        await mcp.call_tool("post_to_symphony", {"stream_id": "room-1", "message": "secret"})
    assert "room-1" in caplog.text
    assert "secret" not in caplog.text


async def test_tool_respects_the_destination_allowlist():
    fake = FakeClient()
    mcp = build_mcp(fake, load_config({"BRIDGE_ALLOWED_DESTINATIONS": "room-1"}))
    result = await mcp.call_tool("post_to_symphony", {"stream_id": "room-999", "message": "hi"})
    assert fake.sent == []
    assert "not in" in str(result).lower() or "allow" in str(result).lower()


def test_mcp_is_mounted_without_a_trailing_slash():
    # /mcp, not /mcp/ -- the 307 redirect is a known gotcha for this stack.
    api = TestClient(create_app({"BRIDGE_FAKE": "1"}, client=FakeClient()))
    res = api.get("/mcp", headers={"Accept": "text/event-stream"})
    assert res.status_code != 404
```

- [ ] **Step 2: Run to verify failure**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_mcp.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.mcp_server'`

- [ ] **Step 3: Write `app/mcp_server.py`**

```python
"""The MCP surface. One tool, deliberately -- Rita's tool budget is finite and
this is a send path, not a general Symphony proxy."""

from mcp.server.fastmcp import FastMCP

from app.audit import log_send
from app.client import SendRequest, SymphonyClient
from app.config import Config
from app.messageml import markdown_to_messageml, sanitize


def build_mcp(client: SymphonyClient, cfg: Config) -> FastMCP:
    mcp = FastMCP("symphony-bridge")

    @mcp.tool()
    async def post_to_symphony(stream_id: str, message: str) -> str:
        """Post a message to a Symphony conversation. Markdown is converted to
        MessageML. Requires the user's approval in BDOBB before it runs."""
        if cfg.allowed_destinations is not None and stream_id not in cfg.allowed_destinations:
            return f"Refused: {stream_id} is not in the configured destination allowlist."
        # Same pipeline as POST /messages: sanitize, then attribute, then log.
        # Rita has no sender name to offer, so attribution degrades to
        # "via BDOBB" rather than the model inventing one.
        from app.main import attribute

        body = attribute(sanitize(markdown_to_messageml(message)), None)
        try:
            result = await client.send_message(
                SendRequest(stream_id=stream_id, message_ml=body, attachment=None)
            )
        except Exception as exc:
            log_send(source="rita/mcp", stream_id=stream_id, body=body, result=f"error: {exc}")
            return f"Send failed: {exc}"
        log_send(source="rita/mcp", stream_id=stream_id, body=body, result="ok")
        return f"Sent to {stream_id} (message id {result.message_id})."

    return mcp
```

- [ ] **Step 4: Mount it in `app/main.py`**

Add the import at the top:

```python
from app.mcp_server import build_mcp
```

Then, immediately before `return app` in `create_app`:

```python
    mcp = build_mcp(app.state.client, cfg)
    # Mounted at /mcp with no trailing slash. The session manager needs its
    # lifespan run, so the sub-app is mounted whole rather than route by route.
    app.mount("/mcp", mcp.streamable_http_app())
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd deploy/symphony-bridge && python -m pytest tests/ -v`
Expected: PASS, 39 tests.

If the mount raises a lifespan error, wire the session manager's lifespan into the parent app by passing `lifespan=` to the `FastAPI(...)` constructor using the sub-app's lifespan. Consult the installed `mcp` package's own documentation for the exact attribute — do not guess; run `python -c "import mcp; print(mcp.__version__)"` and read that version's API.

- [ ] **Step 6: Commit**

```bash
git add deploy/symphony-bridge
git commit -m "feat(bridge): MCP endpoint exposing post_to_symphony"
```

---

## Task 7: The live client and the opt-in live suite

**Files:**
- Create: `deploy/symphony-bridge/app/live_client.py`
- Create: `deploy/symphony-bridge/tests/test_live.py`

**Interfaces:**
- Consumes: `Config` (Task 1); the `SymphonyClient` protocol and its dataclasses (Task 3).
- Produces: `LiveClient(cfg: Config)` satisfying `SymphonyClient`.

**This task cannot be verified without a Symphony sandbox.** Build it to the protocol, and gate its suite behind `SYMPHONY_LIVE=1` so CI never runs it. That is the same pattern the widget spec describes and that `OPENBB_LIVE` already uses in this ecosystem.

- [ ] **Step 1: Write the live suite, skipped by default**

Create `deploy/symphony-bridge/tests/test_live.py`:

```python
"""Opt-in. Requires a real sandbox pod and bot credentials:

    SYMPHONY_LIVE=1 SYMPHONY_POD_HOST=... SYMPHONY_AGENT_HOST=... \
    SYMPHONY_BOT_USERNAME=... SYMPHONY_BOT_KEY_PATH=... \
    SYMPHONY_TEST_STREAM=... python -m pytest tests/test_live.py -v

Never runs in CI.
"""

import os

import pytest

from app.client import SendRequest
from app.config import load_config
from app.live_client import LiveClient

pytestmark = pytest.mark.skipif(
    os.environ.get("SYMPHONY_LIVE") != "1",
    reason="live suite; set SYMPHONY_LIVE=1 with real pod credentials",
)


async def test_authenticates_against_the_pod():
    status = await LiveClient(load_config()).health()
    assert status.connected is True


async def test_sends_a_real_message():
    stream = os.environ["SYMPHONY_TEST_STREAM"]
    result = await LiveClient(load_config()).send_message(
        SendRequest(
            stream_id=stream,
            message_ml="<messageML>bridge live test</messageML>",
            attachment=None,
        )
    )
    assert result.message_id


async def test_lists_conversations():
    assert await LiveClient(load_config()).list_conversations() is not None
```

- [ ] **Step 2: Verify the suite skips cleanly**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_live.py -v`
Expected: 3 skipped, 0 failed. It must skip rather than error — an import error here would break CI.

- [ ] **Step 3: Write `app/live_client.py`**

```python
"""Symphony BDK implementation. The BDK owns session and key-manager token
refresh, which is why the spec chose it over hand-rolled REST.

Untested against a real pod at the time of writing -- see tests/test_live.py.
"""

from app.client import (
    Attachment,
    Conversation,
    HealthStatus,
    Room,
    SendRequest,
    SendResult,
)
from app.config import Config


class LiveClient:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._bdk = None

    async def _session(self):
        """Lazily build the BDK session so importing this module never requires
        credentials."""
        if self._bdk is None:
            from symphony.bdk.core.config.loader import BdkConfigLoader
            from symphony.bdk.core.symphony_bdk import SymphonyBdk

            config = BdkConfigLoader.load_from_content(
                {
                    "host": self._cfg.pod_host,
                    "agent": {"host": self._cfg.agent_host},
                    "bot": {
                        "username": self._cfg.bot_username,
                        "privateKey": {"path": self._cfg.bot_key_path},
                    },
                }
            )
            self._bdk = SymphonyBdk(config)
        return self._bdk

    async def health(self) -> HealthStatus:
        try:
            bdk = await self._session()
            await bdk.sessions().get_session()
            return HealthStatus(connected=True, detail="pod session established")
        except Exception as exc:
            return HealthStatus(connected=False, detail=str(exc))

    async def send_message(self, request: SendRequest) -> SendResult:
        bdk = await self._session()
        messages = bdk.messages()
        if request.attachment is not None:
            sent = await self._send_with_attachment(messages, request, request.attachment)
        else:
            sent = await messages.send_message(request.stream_id, request.message_ml)
        return SendResult(message_id=getattr(sent, "message_id", None))

    async def _send_with_attachment(self, messages, request: SendRequest, att: Attachment):
        import base64
        import io

        blob = io.BytesIO(base64.b64decode(att.data))
        blob.name = att.filename
        return await messages.send_message(
            request.stream_id, request.message_ml, attachment=[blob]
        )

    async def list_conversations(self) -> list[Conversation]:
        bdk = await self._session()
        streams = await bdk.streams().list_streams(None)
        return [
            Conversation(stream_id=s.id, name=getattr(s, "room_name", "") or s.id)
            for s in (streams or [])
        ]

    async def search_rooms(self, query: str) -> list[Room]:
        bdk = await self._session()
        found = await bdk.streams().search_rooms(query)
        return [
            Room(
                stream_id=r.id,
                name=getattr(r, "name", "") or r.id,
                description=getattr(r, "description", "") or "",
            )
            for r in (found or [])
        ]
```

- [ ] **Step 4: Verify the whole suite still passes and lint is clean**

Run: `cd deploy/symphony-bridge && ruff check app tests && python -m pytest -q`
Expected: ruff clean; 39 passed, 3 skipped.

- [ ] **Step 5: Commit**

```bash
git add deploy/symphony-bridge
git commit -m "feat(bridge): Symphony BDK live client and the opt-in live suite"
```

---

## Task 8: BDOBB sends a sender name

Required by the attribution decision in the spec. Without it every message degrades to `📤 *via BDOBB*`.

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/persistence.ts`
- Modify: `src/lib/chatShare.ts`
- Modify: `src/components/dialogs/settings/SymphonyTab.tsx`
- Modify: `src/lib/chatShare.test.ts`
- Modify: `src/components/dialogs/settings/SymphonyTab.test.tsx`

**Interfaces:**
- Produces: `Settings.symphonyDisplayName: string`; `shareWidgetToSymphony` includes `sender` in its POST body when the setting is non-empty.

**Note:** this repo has NO `lint` script. Verification is `pnpm run typecheck && pnpm run test:run`.

- [ ] **Step 1: Write the failing test for the payload**

In `src/lib/chatShare.test.ts`, add to the `shareWidgetToSymphony` describe block:

```ts
it("includes the sender when one is supplied", async () => {
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  await shareWidgetToSymphony(
    {
      kind: "note",
      bridgeUrl: "https://bridge.test",
      streamId: "room-1",
      title: "Note",
      data: "**hi**",
      sender: "Art Cashin",
    },
    { fetchImpl },
  );
  const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
  expect(body.sender).toBe("Art Cashin");
});

it("omits the sender entirely when it is blank", async () => {
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  await shareWidgetToSymphony(
    {
      kind: "note",
      bridgeUrl: "https://bridge.test",
      streamId: "room-1",
      title: "Note",
      data: "**hi**",
      sender: "   ",
    },
    { fetchImpl },
  );
  const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
  expect("sender" in body).toBe(false);
});
```

The real signature is `shareWidgetToSymphony(input: SymphonyShareInput, deps = {})` — two arguments, with `fetchImpl` in the second. `SymphonyShareInput` is `{ kind, bridgeUrl, streamId, title, data, columns? }`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/chatShare.test.ts`
Expected: FAIL — `body.sender` is `undefined`.

- [ ] **Step 3: Add the field to the settings type and defaults**

In `src/lib/types.ts`, beside the other Symphony fields in `Settings`:

```ts
  /** Display name stamped on outbound Symphony messages as "📤 {name} via BDOBB".
   *  Self-asserted courtesy label, never an identity claim. */
  symphonyDisplayName: string;
```

In `src/lib/persistence.ts`, add `symphonyDisplayName: ""` to `DEFAULT_SETTINGS` beside the other Symphony defaults, and add the matching guard to `isSettingsShape`:

```ts
  if ("symphonyDisplayName" in v && typeof v.symphonyDisplayName !== "string") return false;
```

- [ ] **Step 4: Thread it through `chatShare.ts`**

Add `sender?: string` to the `SymphonyShareInput` interface (`src/lib/chatShare.ts`, beside `columns?`), documented as a self-asserted courtesy label rather than an identity claim. Include it in the POST body only when non-blank:

```ts
  const payload: Record<string, unknown> = { streamId: input.streamId, ...bodyFields };
  if (input.sender && input.sender.trim()) payload.sender = input.sender;
```

Then, at the call site in `src/components/WidgetCard.tsx`, pass `sender: settings.symphonyDisplayName`.

- [ ] **Step 5: Run the payload tests**

Run: `npx vitest run src/lib/chatShare.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the settings field**

In `src/components/dialogs/settings/SymphonyTab.tsx`, add a Display Name input above the Bridge URL field, following the exact structure of the existing fields (`settings-field` / `settings-label` / `settings-input` / `settings-hint`, `htmlFor={`${fieldIds}-symphonyDisplayName`}`). Hint text:

```
Stamped on messages you send as "📤 {name} via BDOBB". Leave blank to send unattributed.
```

Add a test to `src/components/dialogs/settings/SymphonyTab.test.tsx` mirroring the existing per-field onChange tests.

- [ ] **Step 7: Verify the whole suite**

Run: `pnpm run typecheck && pnpm run test:run`
Expected: typecheck clean; the suite passes with no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/persistence.ts src/lib/chatShare.ts src/lib/chatShare.test.ts src/components/WidgetCard.tsx src/components/dialogs/settings/SymphonyTab.tsx src/components/dialogs/settings/SymphonyTab.test.tsx
git commit -m "feat: send a display name to the Symphony bridge for attribution"
```

---

## Task 9: Contract test, compose example, and runbook reconciliation

The contract test is the reason the service lives in this repo at all: it pins BDOBB's payload against the bridge's accepted shapes, so the drift that left this feature unverified for its whole life becomes impossible.

**Files:**
- Create: `deploy/symphony-bridge/tests/test_contract.py`
- Create: `deploy/symphony-bridge/tests/fixtures/bdobb_payloads.json`
- Create: `deploy/symphony-bridge/compose.example.yml`
- Modify: `deploy/symphony-bridge/README.md`
- Modify: `src/lib/chatShare.test.ts`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Emit real payloads from the BDOBB side**

Add a test to `src/lib/chatShare.test.ts` that captures each payload shape the client can produce and writes them to the fixture the Python contract test reads:

```ts
it("writes its payload shapes to the bridge contract fixture", async () => {
  const cases = [
    ["note", { kind: "note", data: "**hi**", title: "Note" }],
    ["table", { kind: "table", data: [{ a: 1 }], title: "Table" }],
  ] as const;

  const shapes: Record<string, unknown> = {};
  for (const [name, args] of cases) {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await shareWidgetToSymphony(
      { ...args, bridgeUrl: "https://bridge.test", streamId: "room-1", sender: "Art" },
      { fetchImpl },
    );
    shapes[name] = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir("deploy/symphony-bridge/tests/fixtures", { recursive: true });
  await fs.writeFile(
    "deploy/symphony-bridge/tests/fixtures/bdobb_payloads.json",
    JSON.stringify(shapes, null, 2) + "\n",
  );
  expect(Object.keys(shapes)).toEqual(["note", "table"]);
});
```



- [ ] **Step 2: Run it to generate the fixture**

Run: `npx vitest run src/lib/chatShare.test.ts`
Expected: PASS, and `deploy/symphony-bridge/tests/fixtures/bdobb_payloads.json` now exists.

- [ ] **Step 3: Write the contract test**

Create `deploy/symphony-bridge/tests/test_contract.py`:

```python
"""Every payload BDOBB can produce must be one the bridge accepts.

The fixture is generated by src/lib/chatShare.test.ts. If this test fails, the
client and the service have drifted -- which is exactly what this file exists
to prevent.
"""

import json
import pathlib

import pytest
from fastapi.testclient import TestClient

from app.fake_client import FakeClient
from app.main import create_app

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "bdobb_payloads.json"


def load_payloads() -> dict[str, dict]:
    if not FIXTURE.exists():
        pytest.skip("fixture not generated; run the BDOBB test suite first")
    return json.loads(FIXTURE.read_text())


@pytest.mark.parametrize("name", ["note", "table"])
def test_bridge_accepts_every_bdobb_payload(name: str):
    payloads = load_payloads()
    fake = FakeClient()
    api = TestClient(create_app({"BRIDGE_FAKE": "1"}, client=fake))
    res = api.post("/messages", json=payloads[name])
    assert res.status_code == 200, res.text
    assert len(fake.sent) == 1


def test_every_payload_carries_a_stream_id():
    for payload in load_payloads().values():
        assert payload["streamId"]
```

- [ ] **Step 4: Run it**

Run: `cd deploy/symphony-bridge && python -m pytest tests/test_contract.py -v`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the compose example**

Create `deploy/symphony-bridge/compose.example.yml`:

```yaml
# Example only. Copy to compose.yml, fill in real values, and never commit it.
services:
  symphony-bridge:
    build: .
    restart: unless-stopped
    network_mode: host
    environment:
      SYMPHONY_POD_HOST: pod.example.com
      SYMPHONY_AGENT_HOST: agent.example.com
      SYMPHONY_BOT_USERNAME: bdobb-bot
      SYMPHONY_BOT_KEY_PATH: /run/secrets/bot.pem
      BRIDGE_BIND: 127.0.0.1:8099
      # BRIDGE_ALLOWED_DESTINATIONS: stream-one,stream-two
      # BRIDGE_FAKE: "1"   # no credentials needed; accepts and logs without sending
    volumes:
      - ./secrets/bot.pem:/run/secrets/bot.pem:ro
```

- [ ] **Step 6: Reconcile the runbook**

`deploy/symphony-bridge/README.md` was written before the service existed and describes an invented contract. Read it against what was built and correct every divergence: the endpoint list, the exact request bodies, the environment variables, and `BRIDGE_FAKE` (which the runbook does not mention at all). Remove the "the HTTP contract is unverified" open-item section — it is now verified by `tests/test_contract.py`, and say so.

- [ ] **Step 7: Full verification**

Run each and confirm clean:

```
cd deploy/symphony-bridge && ruff check app tests && python -m pytest -q
pnpm run typecheck
pnpm run test:run
pnpm run build
docker build -t symphony-bridge:dev deploy/symphony-bridge
```

Expected: ruff clean; 42 passed, 3 skipped; typecheck clean; JS suite green; build succeeds; image builds.

- [ ] **Step 8: Commit**

```bash
git add deploy/symphony-bridge src/lib/chatShare.test.ts
git commit -m "test: pin the BDOBB/bridge payload contract, add compose example, reconcile runbook"
```

---

## Task 10: Final verification

- [ ] **Step 1: Confirm no secrets are tracked**

Run: `git grep -nE "BEGIN (RSA )?PRIVATE KEY|\.pem\"" -- deploy/symphony-bridge || echo CLEAN`
Expected: `CLEAN`, or matches only in documentation and the compose example's volume path.

- [ ] **Step 2: Confirm the fake needs no credentials**

Run:

```bash
cd deploy/symphony-bridge && BRIDGE_FAKE=1 python -c "
from fastapi.testclient import TestClient
from app.main import create_app
c = TestClient(create_app())
print(c.get('/health').json())
print(c.post('/messages', json={'streamId':'r','text':'hi','sender':'Art'}).json())
"
```

Expected: health reports `fake: True`; the send returns a `messageId`. No Symphony credentials present anywhere.

- [ ] **Step 3: Confirm the audit log never contains a body**

Run the service with `BRIDGE_FAKE=1`, post a message containing a distinctive string, and confirm that string does not appear in the log output while the destination and a hash do.

- [ ] **Step 4: Run the full gate**

```
cd deploy/symphony-bridge && ruff check app tests && python -m pytest -q
pnpm run typecheck && pnpm run test:run && pnpm run build
cd src-tauri && cargo test
```

Expected: all clean.

- [ ] **Step 5: Record what remains unverified**

The live path has still never run. Update `deploy/symphony-bridge/README.md` to state plainly that `LiveClient` is untested against a real pod, and that `SYMPHONY_LIVE=1 python -m pytest tests/test_live.py` is the gate to run once a sandbox exists.
