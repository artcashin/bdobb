# Symphony Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Symphony Messaging into BDOBB via an embedded chat card (User identity) and an outbound bot bridge (Bot identity).

**Architecture:** 
- **User Chat:** Embedded Mode (ECP) direct iframe rendering Symphony's client inside a BDOBB widget.
- **Bot Alerts:** A standalone `symphony-bridge` Docker container on the tailnet handling RSA auth and REST API calls.
- **Configuration:** Origin-pinned URLs for the Pod and Bridge to prevent redirection.

**Tech Stack:** Tauri 2, React 19, TypeScript, Docker, Symphony BDK.

## Global Constraints

- **ECP Sandbox:** `allow-scripts`, `allow-same-origin`, `allow-forms`, `allow-popups` (required for SSO).
- **Security:** Bot RSA private keys must remain in the bridge container; never on the desktop.
- **Egress:** All bot traffic must egress from the bridge container.
- **Rita Budget:** Tool descriptors must stay under the 64k char `TOOL_PAYLOAD_BUDGET_CHARS` ceiling.

---

## File Structure

### New Files
- `src/components/renderers/SymphonyRenderer.tsx`: Renders the ECP iframe and handles preflight/error states.
- `src/components/dialogs/settings/SymphonyTab.tsx`: Settings UI for Pod URL, Bridge URL, and Partner ID.
- `deploy/symphony-bridge/README.md`: Deployment runbook for the bridge container.
- `docs/symphony.md`: User guide for sandbox signup and stream-ID discovery.

### Modified Files
- `src/lib/builtins.ts`: Register `builtin:symphony` and its parameters.
- `src/components/WidgetCard.tsx`: Add dispatch logic for the Symphony renderer.
- `src/components/dialogs/SettingsDialog.tsx`: Integrate the new `SymphonyTab`.
- `src/lib/chatShare.ts`: Add logic for widget-content sharing (Note/Table/Chart) to Symphony.

---

## Status

Not started. A previous attempt was rolled back on 2026-08-07 (see below); the
branch is back at `e0ccb48` plus docs, typecheck clean, 839 tests passing.

### Resolved decisions (2026-08-07) — these govern where the task text disagrees

1. **`partnerId` is deferred to Task 5.** Tasks 2–3 render with `partnerId: ""`.
   `SymphonyRendererProps.params` still declares the full shape
   `{pod, id, partnerId, mode, theme}` from Task 2 onward so the contract never
   drifts — only the *value* arrives late. **Task 5 owns wiring the real value
   into the `WidgetCard` call site** and updating the Task 2 URL tests. If Task 5
   adds settings without touching `WidgetCard`, that is the exact defect that
   sank the first attempt.
2. **`mode` and `theme` are separate URL params.** The iframe URL carries
   `&mode={mode}&theme={theme}`, not a hardcoded `mode=dark`. Settle this in
   Task 2; Tasks 3–5 consume it unchanged.
3. **The bridge URL comes from `settings.symphonyBridgeUrl` only.** There is no
   `VITE_SYMPHONY_BRIDGE_URL`. Task 6 reads settings, consistent with Pod URL
   and Partner ID.

### Lessons from the rolled-back attempt

Two agents ran this plan concurrently against one working tree and produced
duplicated and half-finished work. It was reset rather than salvaged. Facts
worth keeping — each was verified against the code, not assumed:

- **Task 7 targets `src/components/chat/ChatPane.tsx` + `src/stores/chatStore.ts`,
  not `RitaPane.tsx`.** `RitaPane` is only the hover/pin chrome; `ChatPane` is
  the chat it wraps. The task body below has been corrected accordingly.
- **There is no `lint` script in this repo.** Verification is
  `pnpm run typecheck && pnpm run test:run`.
- **Fix the `SymphonyRenderer` params contract once, in Task 2, and don't drift
  from it.** Last time the props type required `{pod, id, partnerId, mode, theme}`
  while the component destructured four of them and `WidgetCard` passed a `pid`
  key fed from the *mode* param — a red typecheck and a wrong iframe URL.
  `partnerId` comes from `settings.symphonyPartnerId`, not from a widget param;
  `builtins.ts` defines only `podUrl`, `streamId`, `mode`, `theme`.
