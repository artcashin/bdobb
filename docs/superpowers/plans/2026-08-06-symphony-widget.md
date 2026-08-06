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

## Status (audited 2026-08-06)

Tasks 1–5 and 7 are committed on `feat/symphony-integration`. Task 6 is in flight
(uncommitted). Boxes below reflect verified state, not claimed state.

**Blocker — `pnpm typecheck` is red at HEAD.** Commit `b063bed` dropped `theme`
from the `SymphonyRenderer` destructure but left it required in
`SymphonyRendererProps.params`, and `WidgetCard.tsx` still passes a `pid` key
that no longer exists on that type (it also feeds it the *mode* param, not a
partner ID). See Task 3b — fix that before Task 9.

**Plan deviations that are correct, do not "fix":**
- Task 4's Rust command is `check_frameable`, not `check_frame_options`.
- Task 7 landed in `src/components/chat/ChatPane.tsx` + `src/stores/chatStore.ts`.
  `RitaPane.tsx` is only the hover/pin chrome; `ChatPane` is the chat it wraps.
- `src/lib/symphonyShare.ts` exists as a helper module (`markdownToMessageML`,
  `tableToCSV`, `chartToPNG`). `chatShare.ts` imports those and owns
  `shareWidgetToSymphony`, per Task 6. Do not reintroduce a second copy there.

## Implementation Tasks

### Task 1: Register Symphony Built-in
**Files:**
- Modify: `src/lib/builtins.ts`

**Interfaces:**
- Produces: `BUILTIN_SYMPHONY_ID = "builtin:symphony"`

- [x] **Step 1: Add `BUILTIN_SYMPHONY_ID` and define parameters**
  Add `BUILTIN_SYMPHONY_ID` and a definition including `podUrl` (default from config), `streamId` (string), `mode` (default 'focus'), and `theme` (default 'dark').
- [x] **Step 2: Commit**
  `git add src/lib/builtins.ts && git commit -m "feat: register symphony built-in widget"`

### Task 2: Create Symphony Renderer
**Files:**
- Create: `src/components/renderers/SymphonyRenderer.tsx`

**Interfaces:**
- Consumes: `WidgetParams` from `src/lib/types.ts`

- [x] **Step 1: Implement Iframe render logic**
  Render `https://{pod}/embed/index.html?streamId={id}&partnerId={pid}&mode=dark&condensed=true`.
