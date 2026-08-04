# BDOBB Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `~/Developer/bdobb` — openbb-desk-qwen's full feature set with openbb-desk's defensive engineering folded in, verified against live backends.

**Architecture:** bdobb is a history-preserving clone of openbb-desk-qwen (the feature superset). Reconciliation walks the ~70 differing files bottom-up (types → libs → stores → hooks → components → shell → Rust/config), merging desk's hardening into qwen's implementations module by module. Every judgment call lands in `docs/MERGE-NOTES.md`.

**Tech Stack:** Tauri 2.11, React 19, TypeScript strict, Vite, vitest + @testing-library/react, zustand, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-02-bdobb-reconciliation-design.md`

## Global Constraints

- Working directory for every task after Task 0: `~/Developer/bdobb`.
- **Never modify** `~/Developer/openbb-desk-qwen` or `~/Developer/openbb-desk`.
- Parent shorthand: **QWEN** = `~/Developer/openbb-desk-qwen`, **DESK** = `~/Developer/openbb-desk`. bdobb starts as an exact copy of QWEN, so "the current file" = qwen's version.
- Conventional commits; every commit message body names the modules reconciled.
- `pnpm typecheck` and `pnpm test:run` must be green at every commit. (Exception: Task 0 records the baseline; if the baseline itself is red, fix or quarantine with a MERGE-NOTES entry before proceeding.)
- TypeScript strict mode; CSS variables, no Tailwind; React function components.

### Merge Protocol (implicitly part of every reconciliation task)

For each module in the task:

1. **Diff implementation and tests** against desk:
   `git diff --no-index src/path/file.ts ~/Developer/openbb-desk/src/path/file.ts`
   (desk's history is also available as the `desk` remote: `git show desk/main:src/path/file.ts`).
2. **Merge direction:** qwen's file is the base (it is already in the tree). Fold in desk's improvements. Prefer desk's pattern when it adds: boundary validation with a logged drop instead of a blind cast; resource cleanup (cancel/release/abort); truncation or partial-data handling; narrower types; clearer decomposition. Keep qwen's behavior when it carries a feature or bug fix desk lacks (built-ins, apps.json, param groups, touch/iPadOS paths, event kinds desk ignores). When both changed the same lines for different reasons, merge both intents; if they genuinely conflict, desk's defensive form wins unless it drops a qwen feature.
3. **Merge tests, don't pick one:** start from whichever parent's test file has more cases, graft the other parent's cases in (rename on collision). A parent's test case may only be dropped if it contradicts the merged behavior — record that in MERGE-NOTES. Desk test imports reference the same relative paths, so grafts usually port verbatim.
4. **Run the module's tests:** `pnpm test:run src/path/file.test.ts` → all pass.
5. **Log the decision:** append to `docs/MERGE-NOTES.md`: module, which parent won overall, what was cross-ported each way, any dropped test case and why.
6. **Task close:** `pnpm typecheck && pnpm test:run` fully green → commit (message given per task).

### Full inventory (measured 2026-08-02; changed-lines = added+removed)

Shared-and-identical (no action): `LeftRail.test.tsx`, `RitaPane.test.tsx`, `uuid.ts`, `widgets.test.ts`, `main.tsx`, `memfs.ts`, `mockServer.ts`, `vite-env.d.ts`.

qwen-only (keep, no action): builtins/appsJson/paramGroups/chatExport/chatShare/localTools/config/httpScope/safeUrl libs + tests, `usePointerKind`, `StatusTrail`, Note/Clock/Website renderers, dialogs tests, `agentEditsStore`, `chatStore`, `AgentEditBar`, integration suites, `generate-capabilities.mjs`, ios/linux scripts, fonts, CI workflows.

desk-only: listed in Tasks 8, 9, 10, 14, 16, 18, 19, 20, 21.

Differing shared files: every task below names its files with the measured changed-line count, largest deltas deepest in the plan.

---

### Task 0: Create bdobb from qwen; baseline

**Files:**
- Create: `~/Developer/bdobb` (clone)

**Interfaces:**
- Produces: the working repo every later task runs in; `desk` remote for diffs.

- [ ] **Step 1: Clone and wire remotes**

```bash
git clone ~/Developer/openbb-desk-qwen ~/Developer/bdobb
cd ~/Developer/bdobb
git remote set-url origin https://github.com/artcashin/bdobb.git
git remote add desk ~/Developer/openbb-desk
git fetch desk
```

Expected: `git remote -v` shows `origin` → github bdobb, `desk` → local openbb-desk; `git log --oneline -1` matches qwen's HEAD.

- [ ] **Step 2: Copy gitignored local config**

```bash
cp ~/Developer/openbb-desk-qwen/.env.local ~/Developer/bdobb/.env.local 2>/dev/null || echo "no .env.local in qwen — check DESK or ask user; live verification (Task 23) needs it"
```

- [ ] **Step 3: Install and record baseline**

```bash
pnpm install
pnpm typecheck
pnpm test:run
```

Expected: install clean; typecheck 0 errors; all tests pass. If anything is red, fix or quarantine it FIRST and record it in MERGE-NOTES (Task 1 creates the file — note it inline in the commit body if fixing here).

- [ ] **Step 4: Commit (only if anything changed, e.g. lockfile)**

```bash
git add -A && git diff --cached --quiet || git commit -m "chore: bdobb baseline from openbb-desk-qwen"
```

### Task 1: Seed MERGE-NOTES.md with the inventory

**Files:**
- Create: `docs/MERGE-NOTES.md`

**Interfaces:**
- Produces: the decision log every later task appends to.

- [ ] **Step 1: Write the header and inventory**

Create `docs/MERGE-NOTES.md` with: a two-paragraph preamble (what the two parents are, merge direction, link to the spec), then three sections copied from this plan's "Full inventory": *Identical*, *qwen-only*, *desk-only*, and a *Reconciliation log* table with columns `module | winner | cross-ported | notes` to be appended per task.

- [ ] **Step 2: Commit**

```bash
git add docs/MERGE-NOTES.md && git commit -m "docs: seed MERGE-NOTES with parent inventory"
```

### Task 2: Types — `lib/types.ts` (37), `lib/agent/types.ts` (276)

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/agent/types.ts`

