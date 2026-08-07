# symphony-bridge — Requirements & Design

- **Date:** 2026-08-07 · **Status:** Approved design, pre-implementation
- **Scope:** The bot-identity bridge service for BDOBB's Symphony integration
- **Builds on:** `2026-08-03-symphony-widget-design.md` (the widget design). That
  document specifies the bridge from the client's point of view; this one
  specifies the service itself.

## 1. Why this exists

BDOBB's Symphony integration shipped its client half first: an embedded chat
card, app-level settings, a "Send to Symphony" action on note/table/chart
widgets, and a human confirmation gate for Rita's `post_to_symphony` tool.

All of the outbound half posts to a service that does not exist. The client
sends to `${settings.symphonyBridgeUrl}/messages` with a body shape that was
never validated against anything, and Rita's tool would arrive over MCP from
that same absent service — so the confirmation gate, which took four review
rounds to harden, has never gated a real tool call.

This service closes that gap. It is also the only place the bot's RSA private
key may exist.

## 2. Decisions that supersede the widget design

Two points here deliberately overrule `2026-08-03-symphony-widget-design.md`:

1. **Location.** F2-1 and §7 of that document place the bridge in **its own
   repository**. It instead lives in **bdobb** at `deploy/symphony-bridge/`,
   next to the runbook that already documents it.

   *Why:* the client and the bridge form one contract, and that contract went
   unverified for the entire feature precisely because nothing could check both
   ends at once. In one repo, CI can. The cost is real and accepted: bdobb is a
   desktop-app repo, and its release tags are app snapshots — after this, a
   bdobb tag also carries a server-side container. §8 records the consequence.

2. **Attribution identity.** F2-6 requires every posted message to carry
   `📤 *{user} via BDOBB*`, but no BDOBB payload contains a user. **BDOBB will
   send an optional `sender` display name**, sourced from a Symphony setting
   (falling back to the OS username).

   *Why:* it keeps the bridge a relay and needs no new auth. It is
   self-asserted and therefore not a security control — the audit log (§6)
   records the true request source, and attribution is a courtesy label, not an
   identity claim. This is stated so no one later mistakes it for one.

## 3. Architecture

One FastAPI process, one image, serving four HTTP endpoints plus an MCP
endpoint. The only code that knows Symphony exists is a single client seam.

```
BDOBB desktop ──HTTP──►  symphony-bridge  ──BDK──►  Symphony pod
  · widget share                │
  · share-target recipe         │  SymphonyClient (protocol)
Rita ──MCP /mcp────────►        ├── LiveClient  (Python BDK)
                                └── FakeClient  (no credentials)
```

**Rejected alternatives.** *Two processes* (HTTP service plus a separate MCP
server) separates concerns better but F2-8 requires the MCP endpoint to add
"no additional deployable". *MCP-only*, expressing the HTTP surface as tools,
breaks F2-5, which requires plain HTTP so conversation sharing stays pure
configuration.

### 3.1 The client seam

```python
class SymphonyClient(Protocol):
    async def health(self) -> HealthStatus: ...
    async def send_message(self, req: SendRequest) -> SendResult: ...
    async def list_conversations(self) -> list[Conversation]: ...
    async def search_rooms(self, query: str) -> list[Room]: ...
```

- `LiveClient` wraps the Symphony **Python BDK**, which owns session and
  key-manager token refresh. Chosen over hand-rolled REST per the widget
  design's §5.3.
- `FakeClient` implements the same protocol with no credentials: it runs the
  same validation, writes the same audit record, and returns realistic
  responses. Selected by `BRIDGE_FAKE=1`.

Everything above the seam — request validation, MessageML rendering and
sanitization, attribution, destination allowlisting, audit logging — is
transport-agnostic and unit-testable without a Symphony account.

**The fake is a first-class feature, not a test double.** CI runs entirely
against it. It is what makes the endpoints verifiable before a sandbox pod
exists, and it stays useful afterwards for development.

## 4. HTTP API (v1)

All four endpoints from F2-3 ship. Two (`/conversations`, `/search/rooms`) have
no caller in the shipped client — they exist for the Symphony tab's destination
picker, which is not built. They are kept deliberately thin, and their response
shapes are pinned by tests against the fake so they are not pure guesswork.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness plus whether the pod session is established. Never requires auth. |
| `GET` | `/conversations` | The bot's known streams, for destination pickers. |
| `POST` | `/messages` | Send. The one endpoint the shipped client uses. |
| `GET` | `/search/rooms?q=` | Room search, for choosing destinations. |
| — | `/mcp` | MCP endpoint exposing `post_to_symphony` to Rita. Note: `/mcp`, **not** `/mcp/` — the trailing-slash 307 redirect is a documented gotcha for this stack's other MCP servers. |

### 4.1 `POST /messages` — the contract

The endpoint accepts **both** payload shapes, because two independent BDOBB
paths produce different ones:

**A. Share-target shape** (F2-5 — pure configuration, no BDOBB code):

```json
{ "streamId": "…", "markdown": "…", "title": "…", "sender": "…" }
```

**B. Widget-share shape** (F2-6 — what the shipped client sends):

```json
{ "streamId": "…", "messageML": "<messageML>…</messageML>",
  "attachment": { "filename": "…", "contentType": "…", "data": "<base64>" },
  "sender": "…" }
```

`text` is accepted as a synonym for a plain-text body. `sender` is optional in
both. Exactly one of `markdown` / `messageML` / `text` must be present.