- [x] **Step 2: Apply sandbox policy**
  Set `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.
- [x] **Step 3: Implement lazy loading**
  Ensure the iframe is only created when the card becomes visible.
- [x] **Step 4: Commit**
  `git add src/components/renderers/SymphonyRenderer.tsx && git commit -m "feat: add SymphonyRenderer component"`

### Task 3: Integrate Renderer into WidgetCard
**Files:**
- Modify: `src/components/WidgetCard.tsx`

**Interfaces:**
- Consumes: `SymphonyRenderer`

- [x] **Step 1: Update renderer dispatch**
  Add `case BUILTIN_SYMPHONY_ID: return <SymphonyRenderer ... />` to the renderer mapping.
- [x] **Step 2: Commit**
  `git add src/components/WidgetCard.tsx && git commit -m "feat: dispatch SymphonyRenderer in WidgetCard"`

### Task 3b: Repair the Symphony renderer param contract (regression)
**Files:**
- Modify: `src/components/WidgetCard.tsx`
- Modify: `src/components/renderers/SymphonyRenderer.tsx`
- Modify: `src/components/renderers/SymphonyRenderer.test.tsx`

Introduced by `b063bed`; blocks Task 9 Step 4. `params` requires
`{pod, id, partnerId, mode, theme}`, but the renderer destructures only four of
them, the test builds `{pod, id, pid}`, and `WidgetCard` passes
`pid: fetchParams[SYMPHONY_MODE_PARAM]` — the mode string in a partner-ID slot.

- [ ] **Step 1: Settle the contract**
  Either use `theme` in the iframe URL or drop it from the params type — pick one.
- [ ] **Step 2: Fix the `WidgetCard` call site**
  Pass `partnerId: settings.symphonyPartnerId` and `theme` from
  `SYMPHONY_THEME_PARAM`; `pod` should fall back to `settings.symphonyPodUrl`.
- [ ] **Step 3: Update `SymphonyRenderer.test.tsx` to the real param shape**
- [ ] **Step 4: Confirm `pnpm typecheck` is clean, then commit**

### Task 4: Implement Header Preflight
**Files:**
- Modify: `src/components/renderers/SymphonyRenderer.tsx`
- Modify: `src-tauri/src/lib.rs` (or relevant Rust command file)

**Interfaces:**
- Produces: `invoke("check_frame_options", { url })` Rust command.

- [x] **Step 1: Write Rust command to check `X-Frame-Options`**
  Implement a command that performs a HEAD request and checks for `X-Frame-Options: DENY` or `frame-ancestors` restrictions.
- [x] **Step 2: Integrate preflight into `SymphonyRenderer`**
  Call the command before rendering the iframe. If it fails, show an error state with an "Open externally" button.
- [x] **Step 3: Commit**
  `git add src-tauri/src/lib.rs src/components/renderers/SymphonyRenderer.tsx && git commit -m "feat: add iframe preflight check for Symphony pod"`

### Task 5: Symphony Settings Tab
**Files:**
- Create: `src/components/dialogs/settings/SymphonyTab.tsx`
- Modify: `src/components/dialogs/SettingsDialog.tsx`

**Interfaces:**
- Consumes: `SymphonySettings` state in `SettingsDialog`.

- [x] **Step 1: Implement `SymphonyTab` UI**
  Fields for Pod URL, Partner ID, and Bridge URL.
- [x] **Step 2: Integrate tab into `SettingsDialog`**
  Add the tab to the navigation and the content area.
- [x] **Step 3: Commit**
  `git add src/components/dialogs/settings/SymphonyTab.tsx src/components/dialogs/SettingsDialog.tsx && git commit -m "feat: add Symphony settings tab"`

### Task 6: Widget-Content Sharing Actions
**Files:**
- Modify: `src/lib/chatShare.ts`
- Modify: `src/components/WidgetCard.tsx` (for action button)

**Interfaces:**
- Produces: `POST` request to `VITE_SYMPHONY_BRIDGE_URL/messages`.

> **Resume here.** Steps 1–2 are done but uncommitted: `shareWidgetToSymphony`
> in `chatShare.ts`, covered by 7 tests in `chatShare.test.ts`. Step 3's button
> and its 4 tests are also written and passing. Two loose ends before Step 4:
>
> 1. `WidgetCard.test.tsx` imports `useSettingsStore` but no longer uses it
>    (leftover from an abandoned `vi.mocked()` approach) — typecheck error.
> 2. Adding `useSettingsStore` to `WidgetCard.tsx` pulls `settingsStore` into
>    `DashboardGrid`'s import graph, so `DashboardGrid.persist.test.tsx` and
>    `DashboardGrid.realmount.test.tsx` now fail to collect: their
>    `vi.mock("../lib/persistence")` doesn't export `DEFAULT_SETTINGS`, which
>    `settingsStore.ts` imports at module load. Add it to both mocks.

- [x] **Step 1: Implement "Send to Symphony" logic for Note**
  Map markdown to MessageML and send via bridge.
- [x] **Step 2: Implement "Send to Symphony" logic for Table/Chart**
  Generate CSV/PNG and send as attachment via bridge.
- [ ] **Step 3: Add action button to `WidgetCard`**
  Add a "Send to Symphony" button to the card header for supported types.
- [ ] **Step 4: Commit**
  `git add src/lib/chatShare.ts src/components/WidgetCard.tsx && git commit -m "feat: add widget-content sharing to Symphony"`

### Task 7: Rita Tool Confirmation UI
**Files:**
- Modify: `src/components/RitaPane.tsx`

**Interfaces:**
- Consumes: Rita's `post_to_symphony` tool call.

- [x] **Step 1: Implement confirmation gate**
  Intercept `post_to_symphony` tool calls and display a "Review and Send" confirmation dialog to the user.
- [x] **Step 2: Commit**
  `git add src/components/RitaPane.tsx && git commit -m "feat: add human confirmation for Rita's Symphony messages"`

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