- **`shareWidgetToSymphony` belongs in `chatShare.ts` only** (Task 6). Last time
  it was written into two modules at once. If helpers are split into a separate
  file, that file holds helpers and nothing else.
- **Adding `useSettingsStore` to `WidgetCard.tsx` pulls `settingsStore` into
  `DashboardGrid`'s import graph**, breaking `DashboardGrid.persist.test.tsx` and
  `DashboardGrid.realmount.test.tsx`: their `vi.mock("../lib/persistence")` must
  then also export `DEFAULT_SETTINGS`, which `settingsStore.ts` reads at module
  load. Expect this the moment Task 6 touches `WidgetCard`.

## Implementation Tasks

### Task 1: Register Symphony Built-in
**Files:**
- Modify: `src/lib/builtins.ts`

**Interfaces:**
- Produces: `BUILTIN_SYMPHONY_ID = "builtin:symphony"`

- [ ] **Step 1: Add `BUILTIN_SYMPHONY_ID` and define parameters**
  Add `BUILTIN_SYMPHONY_ID` and a definition including `podUrl` (default from config), `streamId` (string), `mode` (default 'focus'), and `theme` (default 'dark').
- [ ] **Step 2: Commit**
  `git add src/lib/builtins.ts && git commit -m "feat: register symphony built-in widget"`

### Task 2: Create Symphony Renderer
**Files:**
- Create: `src/components/renderers/SymphonyRenderer.tsx`

**Interfaces:**
- Consumes: `WidgetParams` from `src/lib/types.ts`

- [ ] **Step 1: Implement Iframe render logic**
  Render `https://{pod}/embed/index.html?streamId={id}&partnerId={partnerId}&mode={mode}&theme={theme}&condensed=true`.
  Declare `params` as the full shape `{pod, id, partnerId, mode, theme}` and
  destructure all five — no drift between the type and the component.
  `partnerId` is `""` until Task 5 supplies it (see Resolved decisions).