**Attribution.** The bridge prepends `📤 *{sender} via BDOBB*` to every message
body before sending (F2-6, F2-9). When `sender` is absent it degrades to
`📤 *via BDOBB*` rather than inventing a name. Attribution is applied after
sanitization, from a trusted template — it is never assembled from unescaped
request text.

**Responses.** `2xx` on success with the Symphony message id when available.
On failure the Symphony error is returned in the body — never swallowed
(F2-7). The client surfaces it verbatim.

### 4.2 The MessageML duplication, stated plainly

BDOBB already converts markdown to MessageML client-side, in code hardened
through review: escape-before-format ordering, private-use-area placeholder
protection for `href` values, an `http(s)`-only scheme allowlist.

The bridge needs its own converter anyway, because shape A arrives as raw
markdown and F2-7 makes the bridge responsible for sanitizing everything
outbound. So the conversion exists twice, in two languages.

**This is accepted, with the bridge as the final authority:** every payload
passes the bridge's sanitizer regardless of origin, including one that arrives
as pre-rendered MessageML. The alternative — deleting BDOBB's converter and
always sending markdown — would discard reviewed code and cannot express the
table and chart paths, which render client-side.

## 5. Configuration

Environment variables only, plus a mounted key file. Per the widget design §5.3.

| Variable | Required | Purpose |
|---|---|---|
| `SYMPHONY_POD_HOST` | yes (live) | Pod hostname |
| `SYMPHONY_AGENT_HOST` | yes (live) | Agent hostname |
| `SYMPHONY_BOT_USERNAME` | yes (live) | Service account |
| `SYMPHONY_BOT_KEY_PATH` | yes (live) | Path to the mounted RSA private key |
| `BRIDGE_BIND` | yes | Listen address; bind to the tailnet interface |
| `BRIDGE_ALLOWED_DESTINATIONS` | no | Comma-separated stream-id allowlist — a blast-radius limiter |
| `BRIDGE_FAKE` | no | `1` selects `FakeClient`; no Symphony credentials needed |

**Two URLs, one service — the operator gotcha.** BDOBB's *Bridge URL* setting
is this service's HTTP base; the client posts to `<base>/messages`. Its MCP
endpoint is `<base>/mcp`, configured separately in BDOBB's MCP settings tab.
Putting `/mcp` in the Bridge URL field breaks widget sharing, and the
confirmation gate's provenance check compares the two by **origin**, so they
must share one.

## 6. Security

- The bot RSA private key exists only in this container, as a mounted secret.
  Never in the repo, never in BDOBB config, never on the desktop.
- All bot traffic egresses from this container.
- `BRIDGE_ALLOWED_DESTINATIONS` is enforced when set; a request for a
  destination outside it is rejected, not silently dropped.
- Every send is logged: requesting source, destination, content hash, and
  result. Message bodies are not logged.
- No request auth in v1 beyond tailnet reachability, consistent with this
  stack's existing posture. Revisit if the tailnet is shared beyond trusted
  users.
- `sender` is self-asserted and must never be treated as authentication (§2).
- No credential, key path, bucket, or host name may appear in any tracked file.

## 7. Testing

- **pytest against the fake** for all four endpoints and `/mcp`. No credentials,
  runs in CI.
- **Sanitizer unit tests**, including hostile input: `<script>`, attribute
  break-out attempts, and non-`http(s)` link schemes.
- **A contract test** asserting that the payloads `src/lib/chatShare.ts`
  produces are exactly what `POST /messages` accepts. This is the test that
  makes the location decision (§2) pay for itself — it is only possible because
  both ends are in one repo.
- **Opt-in live suite** (`SYMPHONY_LIVE=1`), never in CI: auth round-trip,
  real send, ECP URL reachability. Mirrors the existing `OPENBB_LIVE` pattern.
- **A Python job added to bdobb's CI.** The repo has no Python today; its
  pipeline is three Node/Rust jobs. Follows `key-maint`'s conventions —
  Python 3.12, `pytest`, `ruff`.

## 8. Deliverables

**The service** (`deploy/symphony-bridge/`): `app/`, `tests/`,
`pyproject.toml`, `Dockerfile`, `compose.example.yml`, and a reconciled
`README.md`.

**A small BDOBB change**, required by the attribution decision (§2) and easy to
overlook because the rest of the client already shipped:

- add an optional `sender` field to the `POST /messages` payload in
  `src/lib/chatShare.ts`
- add the setting that sources it (a display-name field in the Symphony
  settings tab, defaulting to the OS username)

Without this the bridge has no `sender` and every message degrades to
`📤 *via BDOBB*`.

**A Python CI job** in bdobb's pipeline.

## 9. Consequences to record

- **bdobb tags now carry a server-side container.** The release convention
  treats each tag as an app snapshot; from Ep. 12 onward a tag also contains
  this service. The episode plan's Phase 4 should account for it.
- **`episodes-10-12-plan.md` open item resolves to "no separate openbb-docker
  release"** — the bot half found a home in bdobb rather than the market-data
  stack, so Ep. 12 remains a bdobb-only release as originally planned.
- **`deploy/symphony-bridge/README.md` already exists** and documents this
  service's contract and gotchas. It must be reconciled with what is built —
  it was written before the service and describes the invented contract.

## 10. Out of scope for v1

- Request authentication beyond network reachability.
- A destination picker in BDOBB's Symphony settings tab (the consumer for
  `/conversations` and `/search/rooms`).
- Replacing the `window.prompt` stream-ID entry.
- Inbound Symphony → BDOBB (datafeed, message receipt).
- On-behalf-of sending. Messages are sent by the bot with attribution, never
  forged as the user.