**Interfaces:**
- Produces: the shared contracts every later task compiles against. All later merges use THESE names; when desk code is grafted later and references a desk-only type name, the graft is renamed to the merged name, never the other way.

- [ ] **Step 1: Diff both files against desk** (protocol step 1).
- [ ] **Step 2: Merge.** Known shape: qwen's types are a superset (builtins, apps.json, param groups). From desk take: narrower unions, doc comments, and any field desk models that qwen loosened to `unknown`/`Record`. Do NOT drop qwen-only types — `grep -rl` a type name across `src/` before deleting anything.
- [ ] **Step 3: Typecheck** — `pnpm typecheck` (type-only task; the suite is the test).
- [ ] **Step 4: Run full tests** — `pnpm test:run` → green.
- [ ] **Step 5: Log + commit**

```bash
git add -A && git commit -m "merge(types): reconcile shared and agent protocol types with desk"
```

### Task 3: `lib/logger.ts` (141) + `logger.test.ts` (161)

**Files:**
- Modify: `src/lib/logger.ts`, `src/lib/logger.test.ts`

**Interfaces:**
- Produces: the logging API later merges call. Desk code grafted in later tasks uses `logOnce(key, msg)` and `logError(msg)` — after this task those exact names must exist (qwen-named equivalents are aliased or the grafts renamed; pick one, log it).