- [ ] **Step 2: Apply sandbox policy**
  Set `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.
- [ ] **Step 3: Implement lazy loading**
  Ensure the iframe is only created when the card becomes visible.
- [ ] **Step 4: Commit**
  `git add src/components/renderers/SymphonyRenderer.tsx && git commit -m "feat: add SymphonyRenderer component"`

### Task 3: Integrate Renderer into WidgetCard
**Files:**
- Modify: `src/components/WidgetCard.tsx`

**Interfaces:**
- Consumes: `SymphonyRenderer`

- [ ] **Step 1: Update renderer dispatch**
  Add `case BUILTIN_SYMPHONY_ID: return <SymphonyRenderer ... />` to the renderer mapping.
- [ ] **Step 2: Commit**
  `git add src/components/WidgetCard.tsx && git commit -m "feat: dispatch SymphonyRenderer in WidgetCard"`

### Task 4: Implement Header Preflight
**Files:**
- Modify: `src/components/renderers/SymphonyRenderer.tsx`
- Modify: `src-tauri/src/lib.rs` (or relevant Rust command file)

**Interfaces:**
- Produces: `invoke("check_frame_options", { url })` Rust command.

- [ ] **Step 1: Write Rust command to check `X-Frame-Options`**
  Implement a command that performs a HEAD request and checks for `X-Frame-Options: DENY` or `frame-ancestors` restrictions.
- [ ] **Step 2: Integrate preflight into `SymphonyRenderer`**
  Call the command before rendering the iframe. If it fails, show an error state with an "Open externally" button.
- [ ] **Step 3: Commit**
  `git add src-tauri/src/lib.rs src/components/renderers/SymphonyRenderer.tsx && git commit -m "feat: add iframe preflight check for Symphony pod"`

### Task 5: Symphony Settings Tab
**Files:**
- Create: `src/components/dialogs/settings/SymphonyTab.tsx`
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Modify: `src/lib/types.ts`, `src/lib/persistence.ts` (add the three settings fields)
- Modify: `src/components/WidgetCard.tsx` (wire the real `partnerId` into the renderer)
- Modify: `src/components/renderers/SymphonyRenderer.test.tsx` (URL now carries a real partnerId)

**Interfaces:**
- Consumes: `SymphonySettings` state in `SettingsDialog`.

- [ ] **Step 1: Implement `SymphonyTab` UI**
  Fields for Pod URL, Partner ID, and Bridge URL.
- [ ] **Step 2: Integrate tab into `SettingsDialog`**
  Add the tab to the navigation and the content area.
- [ ] **Step 2b: Wire `partnerId` into the renderer call site**
  This is the deferred half of Task 2. In `WidgetCard.tsx` pass
  `partnerId: settings.symphonyPartnerId` (and let `pod` fall back to
  `settings.symphonyPodUrl` when the widget param is empty). Update the Task 2
  URL assertions to expect the real value. `pnpm run typecheck` must be clean
  before committing — a mismatch here is the regression that killed attempt 1.
  Note: importing `useSettingsStore` into `WidgetCard` will break
  `DashboardGrid.persist.test.tsx` and `DashboardGrid.realmount.test.tsx` until
  their `vi.mock("../lib/persistence")` also exports `DEFAULT_SETTINGS`.
- [ ] **Step 3: Commit**
  `git add src/components/dialogs/settings/SymphonyTab.tsx src/components/dialogs/SettingsDialog.tsx && git commit -m "feat: add Symphony settings tab"`

### Task 6: Widget-Content Sharing Actions
**Files:**
- Modify: `src/lib/chatShare.ts`
- Modify: `src/components/WidgetCard.tsx` (for action button)

**Interfaces:**
- Produces: `POST` request to `${settings.symphonyBridgeUrl}/messages`.
  There is no `VITE_SYMPHONY_BRIDGE_URL` — read the bridge URL from settings.

- [ ] **Step 1: Implement "Send to Symphony" logic for Note**
  Map markdown to MessageML and send via bridge.
- [ ] **Step 2: Implement "Send to Symphony" logic for Table/Chart**
  Generate CSV/PNG and send as attachment via bridge.
- [ ] **Step 3: Add action button to `WidgetCard`**
  Add a "Send to Symphony" button to the card header for supported types.
- [ ] **Step 4: Commit**
  `git add src/lib/chatShare.ts src/components/WidgetCard.tsx && git commit -m "feat: add widget-content sharing to Symphony"`

### Task 7: Rita Tool Confirmation UI
**Files:**
- Modify: `src/components/chat/ChatPane.tsx`
- Modify: `src/stores/chatStore.ts`

**Interfaces:**
- Consumes: Rita's `post_to_symphony` tool call.

- [ ] **Step 1: Implement confirmation gate**
  Intercept `post_to_symphony` tool calls and display a "Review and Send" confirmation dialog to the user.
- [ ] **Step 2: Commit**
  `git add src/components/chat/ChatPane.tsx src/stores/chatStore.ts && git commit -m "feat: add human confirmation for Rita's Symphony messages"`

### Task 8: Documentation & Runbooks
**Files:**
- Create: `deploy/symphony-bridge/README.md`
- Create: `docs/symphony.md`

- [ ] **Step 1: Write `deploy/symphony-bridge/README.md`**
  Detail Docker build, env vars (`SYMPHONY_BOT_KEY_PATH` etc.), and smoke tests.
- [ ] **Step 2: Write `docs/symphony.md`**
  Guide on sandbox registration and stream-ID discovery.
- [ ] **Step 3: Commit**
  `git add deploy/symphony-bridge/README.md docs/symphony.md && git commit -m "docs: add Symphony bridge runbook and user guide"`

### Task 9: Final Verification
- [ ] **Step 1: Verify Chat Card**
  Load dashboard -> Add Symphony card -> Log in -> Send/Receive message.
- [ ] **Step 2: Verify Bridge Sharing**
  Send Note/Chart from widget -> Check Symphony room.
- [ ] **Step 3: Verify Rita Tool**
  Ask Rita to post to Symphony -> Confirm in UI -> Check Symphony room.
- [ ] **Step 4: Run typecheck and the test suite**
  `pnpm run typecheck && pnpm run test:run` — there is no `lint` script in this repo.
