# BDOBB Symphony Widget — Requirements & Design

- **Date:** 2026-08-03 · **Updated:** 2026-08-06 (rebased on the `bdobb` repo at v9.0.0)
- **Status:** Approved design, pre-implementation
- **Author:** Art Cashin, with Claude (brainstorming skill)
- **Scope:** Symphony Messaging integration for BDOBB (chat card + outbound alerts)
- **Release framing:** BDOBB ships one episode per tagged release ("Adventures in OpenBB"). This work is a future episode (v10+); the phases below could map to more than one episode.

---

## 1. Overview

BDOBB gains the ability to communicate over [Symphony Messaging](https://symphony.com) — the financial-markets chat network — in two directions:

1. **Two-way chat inside BDOBB.** A new built-in dashboard widget (joining Note, Clock, Website, and the News rail) embeds a Symphony conversation. The user reads and replies **as themselves**, with their own Symphony identity, to both internal colleagues and external counterparties (cross-pod).
2. **Outbound alerts from BDOBB.** BDOBB pushes content into Symphony conversations through a bot identity: manual sharing via the existing *Send to…* flow, Agent Rita posting summaries via a tool, and (later) data-driven alert rules on widget data.

### Goals

- Symphony conversations pinned onto BDOBB dashboards next to market data, so a research/trading workflow doesn't leave the app.
- Attributed, compliant human chat — messages come from the real user, with Symphony's own UI, encryption, and compliance stack doing what it already does.
- A single, controlled path for automated/bot traffic that keeps credentials off desktops.

### Non-goals

- **Not** a custom-built chat UI. Symphony's Embedded Mode renders the conversation; BDOBB provides the frame and the surrounding workflow. (Rationale in §8.)
- **Not** a Symphony extension app (an app running *inside* Symphony's client). This is the inverse: Symphony inside BDOBB.
- **Not** replacing the Symphony desktop client. Notifications, search across all conversations, and settings management remain in Symphony's own clients.
- **No** on-behalf-of (OBO) message sending in early phases — automated messages are sent by a bot with an attribution line, not forged as the user (OBO is a documented Phase 3+ option, §4.4).

---

## 2. Background

### 2.1 BDOBB architecture (as of this writing)

BDOBB (repo: `artcashin/bdobb`, currently **v9.0.0**) is a **Tauri 2 + React 19 + TypeScript** desktop app: a widget grid (react-grid-layout) speaking the OpenBB `widgets.json` protocol, a left rail, and a right AI pane (Agent Rita). Facts that constrain this design:

- **Four built-in widgets exist** (Note, Clock, Website, News rail) that need no `widgets.json` backend; the Symphony card becomes the fifth. Built-ins are registered in `src/lib/builtins.ts` (a `BUILTIN_SYMPHONY_ID = "builtin:symphony"` entry with `def()`/`param()` helpers under the reserved `builtin` backendId), with a renderer in `src/components/renderers/` (naming convention `*Renderer.tsx`; the Website widget's is `IframeRenderer.tsx`) and dispatch in `WidgetCard.tsx`.
- **The Tauri HTTP scope is open to any http(s) host** (changed since this spec's first draft): BDOBB is a generic front end and which backends it talks to is runtime configuration, not compiled in. Egress discipline is enforced **per-endpoint in app code instead** — e.g. the live_grid and News rail widgets origin-pin their sockets so nothing in `widgets.json` can redirect them. Symphony endpoints follow that convention, not a capability edit.
- **CSP is deliberate and documented.** `script-src 'self'` and `object-src 'none'` are load-bearing; `frame-src` permits any `http:`/`https:` origin (this is what lets the Website widget point anywhere); `connect-src` is broad because SSE/MCP use `window.fetch`.
- **The Website widget already solved iframe embedding**, including a header preflight that detects `X-Frame-Options`/`frame-ancestors` refusals and renders an explanation instead of a blank card, and a sandbox policy (no `allow-same-origin`).
- **A share-target system exists** (Settings → Rita tab → "Send chat to…", `src/lib/chatShare.ts`): targets of kind `mcp`, `http`, or `file`, each with a JSON body template substituting `{{markdown}}`, `{{title}}`, `{{filename}}`, `{{exportedAt}}`. It is deliberately app-agnostic — a new destination is configuration, not code.
- **The Settings dialog is tabbed** (Rita / MCP / Appearance / Logs, components under `src/components/dialogs/settings/`), so Symphony settings have a natural home as a tab.
- **Rita's tool budget is finite** — `assembleTools` enforces `TOOL_PAYLOAD_BUDGET_CHARS` (64,000 chars ≈ 16k tokens), and the MCP settings tab now has a budget-check UI. Rita itself carries no MCP config; tool descriptors are passed per request. A privacy toggle gates dashboard-context sharing and widget-derived MCP servers.
- **Companion services follow a `deploy/<service>/` convention** — `deploy/spark/` documents Agent Rita's deployment (Docker, `--restart unless-stopped`, host networking on the tailnet, env file mode 600, pinned commit, smoke tests). The Symphony bridge follows the same pattern.

### 2.2 Symphony platform primer

- A **pod** is a firm's Symphony tenancy (`{firm}.symphony.com`). Pods federate: users on different pods converse cross-pod ("external rooms"). REST APIs split across the **Pod API** (admin/user/stream management), the **Agent API** (message send/receive — the agent handles encryption), and **Key Manager** (auth). ([API reference](https://rest-api.symphony.com/))
- **Embedded Mode (ECP)** embeds Symphony's real chat UI in a third-party application. Three integration styles: **direct iframe** (`https://{pod}.symphony.com/embed/index.html?streamId={STREAM_ID}&partnerId={partnerId}&mode=dark`), **explicit-render SDK** (`/embed/sdk.js`, `window.symphony` API, `openStream()`), and a deprecated automatic mode. Users authenticate in-frame via the pod's SSO, as in the Symphony desktop app; a `ecpLoginPopup` option exists for CSP-constrained hosts. ([ECP docs](https://docs.developers.symphony.com/embedded-modules/embedded-mode/get-started))
- **Bots** are service accounts authenticating with an **RSA keypair** (public key registered on the pod), calling the Agent API to send/receive messages. The [BDK](https://github.com/finos/symphony-bdk-java) (Java, Python) wraps this.
- **ECP requires pod-side enablement and a partner ID** from Symphony — a licensing/entitlement conversation, not just code.
- **A free developer sandbox exists.** Registering at the [Developer Center](https://developers.symphony.com) — bundled with Symphony's free **Developer Certification program** — grants access to the **Developer Sandbox pod at `develop2.symphony.com`**, where developers create their own service accounts without a pod administrator. The program also includes free bot-building courses (BDK for Java, BDK for Python, WDK). On a corporate pod, by contrast, only a pod administrator can create service accounts (Admin Portal at `https://{pod}.symphony.com/?admin` → Create an Account → Service Account: enter the bot username, paste the RSA public key, grant roles/entitlements). ([Creating a service account](https://docs.developers.symphony.com/bots/getting-started/creating-a-bot-user.md))

---

## 3. Users & use cases

The BDOBB user is a markets professional running a self-hosted OpenBB research stack, chatting with internal colleagues and external counterparties on Symphony.

- **U1 — Pin a room to a dashboard.** "My FX dashboard has the EURUSD chart, the news widget, and the broker room where we talk about it." Add a Symphony card, pick the conversation, done. The card travels with the dashboard (persisted like any card).
- **U2 — Reply without switching apps.** A message arrives in the pinned room; the user reads and replies in the card, as themselves.
- **U3 — Share a widget's content.** *Send to… → Symphony conversation* posts a snapshot/extract of a widget (table slice, chart image, note text) into a chosen conversation, marked as sent from BDOBB by that user.
- **U4 — Rita posts a summary.** "Rita, summarize this dashboard and post it to the morning-meeting room." Rita composes; the bridge posts it.
- **U5 — Data-driven alert (Phase 3).** A rule on a widget's data ("10Y yield > 4.5%") fires a formatted message into a designated room.

---

## 4. Functional requirements

### 4.0 Phase 0 — Prerequisites (no code)

| ID | Requirement |
|---|---|
| P0-1 | Register at the [Symphony Developer Center](https://developers.symphony.com) (free Developer Certification program) to obtain access to the **Developer Sandbox pod at `develop2.symphony.com`**. No corporate pod or administrator is needed; the certification courses (BDK Java/Python, WDK) are included and worth taking before Phase 2. |
| P0-2 | Obtain a **partner ID** and confirm **ECP entitlement**. There is **no self-service path**: per Symphony's [pricing-tiers docs](https://docs.developers.symphony.com/embedded-modules/embedded-mode/pricing-tiers.md), the partner ID is issued "following the conclusion of the Embedded Mode contract" and is bound to a plan tier (Basic / Workflow / Custom — Basic may suffice for a read/reply card) **and to the hosting domain** (raise early that BDOBB is a desktop webview, not a conventional web domain). Start via [symphony.com/contact](https://symphony.com/contact/); the [Embedded Mode demo](https://support.symphony.com/hc/en-us/articles/6177263179924-Embedded-Mode-demo) is try-before-contract. ⚠️ Sandbox docs confirm *bot* support but are silent on ECP availability there — this gates Phase 1 (chat) while the sandbox alone unblocks Phase 2 (bridge/bot). |
| P0-3 | Create a **service account (bot)** on the sandbox with an RSA keypair — self-service there, unlike a corporate pod where a pod administrator must create it in the Admin Portal (`https://{pod}.symphony.com/?admin`, Service Account tab: username must exactly match the bot config, public key pasted in Authentication, roles/entitlements granted). The BDK generator (`yo @finos/symphony`) produces the keypair and `config.yaml`. Record both paths as runbook material for the bridge. |
| P0-4 | Verify in a plain browser that a sandbox conversation renders via the direct-iframe ECP URL, and capture the exact login flow (SSO redirect vs. popup) for §6.3 testing. |
| P0-5 | Confirm licensing/commercial terms for ECP and bot usage before any production rollout; capture findings in this doc's §10. |

### 4.1 Phase 1 — Symphony chat card (ECP direct iframe)

| ID | Requirement |
|---|---|
| F1-1 | A new built-in widget type `symphony` appears in the widget library under "Built-in", alongside Note, Clock, Website, News rail — registered in `lib/builtins.ts` as `BUILTIN_SYMPHONY_ID = "builtin:symphony"` under the reserved `builtin` backendId. |
| F1-2 | Card parameters: **pod URL** (defaulted from settings, §5.4), **conversation** (stream ID string in v1), **mode** (`focus` default), **theme** (follows BDOBB dark theme by default, `mode=dark`). |
| F1-3 | The card renders the ECP **direct-iframe** URL for the configured conversation. No SDK script is loaded; `script-src 'self'` is untouched. |
| F1-4 | The iframe reuses the Website widget's header-preflight pattern: if the pod refuses framing or returns an error page, the card shows the reason and an *Open externally* button — never a blank rectangle. |
| F1-5 | First use requires in-frame Symphony login (SSO). The card must tolerate the login redirect inside the frame; if the pod's IdP refuses to be framed, the card detects it (F1-4 path) and offers popup-based login (`ecpLoginPopup`) or external login guidance. |
| F1-6 | Multiple Symphony cards may exist on one or several dashboards, each pointing at a different conversation. |
| F1-7 | Cards persist and restore with dashboards exactly like other cards (`dashboards/` in `$APPDATA`); a card whose pod URL is no longer configured reports itself unresolved rather than erroring. |
| F1-8 | The iframe sandbox policy is documented and deliberate. Note: ECP requires enough sandbox permissions to run Symphony's client (`allow-scripts`, `allow-same-origin`, `allow-forms`, `allow-popups` for SSO) — stricter than the Website widget's policy is not achievable here; §6.2 records the reasoning. |

### 4.2 Phase 2 — `symphony-bridge` service + Send to…

| ID | Requirement |
|---|---|
| F2-1 | A new deployable, **`symphony-bridge`**, runs as a **Docker container on the user's tailnet** (like NAS and Rita). Code lives in its own repository; its deployment runbook lives in BDOBB at **`deploy/symphony-bridge/README.md`** following the `deploy/spark/` convention (Docker, `--restart unless-stopped`, host networking, env file mode 600, pinned commit, smoke-test section). |
| F2-2 | The bridge holds the bot's **RSA private key and pod configuration**; authenticates to Symphony (session + key-manager tokens); exposes a small internal HTTP API to tailnet clients. Credentials never reach the desktop. |
| F2-3 | Bridge API (v1): `GET /health`, `GET /conversations` (bot's known streams, for pickers), `POST /messages` (streamId + MessageML/markdown + optional attachment), `GET /search/rooms?q=` (optional, for choosing destinations). |
| F2-4 | BDOBB gains `VITE_SYMPHONY_BRIDGE_URL` (seed-on-fresh-install, like other endpoints). No Tauri capability change is needed — the HTTP scope is already open — but the bridge URL is **origin-pinned in app code** the way live_grid/News rail endpoints are: nothing configurable per-card may redirect Symphony traffic to another host. |
| F2-5 | ***Send chat to… → Symphony*** (conversation sharing) is **pure configuration, no BDOBB code**: an `http` share target pointing at the bridge's `POST /messages`, template `{"streamId": "…", "markdown": "{{markdown}}", "title": "{{title}}"}`. The bridge accepts this shape directly so the existing template system works as-is. Ship it as a documented recipe (and optionally a one-click "add Symphony target" affordance in the Symphony settings tab). |
| F2-6 | **Widget-content sharing is new code** (the existing share system covers Rita conversations only): a per-card "Send to Symphony" action for Note text (markdown → MessageML), table widget data (as table or CSV attachment), and chart snapshot (PNG attachment). Posted messages carry attribution: sent by the bot, formatted "📤 *{user} via BDOBB*" + content. |
| F2-7 | The bridge validates and sanitizes all outbound MessageML; a failed send surfaces the Symphony error in BDOBB, not a silent drop. |
| F2-11 | A **Symphony tab** in the tabbed Settings dialog (`src/components/dialogs/settings/SymphonyTab.tsx`): pod URL, partner ID, bridge URL, default conversation list. Follows the tab pattern — draft state lifted in `SettingsDialog`, single Save, per-tab component tests. |

### 4.3 Phase 2 — Rita integration

| ID | Requirement |
|---|---|
| F2-8 | Rita gains a **`post_to_symphony`** tool (streamId or saved-destination name + message). The bridge itself exposes an MCP endpoint at `/mcp` (added via the MCP settings tab / `VITE_MCP_SERVERS`) — no additional deployable. Budget: the added tool descriptors must stay well under ~2k tokens given the 64k-char `TOOL_PAYLOAD_BUDGET_CHARS` ceiling; verify with the MCP tab's budget-check UI. Note the `/mcp` (not `/mcp/`) path convention and 307-redirect gotcha documented for other MCP servers. |
| F2-9 | Rita's sends go through the same bridge and carry the same bot identity/attribution as F2-5. No separate credential path. |
| F2-10 | Human confirmation: a Rita-composed Symphony message is shown to the user for approval before the bridge sends it (BDOBB-side gate, not trust in the model). |

### 4.4 Phase 3 — Later work (scoped, not designed)

| ID | Requirement |
|---|---|
| F3-1 | **Data-driven alerts:** rules attached to widget data (threshold, change, keyword in news) that fire bridge messages to designated rooms. Needs a rules UI, evaluation on the existing polling path in `dataClient`, dedup/cooldown, and an audit log. Its own design doc when scheduled. |
| F3-2 | **ECP SDK upgrade:** move from direct iframe to explicit-render SDK for `openStream()` switching, unread badges, and notifications — requires loosening `script-src` to the pod host; revisit the CSP trade explicitly then. |
| F3-3 | **OBO (on-behalf-of) sending:** automated messages attributed as the actual user, requiring a Symphony app entitlement and OBO session flow on the bridge. |
| F3-4 | **Inbound processing:** the bridge subscribes to the Agent datafeed (mentions, keywords) and raises BDOBB notifications or Rita context. |

---

## 5. Architecture

### 5.1 Components

```
┌────────────────────────  desktop (Tauri)  ───────────────────────┐
│ BDOBB                                                            │
│  ├─ Symphony card (renderer)  ──iframe──►  {pod}.symphony.com    │  chat as the USER
│  │     └─ header preflight (Rust cmd, as Website widget)         │  (ECP, SSO in-frame)
│  ├─ Send to… → Symphony  ──plugin-http──►  symphony-bridge       │
│  └─ Rita ──tool──► MCP ─────────────────►  symphony-bridge       │
└──────────────────────────────────────────────────────────────────┘
                              tailnet │
                     ┌────────────────▼───────────────┐
                     │ symphony-bridge (Docker)       │  alerts as the BOT
                     │  RSA key, session mgmt,        │
                     │  MessageML build, audit log    │
                     └────────────────┬───────────────┘
                                      │ https (Symphony REST: pod + agent APIs)
                              Symphony cloud
```

Two independent trust paths, on purpose: the **chat path** never touches BDOBB code beyond an iframe (Symphony's client handles keys, encryption, compliance), and the **bot path** never touches the desktop's disk (key stays in the container).

### 5.2 The Symphony card

- `WidgetType` gains `symphony`; built-in registered in `lib/builtins.ts` (`BUILTIN_SYMPHONY_ID`, card params via the `param()` helper so they persist with the card); renderer `renderers/SymphonyRenderer.tsx` (matching `IframeRenderer.tsx` et al.); dispatch in `WidgetCard.tsx`.
- Renders `https://{pod}/embed/index.html?streamId={id}&partnerId={pid}&mode=dark&condensed=true` (final parameter set fixed during Phase 0 verification).
- Reuses the Website widget's preflight command to distinguish "pod down", "not entitled", "frame refused" and render actionable errors.
- Stream IDs in v1 are pasted by the user (Symphony clients expose them; the doc's runbook will show how). A conversation picker is a Phase 2 nicety once the bridge's `GET /conversations` exists.

### 5.3 The `symphony-bridge` container

- **Packaging:** Docker image, `docker run`/compose-friendly, configured entirely by environment variables + a mounted key file: `SYMPHONY_POD_HOST`, `SYMPHONY_AGENT_HOST`, `SYMPHONY_BOT_USERNAME`, `SYMPHONY_BOT_KEY_PATH`, `BRIDGE_BIND`, optional `BRIDGE_ALLOWED_DESTINATIONS` (allowlist of streamIds the bridge will post to — a blast-radius limiter). Deployment posture mirrors `deploy/spark/`: `--restart unless-stopped`, host networking on the tailnet host, env file mode 600 never committed, pinned commit recorded in the runbook, curl smoke tests documented.
- **Implementation basis:** Symphony **BDK** (Python BDK preferred for a small service; Java BDK acceptable) rather than hand-rolled REST — the BDK handles session/key-manager token refresh and MessageML quirks.
- **Surface:** the minimal API of F2-3 — deliberately not a general Symphony proxy. Every send is logged (who asked, destination, content hash, result) to stdout/file for audit.
- **Network posture:** listens only on the tailnet interface; no auth in v1 beyond network reachability, consistent with BDOBB's existing tailnet posture — revisit if the tailnet is shared beyond trusted users (§10).

### 5.4 Configuration (BDOBB)

- New env/settings: `VITE_SYMPHONY_POD_URL` (seeds the card's pod default), `VITE_SYMPHONY_BRIDGE_URL`. Both flow through the existing seed-on-fresh-install semantics, surfaced in the new **Symphony settings tab** (F2-11).
- **No Tauri capability change** (updated from the first draft): the HTTP scope is now open to any http(s) host by design — BDOBB is a generic front end. The discipline that replaced the allowlist is **in-code origin pinning** (as live_grid and News rail do for their sockets): the Symphony renderer builds its iframe URL only from the configured pod host, and bridge calls go only to the configured bridge URL — nothing card-configurable can redirect either.
- **Egress posture note:** Symphony is cloud SaaS. Desktop-side traffic is the ECP iframe to `{pod}.symphony.com`; all bot traffic egresses from the bridge container, not the desktop.

### 5.5 CSP analysis

No CSP change in Phases 1–2: `frame-src` already allows `https:`; `script-src 'self'` untouched because no SDK script loads; `connect-src` already broad for the preflight/fetch paths that need it. The only future pressure point is F3-2 (SDK), flagged there.

---

## 6. Non-functional requirements

### 6.1 Security

- Bot RSA private key exists **only** in the bridge container (mounted secret); never in `$APPDATA`, never in BDOBB config, never in the repo.
- Bridge enforces destination allowlisting when configured (F2-2/5.3) and logs every send.
- Rita cannot send without explicit human approval in the BDOBB UI (F2-10).
- BDOBB's `script-src 'self'`/`object-src 'none'` invariants hold through Phase 2 (§5.5).

### 6.2 Sandbox trade (recorded)

The ECP iframe needs `allow-same-origin` + `allow-scripts` (Symphony's full client runs inside), unlike the Website widget's stricter sandbox. This is acceptable because the frame origin is a **configured, trusted pod**, not an arbitrary user-typed URL — the two widgets have different threat models and different sandbox policies, and both are documented.

### 6.3 Testing

- Unit/component tests for the renderer (param handling, error states) with the existing vitest + jsdom harness; the preflight mocked as for the Website widget.
- An **opt-in live suite** (`SYMPHONY_LIVE=1`) against the sandbox pod: bridge auth round-trip, message send, ECP URL reachability — mirroring the existing `OPENBB_LIVE` pattern, never run in CI.
- Bridge repo carries its own tests + a compose file for local bring-up.
- Phase 0 exit criterion P0-4 (browser-verified ECP render + captured login flow) gates Phase 1 work — webview SSO is the highest-uncertainty item and gets verified *first*, in the cheapest environment.

### 6.4 Performance & UX

- ECP render is ~4s per Symphony's docs; the card shows a loading state, and the iframe is created lazily (on first visibility) so dashboards with many cards don't pay for hidden ones.
- Attachments in Send to… capped (10 MB, matching typical pod limits — confirm in Phase 0).

---

## 7. Deliverables

1. **BDOBB changes** (this repo): Symphony card (`builtins.ts` entry + `SymphonyRenderer.tsx`), Symphony settings tab, widget "Send to Symphony" action, share-target recipe for chat sharing, MCP wiring for the Rita tool, docs (`docs/symphony.md`: sandbox signup, stream-ID discovery, share-target template).
2. **`symphony-bridge`** (new repo): service + Dockerfile + compose example + README.
3. **`deploy/symphony-bridge/README.md`** in BDOBB: deployment runbook in the `deploy/spark/` style, plus Phase 0 pod/entitlement/bot setup.

---

## 8. Approaches considered

- **ECP direct iframe (chosen for v1):** minimal code, CSP-preserving, one conversation per card — which is the card model anyway. Limitation: no programmatic control, no unread badges.
- **ECP SDK explicit mode:** richer (conversation switching, notifications) but requires `script-src` loosening and more surface; deferred to F3-2 pending a demonstrated need.
- **Custom chat UI on raw REST/BDK:** full theming control, but reimplements presence, receipts, attachments, encryption via agent, cross-pod nuances — months of work, and a compliance surface Symphony already handles. Rejected; retained as the documented escape hatch if ECP entitlement proves unobtainable.
- **Bot credentials in the desktop app** (vs the bridge): no new service, but the RSA key lands on every desktop, rotation multiplies, and DLP/audit is per-machine. Rejected; bridge chosen (user-confirmed, Docker-on-tailnet).

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| ECP entitlement / partner ID not granted, or commercially unattractive (sandbox ECP availability unconfirmed) | Phase 1 blocked | Phase 0 gate P0-2/P0-5 before any build; sandbox still unblocks all of Phase 2 (bot/bridge) regardless; escape hatch = custom UI (§8) or alerts-only scope |
| Pod SSO/IdP refuses to run in the Tauri webview iframe | Chat card unusable | P0-4 verifies in-browser first; `ecpLoginPopup` fallback; worst case *Open externally* |
| Symphony endpoints are user-visible config with an open HTTP scope | Misdirected traffic if a card could override them | In-code origin pinning per §5.4, with tests, matching the live_grid/News rail precedent; bot egress confined to the bridge container |
| Rita tool budget pressure | Chat breaks (oversized tool set is rejected outright) | F2-8 budget ceiling; tool kept to one small descriptor |
| No pod today → sandbox behaves differently from an eventual production pod | Rework | Keep pod-specific values (URLs, partner ID, limits) in config, none hardcoded |

## 10. Open questions

1. Is **ECP/Embedded Mode (and a partner ID) available on the `develop2.symphony.com` sandbox pod**, or only on licensed pods? The docs confirm sandbox bot support but are silent on ECP; production licensing cost also unknown. — *owner: Art, Phase 0 (ask via the developer program).*
2. Does the eventual production pod belong to Art's firm or a partner firm, and who administers entitlements?
3. Does the tailnet have users beyond Art? If yes, the bridge needs request auth (token) before Phase 2 ships.
4. Attachment size and MessageML feature limits on the target pod (affects F2-6).
5. Compliance/retention expectations for bot-sent content beyond Symphony's own retention (affects bridge audit-log design).

## 11. Acceptance criteria

- **Phase 0 done:** sandbox pod reachable; ECP URL renders a conversation in a plain browser; bot account authenticates via BDK sample; licensing posture written into §10 answers.
- **Phase 1 done:** a Symphony card on a dashboard renders a live conversation; user logs in as themselves and sends/receives; refusal/error states render per F1-4; card persists across restart; all existing tests plus new renderer tests pass.
- **Phase 2 done:** bridge container deploys on the tailnet per the `deploy/symphony-bridge/` runbook; a Rita conversation reaches a Symphony room through a configured `http` share target with no BDOBB code change; the per-card action posts a Note and a chart PNG with attribution; Rita composes a message that the user approves and the room receives; the Symphony settings tab round-trips its draft through the tabbed dialog's single Save; every send appears in the bridge audit log.

---

*References: [Symphony REST API](https://rest-api.symphony.com/) · [ECP / Embedded Mode](https://docs.developers.symphony.com/embedded-modules/embedded-mode/get-started) · [Extension API overview](https://docs.developers.symphony.com/ext-apps/overview-of-extension-api) · [Symphony BDK](https://github.com/finos/symphony-bdk-java) · [Developer program](https://developers.symphony.com) · [Creating a service account](https://docs.developers.symphony.com/bots/getting-started/creating-a-bot-user.md) · [Getting started with BDK](https://docs.developers.symphony.com/bots/getting-started/bdk.md) · [ECP pricing tiers / Partner ID](https://docs.developers.symphony.com/embedded-modules/embedded-mode/pricing-tiers.md) · [Symphony contact](https://symphony.com/contact/)*