- [ ] **Step 1–5:** Merge Protocol on the pair. Known shape: desk's logger has `logOnce` (dedup by key — load-bearing for its SSE/MCP hardening). Test: `pnpm test:run src/lib/logger.test.ts`. Commit: `merge(logger): fold desk's logOnce dedup into qwen logger`.

### Task 4: `lib/persistence.ts` (206) + `persistence.test.ts` (363)

**Files:**
- Modify: `src/lib/persistence.ts`, `src/lib/persistence.test.ts`

**Interfaces:**
- Consumes: logger (Task 3).
- Produces: `$APPDATA` JSON I/O used by all stores. Keep qwen's file names (`settings.json`, `backends.json`, `dashboards/`, `chat.json`) — the qwen README documents them and live data exists under `com.artcashin.bdobb`.

- [ ] **Step 1–5:** Merge Protocol. Watch for: desk's save-error surfacing (commit dc4664b "save-error surfacing") vs qwen's write path — keep both behaviors. Test: `pnpm test:run src/lib/persistence.test.ts`. Commit: `merge(persistence): desk save-error surfacing on qwen file layout`.

### Task 5: `lib/agent/sse.ts` (262) + `sse.test.ts` (436)

**Files:**
- Modify: `src/lib/agent/sse.ts`, `src/lib/agent/sse.test.ts`

**Interfaces:**
- Consumes: logger (`logOnce`, `logError`), agent types (Task 2).
- Produces: `sseEvents(stream)`, `parseSseEvent`/`parseBlock`, `toAgentEvent` for agentClient (Task 10).

Verified deltas (both directions — this is the template for what "merge both intents" means):

- FROM DESK: drop-and-log an unterminated trailing block instead of emitting it as a complete event; `reader.cancel()` in `finally` (early-`break` consumers leak the HTTP body otherwise); `logOnce` on non-JSON data payloads, malformed `copilotStatusUpdate`/`copilotFunctionCall`/`copilotMessageArtifact` payloads (validated at the boundary, dropped with a log — not blind-cast), and unknown event names.
- FROM QWEN (keep): `error` SSE event → `{kind:"error"}` (desk ignores it — an agent failure looked like a successful truncated turn); `done` event; status spread-then-normalise (preserves `tool_call`/`artifacts` on status updates); WHATWG single-space stripping (both have it; keep one).
- CONFLICT to resolve consciously: desk *drops* a trailing unterminated block; qwen *parses* it. Desk's reasoning (a truncated JSON body masquerading as a complete event) wins **unless** qwen's `error`/`done` tests depend on unterminated final frames — if so, drop only *unparseable* trailing blocks and log; record the choice.

- [ ] **Step 1–5:** Merge Protocol. Test: `pnpm test:run src/lib/agent/sse.test.ts`. Commit: `merge(sse): desk truncation-drop and boundary validation, qwen error/done events`.

### Task 6: `lib/dataClient.ts` (65) + test (58); `lib/widgets.ts` (17)

**Files:**
- Modify: `src/lib/dataClient.ts`, `src/lib/dataClient.test.ts`, `src/lib/widgets.ts`

**Interfaces:**
- Consumes: types (Task 2).
- Produces: URL building/fetch/dataKey extraction used by useWidgetData/WidgetCard (Task 14).

- [ ] **Step 1–5:** Merge Protocol on both modules (widgets.test.ts is identical — it must still pass unchanged; if the merged `widgets.ts` breaks it, the merge is wrong). Test: `pnpm test:run src/lib/dataClient.test.ts src/lib/widgets.test.ts`. Commit: `merge(data): reconcile dataClient and widgets normalization`.

### Task 7: `lib/params.ts` (110) + test (132); `lib/chartShapes.ts` (211) + test (219)

**Files:**
- Modify: `src/lib/params.ts`, `src/lib/params.test.ts`, `src/lib/chartShapes.ts`, `src/lib/chartShapes.test.ts`

**Interfaces:**
- Consumes: types (Task 2).
- Produces: param normalization consumed by ParamControls (Task 15); chart shape builders consumed by ChartRenderer (Task 13). qwen's `paramGroups.ts` depends on `params.ts` — its untouched tests must stay green.

- [ ] **Step 1–5:** Merge Protocol on both pairs. Test: `pnpm test:run src/lib/params.test.ts src/lib/chartShapes.test.ts src/lib/paramGroups.test.ts`. Commit: `merge(params,charts): reconcile param normalization and chart shapes`.

### Task 8: URL + capability-scope consolidation

**Files:**
- Modify: `src/lib/safeUrl.ts`, `src/lib/safeUrl.test.ts`, `src/lib/httpScope.ts`, `src/lib/httpScope.test.ts`
- Reference (desk-only counterparts): `DESK/src/lib/url.ts`, `DESK/src/lib/url.test.ts`, `DESK/src/lib/capabilityScope.ts`

**Interfaces:**
- Produces: ONE url-hygiene module (`safeUrl.ts`) and ONE scope module (`httpScope.ts`). Nothing in bdobb may import `lib/url` or `lib/capabilityScope` — desk grafts in later tasks that import those get rewritten to these.

- [ ] **Step 1: Read all four desk/qwen implementations side by side.** qwen's names survive (they are wired into the superset features: httpScope powers the Backends dialog scope warning and generate-capabilities tests).
- [ ] **Step 2: Graft desk-only capabilities into the survivors.** Any check desk's `url.ts`/`capabilityScope.ts` does that the qwen counterpart lacks moves across; migrate ALL of desk's `url.test.ts` cases into `safeUrl.test.ts` (rename describe blocks to match survivor API).
- [ ] **Step 3: Run** `pnpm test:run src/lib/safeUrl.test.ts src/lib/httpScope.test.ts` → green, desk cases included.
- [ ] **Step 4: Log + commit** — `merge(url,scope): consolidate desk url/capabilityScope into safeUrl/httpScope`.

### Task 9: `lib/agent/mcp.ts` (429) + `mcp.test.ts` (728) + desk MCP fixtures

**Files:**
- Modify: `src/lib/agent/mcp.ts`, `src/lib/agent/mcp.test.ts`
- Create (copy from DESK): `src/test/fixtures/mcp-fixtures.ts`, `src/test/fixtures/mcp/initialize.sse`, `src/test/fixtures/mcp/tools-list.sse`

**Interfaces:**
- Consumes: sse (Task 5), logger (Task 3), types (Task 2).
- Produces: MCP discovery + `assembleTools` with the qwen `TOOL_PAYLOAD_BUDGET_CHARS` ceiling (64,000 — README documents it; keep the constant and its name).

- [ ] **Step 1–5:** Merge Protocol. Keep qwen's byte-budgeted tool cap and `/mcp` (no trailing slash) redirect note; take desk's unreachable-server surfacing (commit fb47f16) and timeout handling (2661635) where qwen lacks them. Copy desk's fixtures verbatim; fix imports to merged paths. Test: `pnpm test:run src/lib/agent/mcp.test.ts`. Commit: `merge(mcp): desk unreachable-server surfacing on qwen tool budget`.

### Task 10: `lib/agent/agentClient.ts` (600) + test (900) + desk Rita fixtures

**Files:**
- Modify: `src/lib/agent/agentClient.ts`, `src/lib/agent/agentClient.test.ts`
- Create (copy from DESK): `src/test/fixtures/rita-stream.fixture.ts`, `src/test/fixtures/rita/agents.json`, `src/test/fixtures/rita/function-call.sse`, `src/test/fixtures/rita/roundtrip-answer.sse`, `src/test/fixtures/rita/simple-text.sse`

**Interfaces:**
- Consumes: sse, mcp, logger, types.
- Produces: the query round-trip API ChatPane/chatStore call (Task 17). qwen-only callers (`localTools.ts`, `chatStore.ts`, `roundTrip.test.ts`, `rita-fixture.test.ts`) must keep compiling — their tests are the regression net for qwen features.

- [ ] **Step 1–5:** Merge Protocol. Take desk's abort-threading into widget fetches and HTTP-error-body surfacing (03c132a); keep qwen's `get_widget_data` round trip and local tools integration. Test: `pnpm test:run src/lib/agent/` (whole directory — round-trip and fixture suites included). Commit: `merge(agent): desk abort/error surfacing on qwen round-trip client`.

### Task 11: Stores — `settingsStore` (75), `backendsStore` (57+74t), `registryStore` (99+74t), `dashboardStore` (356+378t)

**Files:**
- Modify: `src/stores/settingsStore.ts`, `src/stores/settingsStore.test.ts`, `src/stores/backendsStore.ts`, `src/stores/backendsStore.test.ts`, `src/stores/registryStore.ts`, `src/stores/registryStore.test.ts`, `src/stores/dashboardStore.ts`, `src/stores/dashboardStore.test.ts`

**Interfaces:**
- Consumes: persistence (Task 4), types (Task 2).
- Produces: zustand store APIs all components read. dashboardStore must keep qwen's `appName` sections and param groups; desk's independent-startup fix (dc4664b — one store failing to load must not block the others) comes in.

- [ ] **Step 1–5:** Merge Protocol per store, dashboardStore last (largest). Note desk has no settingsStore/backendsStore test files (qwen does — keep qwen's; desk-side behavior differences still get grafted as new cases). Test: `pnpm test:run src/stores/`. Commit: `merge(stores): desk independent startup and load hardening on qwen store features`.

### Task 12: `hooks/useHoverPanel.ts` (56) + test (81)

**Files:**
- Modify: `src/hooks/useHoverPanel.ts`, `src/hooks/useHoverPanel.test.ts`

**Interfaces:**
- Produces: the hover/touch panel hook. qwen's `useHoverPanel.touch.test.ts` and `usePointerKind.ts` are the iPadOS path — they must pass UNCHANGED. Any desk simplification that breaks touch is rejected.

- [ ] **Step 1–5:** Merge Protocol. Test: `pnpm test:run src/hooks/`. Commit: `merge(hooks): reconcile useHoverPanel, preserve touch paths`.

### Task 13: Renderers — Table (357+211t), Chart (111+117t), Markdown (56), Metric (60), Html (38), Iframe (123), RawJson (31), Unsupported (24) + desk `renderers.test.tsx`

**Files:**
- Modify: `src/components/renderers/TableRenderer.tsx`, `.../TableRenderer.test.tsx`, `.../ChartRenderer.tsx`, `.../ChartRenderer.test.tsx`, `.../MarkdownRenderer.tsx`, `.../MetricRenderer.tsx`, `.../HtmlRenderer.tsx`, `.../IframeRenderer.tsx`, `.../RawJsonView.tsx`, `.../UnsupportedRenderer.tsx`
- Create (copy from DESK, then fix imports): `src/components/renderers/renderers.test.tsx`

**Interfaces:**
- Consumes: chartShapes (Task 7), types.
- Produces: renderer components WidgetCard mounts (Task 14). qwen-only renderers (Note, Clock) and their tests stay untouched. qwen has per-renderer test files desk lacks (Markdown/Metric/Html/Iframe/RawJson/Unsupported .test.tsx) — those keep passing; desk's aggregate `renderers.test.tsx` is added on top.

- [ ] **Step 1–5:** Merge Protocol per renderer (desk's crash-proofing from 2af7428 and blank-card hardening from 35868b1 are the expected wins; qwen's raw-view toggle and website preflight stay). Test: `pnpm test:run src/components/renderers/`. Commit: `merge(renderers): desk crash-proofing on qwen renderer set`.

### Task 14: Widget card decomposition — the big architectural call

**Files:**
- Modify: `src/components/WidgetCard.tsx` (470), `src/components/WidgetCard.test.tsx` (722)
- Create (adopt from DESK if the call goes that way): `src/components/WidgetBody.tsx`, `src/components/WidgetBody.test.tsx`, `src/hooks/useWidgetData.ts`, `src/hooks/useWidgetData.test.ts`

**Interfaces:**
- Consumes: dataClient (Task 6), renderers (Task 13), stores (Task 11).
- Produces: the card component DashboardGrid mounts. External contract (props from DashboardGrid, param plumbing to ParamControls) must not change observably — Tasks 15/16 diff against whatever this task produces.

- [ ] **Step 1: Read all three desk files + qwen's WidgetCard fully.** The decision: desk splits card chrome (WidgetCard) from data fetch (useWidgetData) from body dispatch (WidgetBody); qwen's single 410-line WidgetCard additionally handles built-ins (Note/Clock/Website need NO data fetch), per-card params, view modes, agent edits.
- [ ] **Step 2: Decide and record.** Adopt the split ONLY if built-ins fit without contortion (e.g. useWidgetData takes a "static" branch or built-ins bypass it cleanly). Otherwise: keep qwen's structure, graft desk's fetch hardening (abort on unmount/param change, error surfacing) into it, and do NOT copy the desk files. Either way the MERGE-NOTES entry is mandatory and must say why.
- [ ] **Step 3: Merge tests** per protocol — desk's WidgetBody/useWidgetData cases only if the split was adopted; qwen's WidgetCard cases always.
- [ ] **Step 4: Run** `pnpm test:run src/components/WidgetCard.test.tsx src/hooks/ src/components/renderers/` → green.
- [ ] **Step 5: Log + commit** — `merge(widget-card): <adopted split|kept qwen structure> with desk fetch hardening`.

### Task 15: `WidgetLibrary` (185+341t), `ParamControls` (537+611t)

**Files:**
- Modify: `src/components/WidgetLibrary.tsx`, `src/components/WidgetLibrary.test.tsx`, `src/components/ParamControls.tsx`, `src/components/ParamControls.test.tsx`

**Interfaces:**
- Consumes: params (Task 7), stores (Task 11), card contract (Task 14).
- Produces: library panel and param panel. qwen features that must survive: Built-in section at top of library; *(shared)* marker on grouped params; touch open/dismiss.

- [ ] **Step 1–5:** Merge Protocol per component. Test: `pnpm test:run src/components/WidgetLibrary.test.tsx src/components/ParamControls.test.tsx`. Commit: `merge(library,params-ui): desk hardening on qwen grouped-param and builtin UI`.

### Task 16: `DashboardGrid` (59+179t) + desk persist test, `DashboardTabs` (222+149t)

**Files:**
- Modify: `src/components/DashboardGrid.tsx`, `src/components/DashboardGrid.test.tsx`, `src/components/DashboardTabs.tsx`, `src/components/DashboardTabs.test.tsx`
- Create (copy from DESK, fix imports): `src/components/DashboardGrid.persist.test.tsx`

**Interfaces:**
- Consumes: dashboardStore (Task 11), WidgetCard (Task 14).
- Produces: grid + tab strip. qwen features that must survive: 60-column layout, appName sections in the strip, Import/Export apps.json buttons.

- [ ] **Step 1–5:** Merge Protocol; desk's drag-persist coverage (fb47f16) lands via the persist test. Test: `pnpm test:run src/components/DashboardGrid.test.tsx src/components/DashboardGrid.persist.test.tsx src/components/DashboardTabs.test.tsx src/lib/appsJson.test.ts`. Commit: `merge(dashboard): desk drag-persist coverage on qwen sectioned tabs`.

### Task 17: Chat — `ChatPane` (822+661t), `ChatMessages` (151+121t), `ArtifactView` (183+120t)

**Files:**
- Modify: `src/components/chat/ChatPane.tsx`, `src/components/chat/ChatPane.test.tsx`, `src/components/chat/ChatMessages.tsx`, `src/components/chat/ChatMessages.test.tsx`, `src/components/chat/ArtifactView.tsx`, `src/components/chat/ArtifactView.test.tsx`

**Interfaces:**
- Consumes: agentClient (Task 10), chatStore (qwen-only, untouched), sse events (Task 5).
- Produces: the chat pane RitaPane hosts. qwen features that must survive: StatusTrail component wiring, chat export/share, suggestions, offline states, agent edit bar. Desk wins expected: inline status artifacts (2b8a646), privacy-leak fix (same commit), ArtifactView sandbox WITHOUT `allow-scripts` (desk README documents the rationale — LLM HTML must never execute).

- [ ] **Step 1–5:** Merge Protocol per component, ChatPane last. Test: `pnpm test:run src/components/chat/`. Commit: `merge(chat): desk artifact sandbox and status rendering on qwen chat features`.

### Task 18: Dialogs — `SettingsDialog` (569), `BackendsDialog` (474) + desk `dialogs.test.tsx`

**Files:**
- Modify: `src/components/dialogs/SettingsDialog.tsx`, `src/components/dialogs/SettingsDialog.test.tsx`, `src/components/dialogs/BackendsDialog.tsx`, `src/components/dialogs/BackendsDialog.test.tsx`
- Create (copy from DESK, fix imports): merge desk's `dialogs.test.tsx` cases INTO the two qwen per-dialog test files, then do NOT keep a third file (avoid three overlapping suites) — note in MERGE-NOTES.

**Interfaces:**
- Consumes: stores (Task 11), httpScope (Task 8), logger (Task 3).
- Produces: settings + backends dialogs. Desk wins expected: blank-render and focus-theft fixes (358e463), connection status, log viewer, out-of-scope backend warning. qwen wins: scope warning reads generated capabilities via httpScope, clock/theme settings.

- [ ] **Step 1–5:** Merge Protocol. Test: `pnpm test:run src/components/dialogs/`. Commit: `merge(dialogs): desk focus and status fixes on qwen scoped-capability dialogs`.

### Task 19: Shell — `App` (110+179t), `AppShell` (139+113t) + desk errorBoundaries test, `ErrorBoundary` (70+109t), `Modal` (169), `RitaPane` (19), `LeftRail` (2)

**Files:**
- Modify: `src/App.tsx`, `src/App.test.tsx`, `src/components/AppShell.tsx`, `src/components/AppShell.test.tsx`, `src/components/ErrorBoundary.tsx`, `src/components/ErrorBoundary.test.tsx`, `src/components/Modal.tsx`, `src/components/Modal.test.tsx`, `src/components/RitaPane.tsx`, `src/components/LeftRail.tsx`
- Create (copy from DESK, fix imports): `src/components/AppShell.errorBoundaries.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: the composed app. Desk wins expected: top-level error boundaries around independent regions (dc4664b). qwen wins: touch/pointer wiring, Cmd/Ctrl+Shift+A pin shortcut parity check (both may have it — verify).

