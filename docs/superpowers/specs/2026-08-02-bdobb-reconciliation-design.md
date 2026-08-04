# BDOBB Reconciliation — Design

**Date:** 2026-08-02
**Status:** Approved

## Problem

Two independent processes implemented the same application from the same
spec (`docs/superpowers/specs/2026-07-30-openbb-desk-design.md`):

- **openbb-desk-qwen** (~17k src lines, 56 test files) — feature superset:
  built-in widgets (Note, Clock, Website), apps.json Workspace import/export,
  parameter groups, chat export/share, local tools, iPadOS + touch support,
  env-driven capability generation, CI + multi-platform release workflows,
  reference-backend conformance suite. Already renamed BDOBB; its git remote
  is already `github.com/artcashin/bdobb`.
- **openbb-desk** (~13k src lines, 35 test files) — fewer features, but more
  defensively engineered in sampled modules: boundary validation with logged
  drops instead of blind casts, stream cancellation on early exit,
  truncated-payload handling, cleaner component decomposition
  (WidgetCard → WidgetCard + WidgetBody + useWidgetData).

The git histories are **unrelated** (different roots). Same-named files are
substantially different implementations, so no textual git merge is possible.
Reconciliation is module-by-module, and each side has fixes the other lacks
(e.g. desk's `sse.ts` drops truncated trailing blocks and cancels the reader,
but silently ignores the `error` SSE event that qwen handles).

## Goal

A new repository at `~/Developer/bdobb` containing qwen's full feature set
with desk's quality improvements folded in, fully verified — including
against the live tailnet backends.

## Decisions (settled with the user)

1. **Base:** openbb-desk-qwen. Desk's quality is ported onto it, not the
   reverse.
2. **History:** `~/Developer/bdobb` is a clone of openbb-desk-qwen with its
   full history and existing `bdobb` GitHub origin. openbb-desk is added as a
   read-only `desk` remote (history fetched) for permanent reference. Neither
   source repo is modified.
3. **Judgment calls:** made autonomously. Default: prefer desk's defensive
   patterns unless qwen's version carries a fix or feature desk lacks — then
   merge both. Every call is logged in `docs/MERGE-NOTES.md`.
4. **Success bar:** reconciled test suite + typecheck + reference-backend
   conformance suite + macOS `tauri build` + `ios:check` + `OPENBB_LIVE=1`
   suite against the real NAS/Rita/MCP endpoints + launching the built app to
   visually confirm dashboard, chat, and MCP against live data.

## Approach

### Phase 0 — Setup

- `git clone ~/Developer/openbb-desk-qwen ~/Developer/bdobb`, re-point
  `origin` to `https://github.com/artcashin/bdobb.git`.
- `git remote add desk ~/Developer/openbb-desk && git fetch desk`.
- `pnpm install`; confirm the baseline passes: `pnpm test:run`,
  `pnpm typecheck`.
- Copy `.env.local` from openbb-desk-qwen if not carried by the clone
  (it is gitignored).

### Phase 1 — Inventory

Produce a three-way classification, committed as the seed of
`docs/MERGE-NOTES.md`:

- **qwen-only files** — keep as-is (no action).
- **desk-only files** — evaluate for adoption (see Phase 3 list).
- **shared-name files that differ** (~40) — the per-module review queue,
  ordered for Phase 2.

### Phase 2 — Module reconciliation (foundation upward)

Modules from different parents must agree on shared contracts, so the walk
is bottom-up:

1. `lib/types.ts`, `lib/agent/types.ts`
2. Leaf libs: `logger`, `persistence`, `sse`, `dataClient`, `widgets`,
   `params`, `chartShapes`, `agent/mcp`, `agent/agentClient`
3. Stores: `settingsStore`, `backendsStore`, `registryStore`,
   `dashboardStore`
4. Hooks: `useHoverPanel` (+ qwen's `usePointerKind` stays)
5. Components: shell, rail, tabs, grid, card, library, params, modal,
   dialogs, chat, renderers
6. Rust side: `src-tauri/src/lib.rs` / `main.rs`
7. Config: `tauri.conf.json`, `package.json` scripts, CI workflows

Per module: diff both versions; adopt desk's defensive patterns (boundary
validation with logged drops, resource cleanup, narrower casts) while
preserving every qwen feature and fix. Port desk's test file alongside; the
merged module must pass **both** repos' tests for that module. Where tests
encode contradictory expectations, the MERGE-NOTES entry says which
expectation won and why.

### Phase 3 — Desk-only material

Evaluated for adoption, not blindly copied:

- `src/hooks/useWidgetData.ts` + `src/components/WidgetBody.tsx` — desk's
  decomposition of the widget card. Adopt only if it hosts qwen's built-in
  widgets (Note/Clock/Website) without contortion; otherwise fold its
  data-fetch hardening into qwen's `WidgetCard`.
- `src/lib/capabilityScope.ts` vs qwen `src/lib/httpScope.ts`, and
  `src/lib/url.ts` vs qwen `src/lib/safeUrl.ts` — same problem, different
  filenames. One survives; the loser's test cases migrate to the survivor.
- `deploy/spark/README.md` (+ env example) — adopt; qwen has no deploy docs.
- `scripts/make-icon.mjs` — adopt if qwen lacks an icon pipeline.
- Desk-only tests: `AppShell.errorBoundaries.test.tsx`,
  `DashboardGrid.persist.test.tsx`, `smoke.test.ts`, dialog/renderer
  aggregate tests, SSE/MCP fixtures — port against the merged modules.

### Phase 4 — Verification

In order, all must pass:

1. `pnpm test:run` (reconciled suite, both parents' tests)
2. `pnpm typecheck`
3. `pnpm reference-backend` + `pnpm test:reference` (conformance)
4. `pnpm tauri build` (macOS, this machine)
5. `pnpm ios:check`
6. `OPENBB_LIVE=1 pnpm test:run src/test/integration/real-endpoints.test.ts`
   against the real NAS/Rita/MCP endpoints (needs `.env.local`)
7. Launch the built app; visually confirm dashboard widgets load from the
   NAS backend, Rita chat streams, and MCP tools assemble.

### Deliverables

- `~/Developer/bdobb` — working repo, history intact, commits grouped per
  subsystem (conventional commits).
- `docs/MERGE-NOTES.md` — the full decision log: module, which parent won,
  what was cross-ported, why.
- README/CLAUDE.md updated only where the merge changed behavior.

## Error handling / risks

- **Contract drift:** a component merged from desk may assume a type shape
  qwen's types.ts doesn't have. Mitigated by the bottom-up order — types are
  settled first, and `pnpm typecheck` runs after every subsystem group.
- **Contradictory tests:** both parents' tests must pass; where they encode
  opposite behavior, one is consciously retired with a MERGE-NOTES entry —
  never silently deleted.
- **Live-backend availability:** Phase 4 steps 6–7 need the tailnet stack
  up. If an endpoint is down, that step blocks with a clear report rather
  than being skipped silently.

## Out of scope

- New features; code signing; renaming (already `com.artcashin.bdobb`);
  any changes to the two source repositories; the untracked
  `2026-08-03-symphony-widget-design.md` spec (separate work, left alone).