- [ ] **Step 1–5:** Merge Protocol, `App.tsx` last. Test: `pnpm test:run src/App.test.tsx src/components/AppShell.test.tsx src/components/AppShell.errorBoundaries.test.tsx src/components/ErrorBoundary.test.tsx src/components/Modal.test.tsx`. Commit: `merge(shell): desk region error boundaries on qwen shell`.

### Task 20: Rust + config + test infra — `src-tauri/src/lib.rs` (95), `tauri.conf.json`, `src/test/setup.ts` (49), desk `smoke.test.ts`

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src/test/setup.ts`
- Create (copy from DESK, fix imports): `src/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: the Tauri shell config. qwen wins presumed: website-preflight Rust command, iOS trust-gate handling, generated-capability CSP posture (qwen README documents why `connect-src` is broad and `style-src` allows inline — desk's tighter CSP predates the streaming/Plotly findings; do NOT regress to desk's CSP without re-running qwen's documented Plotly verification). Desk `lib.rs` deltas: inspect for commands qwen lacks.

- [ ] **Step 1: Diff `src-tauri/src/lib.rs` and `tauri.conf.json`** (`git diff --no-index src-tauri/tauri.conf.json ~/Developer/openbb-desk/src-tauri/tauri.conf.json`).
- [ ] **Step 2: Merge per protocol;** bundle identifier stays `com.artcashin.bdobb`; capability template stays generated (never commit a `default.json` with real hosts).
- [ ] **Step 3: Port smoke test + setup.ts deltas;** run `pnpm test:run` (whole suite — setup.ts affects everything).
- [ ] **Step 4: Verify the Rust side compiles:** `cargo check --manifest-path src-tauri/Cargo.toml`. Expected: success.
- [ ] **Step 5: Log + commit** — `merge(tauri): reconcile shell commands, keep qwen CSP posture and generated capabilities`.

### Task 21: Desk extras + dependency reconciliation

**Files:**
- Create (copy from DESK): `deploy/spark/README.md`, `deploy/spark/rita.env.example`, `scripts/make-icon.mjs`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produces: final dependency set. Measured deltas: qwen has `@tauri-apps/plugin-dialog`, react 19.2.8, vite 8.2.0, vitest 3.2.7, `@vitejs/plugin-react-swc`; desk has react 19.1.0, vite 7, vitest 4.1.10, `@vitest/coverage-v8`.

- [ ] **Step 1: Copy the three desk-only files;** adjust `deploy/spark/README.md` references from "OpenBB Desk" to "BDOBB" where they name the app (deployment facts stay).
- [ ] **Step 2: Dependency decision:** keep qwen's toolchain versions (they build the superset today — an upgrade is out of scope). ONE adoption from desk: add `@vitest/coverage-v8` pinned to qwen's vitest major (`^3.2.7`) only if `vitest run --coverage` is wanted; otherwise skip and log. Do not downgrade react/vite.
- [ ] **Step 3: Run** `pnpm install && pnpm typecheck && pnpm test:run` → green.
- [ ] **Step 4: Log + commit** — `merge(extras): adopt desk deploy runbook and icon pipeline, keep qwen toolchain`.

### Task 22: Documentation reconciliation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/MERGE-NOTES.md`

**Interfaces:**
- Consumes: every MERGE-NOTES entry written so far.

- [ ] **Step 1: README:** qwen's README is the base (it documents the superset). Fold in desk-README facts that survived the merge and are not already there: the two-layer egress enforcement explanation (capability scope vs CSP), the tool-discovery-mode rationale for the `:8443` MCP server, Gatekeeper/SmartScreen first-launch notes if missing. Remove nothing that documents a qwen feature.
- [ ] **Step 2: CLAUDE.md:** diff qwen vs desk CLAUDE.md; merged repo keeps qwen's, plus any desk workflow note still true post-merge. Drop the "local implementation dispatch" section only if the user's global config already provides it — otherwise keep.
- [ ] **Step 3: MERGE-NOTES:** read end-to-end; every task above must have an entry; fix gaps NOW (grep the git log for `merge(` commits and cross-check).
- [ ] **Step 4: Commit** — `docs: reconcile README/CLAUDE.md, finalize MERGE-NOTES`.

### Task 23: Verification gates (spec Phase 4 — all must pass, in order)

**Files:** none created; fixes discovered here go through the normal protocol (fix, test, MERGE-NOTES if a merge call changes, commit).

- [ ] **Step 1:** `pnpm test:run` → full suite green.
- [ ] **Step 2:** `pnpm typecheck` → 0 errors.
- [ ] **Step 3:** conformance: in one terminal `pnpm reference-backend`; then `pnpm test:reference` → green. (Backend needs no keys; see `docs/test-environment.md`.)
- [ ] **Step 4:** `pnpm tauri build` → macOS bundle produced under `src-tauri/target/release/bundle/`. Record the artifact path.
- [ ] **Step 5:** `pnpm ios:check` → passes its prerequisite checks.
- [ ] **Step 6:** live suite: `OPENBB_LIVE=1 pnpm test:run src/test/integration/real-endpoints.test.ts` with `.env.local` present → green. If an endpoint is down, STOP and report which one; do not skip.
- [ ] **Step 7:** launch the built app (`open "src-tauri/target/release/bundle/macos/"*.app`); verify by eye and report: dashboard widgets load from the NAS backend, Rita chat streams a reply, MCP tools assemble (Settings → log viewer shows tool assembly), built-in Note/Clock/Website cards work.
- [ ] **Step 8:** final commit if fixes landed; summarize gate results in the session report. Do NOT push to origin unless the user asks.
