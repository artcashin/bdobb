# Per-Version Feature Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce eight rebuild documents in `aggregats/` — v3.0.0 as a full baseline and v4.0.0–v10.0.0 as additions-only deltas — so that reading them in sequence tells you how to build BDOBB from nothing.

**Architecture:** Each document is assembled from three sources in a fixed precedence: the squashed release commit body (authoritative on what shipped), the design specs that first appear at that tag (design detail), and the `bdobb-help` per-version folder (user-facing behavior), with gotchas drawn from the help repository's troubleshooting pages and the matching episode draft. A running ledger file records every feature claimed so far, which is what lets each delta task avoid restating a feature an earlier document already covered.

**Tech Stack:** Markdown authoring; `git log` / `git show` / `git ls-tree` against tags in the bdobb repository; plain file reads against two sibling working copies (`~/Developer/bdobb-help`, `~/Developer/substack-articles`). No build step, no test runner, no new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

- **Output directory:** `/Users/artcashin/Developer/bdobb/aggregats/`. Spelled `aggregats` exactly, as the user specified.
- **Nothing under `aggregats/` is ever committed.** The directory is gitignored. The only commit this plan produces is the `.gitignore` change in Task 1. Do not `git add` any file under `aggregats/`, and do not use `git add -A` or `git add .` at any point.
- **End-state only.** A feature body describes the form the design finally settled into. An approach that was tried and reversed never appears as an instruction — it appears once under **Gotchas** as *tried X → failed because Y → do Z instead*.
- **Additions only from v4 onward.** A feature described in an earlier document is never re-described in a later one. A feature reworked at a later version stays described where it first appeared, with a one-line forward pointer `→ reworked in vM, see that document`, and the rework itself is described in vM's document.
- **No code diffs.** Do not read tag-to-tag source diffs. This is a deliberate scope decision. Where a release commit body is terse (v8.0.0 and v9.0.0 are single-line), that document rests on the help repository and the episode draft, and will be correspondingly less detailed about implementation.
- **Planned pages are excluded.** Exactly three help pages carry planned status and must never be written up as shipped features:
  - `~/Developer/bdobb-help/v9.0.0/Widgets/real-time-chart.md` (shipped at v10.0.0)
  - `~/Developer/bdobb-help/v9.0.0/Widgets/arcticdb-explorer.md` (Ep. 11, out of scope)
  - `~/Developer/bdobb-help/v10.0.0/Widgets/arcticdb-explorer.md` (Ep. 11, out of scope)
- **Scope ends at v10.0.0.** The ArcticDB explorer (Ep. 11) and Symphony (Ep. 12) are out of scope entirely. They appear only in *Not in this version* sections.
- **Stack pairing.** The two repositories tag independently; the stack is tagged only when it changed, so the pairing is *newest openbb-docker tag at or below this episode*. Copy these values verbatim:

  | bdobb | openbb-docker |
  |---|---|
  | v3.0.0 | v3.0.0 |
  | v4.0.0 | v3.0.0 |
  | v5.0.0 | v3.0.0 |
  | v6.0.0 | v6.0.0 |
  | v7.0.0 | v6.0.0 |
  | v8.0.0 | v8.0.0 |
  | v9.0.0 | v9.0.0 |
  | v10.0.0 | v10.0.0 |

- **Release commits.** All eight are reachable from `v10.0.0` in one linear history. Copy these SHAs verbatim:

  | version | SHA | subject |
  |---|---|---|
  | (scaffold) | `fd2703c` | scaffold: repo skeleton and CI scrub gate |
  | v3.0.0 | `206e48d` | the app — dashboards, widgets, built-ins, key status |
  | v4.0.0 | `efcd679` | the adversarial-review layer |
  | v5.0.0 | `837f2ae` | one-command test environment + Workspace interchange |
  | v6.0.0 | `ddbda67` | the analyst — Rita chat pane, agent protocol, MCP tools |
  | v7.0.0 | `2bfe909` | the iPadOS adventure |
  | v8.0.0 | `fd64383` | News rail built-in — the wire, natively |
  | v9.0.0 | `1aec95c` | live_grid renderer — streaming quotes, the tape |
  | v10.0.0 | `04f68d2` | the live chart — client-bucketed tick chart |

- **Episode drafts.** Match by episode number. Copy these paths verbatim; note that not every episode has an `outline.md`:

  | ep | folder under `~/Developer/substack-articles/` | files |
  |---|---|---|
  | 3 | `03-bdobb-design/` | `draft.md`, `outline.md` |
  | 4 | `04-claude-vs-qwen/` | `draft.md`, `outline.md` |
  | 5 | `05-try-bdobb/` | `draft.md`, `outline.md` |
  | 6 | `06-private-ai-stack/` | `draft.md`, `outline.md` |
  | 7 | `07-ipados-adventure/` | `draft.md`, `outline.md` |
  | 8 | `08-rss-ticker/` | `draft.md` only |
  | 9 | `09-eodhd-live-data/` | `draft.md` only |
  | 10 | `10-real-time-chart/` | `draft.md`, `outline.md` |

  For episodes 4 and 5 the article subject diverges from the release subject — the releases are the adversarial-review layer and the test environment, while the articles are *claude-vs-qwen* and *try-bdobb*. For those two, mine the drafts **only** for traps that pertain to the release's own features.

- **The backfilled tail.** Four pieces of work are present identically in *every* tag from v3.0.0 through v10.0.0, because each release commit is a whole-tree snapshot and the same tail was replayed onto each one: the horizontal analog clock layout (`src/components/renderers/AnalogFace.tsx`), the BDOBB Help system (native Help menu plus the version-scoped documentation window, `scripts/fetch-help-content.mjs` and `src/help/`), the bug-report/enhancement routing copy, and the app icon. Verified: all three of `v3.0.0`, `v6.0.0`, `v10.0.0` contain the same 31 files under `src/help/` + `scripts/help/`, and all contain `AnalogFace.tsx`. **Rule:** describe all four in the v3.0.0 baseline document, since they are present in the v3.0.0 tree a rebuilder would be reproducing, and never repeat them in v4–v10. Record the backfill itself as a v3 gotcha. Note the asymmetry that the `embedded-help-system` spec first appears at tag v3.0.0 while the `clock-horizontal-analog-layout` spec first appears only at tag v10.0.0, even though both features are in the v3.0.0 tree.

---

## File Structure

| File | Responsibility |
|---|---|
| `.gitignore` (modify) | Keeps `aggregats/` out of version control |
| `aggregats/.ledger.md` (create, Task 1) | Running list of every feature claimed, and by which document. The delta-discipline mechanism: each task appends to it, and each later task checks against it instead of re-reading all prior documents. |
| `aggregats/v3.0.0-features.md` | Full baseline — the whole application as of v3 |
| `aggregats/v4.0.0-features.md` … `v10.0.0-features.md` | Additions only, one per release |
| `aggregats/README.md` (create last) | How to read the set, in what order, and what the ledger is |

## Document template

Every version document uses exactly these five sections, in this order. Sections
3 and 5 may be the single line `None.` where a version has nothing to record;
sections 1, 2 and 4 are never empty.

```markdown
# BDOBB v<N>.0.0 — <thesis>

**Episode:** <N> · **Pairs with:** openbb-docker v<M>.0.0
**Assumes built:** v3.0.0 through v<N-1>.0.0   <!-- omit this line in v3's document -->

## What this version adds

### <Feature name>

<User-visible behavior. The design decisions as finally settled. What the
feature requires. End state only.>

## Infrastructure & prerequisites

<Services, providers, credentials, toolchain pieces newly required at this
version. Do not restate anything inherited from an earlier version.>

## Gotchas

### <Short symptom>

**Symptom.** <what you see> **Cause.** <why> **Rule.** <what to do instead>

## Not in this version

- **<Feature>** — shipped at v<M>.0.0.
```

---

## Task 1: Scaffold the output directory

**Files:**
- Modify: `/Users/artcashin/Developer/bdobb/.gitignore`
- Create: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the `aggregats/` directory, and `aggregats/.ledger.md` containing a
  markdown table with the exact header row `| Feature | Document | Note |`.
  Every later task appends rows to this table and reads it to check for
  duplicates.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p /Users/artcashin/Developer/bdobb/aggregats
```

- [ ] **Step 2: Add the gitignore entry**

Append this line to `/Users/artcashin/Developer/bdobb/.gitignore`, under a blank
line, preserving everything already in the file:

```
aggregats/
```

- [ ] **Step 3: Verify the ignore rule actually matches**

Run:

```bash
cd /Users/artcashin/Developer/bdobb && touch aggregats/.probe && git check-ignore -v aggregats/.probe; rm aggregats/.probe
```

Expected: a line naming `.gitignore` and the `aggregats/` pattern. If the
command prints nothing, the rule is not matching — fix it before continuing, or
every later task risks committing output.

- [ ] **Step 4: Create the ledger**

Write `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`:

```markdown
# Feature ledger

Every feature claimed by a document in this directory, and which document
claims it. Append one row per feature as each document is written. Before
adding a feature to a new document, check it does not already appear here —
that is what enforces additions-only discipline across v4–v10.

| Feature | Document | Note |
|---|---|---|
```

- [ ] **Step 5: Commit the gitignore change only**

```bash
cd /Users/artcashin/Developer/bdobb && git add .gitignore && git commit -m "chore: ignore aggregats/ output directory"
```

- [ ] **Step 6: Verify nothing under aggregats/ was staged**

Run:

```bash
cd /Users/artcashin/Developer/bdobb && git show --stat --name-only HEAD
```

Expected: exactly one file, `.gitignore`. If any `aggregats/` path appears, the
commit is wrong — reset it and redo Steps 2–5.

---

## Task 2: v3.0.0 — the baseline document

This is the largest document. It carries the entire application, not a delta.

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v3.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md` (empty table) from Task 1.
- Produces: the baseline document, and ledger rows for every feature it claims.
  All later tasks treat any feature listed here as already built.

- [ ] **Step 1: Read the two release commit bodies**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 206e48d && git show -s --format='%B' fd2703c
```

`206e48d` names the feature list and, in its closing lines, the work stripped
out for later episodes. Both halves are authoritative.

- [ ] **Step 2: Read the design docs present at this tag**

```bash
cd /Users/artcashin/Developer/bdobb && git show v3.0.0:docs/superpowers/specs/2026-07-30-openbb-desk-design.md
```

Then the same for each of:
`docs/superpowers/specs/2026-08-06-keys-widget-design.md`,
`docs/superpowers/specs/2026-08-06-provider-badges-design.md`,
`docs/superpowers/specs/2026-08-06-embedded-help-system-design.md`,
`docs/superpowers/plans/2026-07-30-ai-stack.md`,
`docs/superpowers/plans/2026-07-30-desktop-app.md`.

- [ ] **Step 3: Read the help content for this version**

```bash
cd ~/Developer/bdobb-help/v3.0.0 && cat home.md about-this-guide.md "Configuration/app-data-and-settings.md" "Interface/layout-and-navigation.md"
```

- [ ] **Step 4: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v3.0.0/troubleshooting-using-bdobb.md
cat ~/Developer/substack-articles/03-bdobb-design/outline.md ~/Developer/substack-articles/03-bdobb-design/draft.md
```

- [ ] **Step 5: Write the document**

Create `aggregats/v3.0.0-features.md` following the template above, with
`**Pairs with:** openbb-docker v3.0.0` and no *Assumes built* line.

*What this version adds* must cover, at minimum, one subsection for each of:

- the dashboard grid, the tab strip, the hover left rail, and the widget library
- the renderer set: table, chart (Plotly), markdown, html, iframe, pdf, metric, raw JSON
- the built-in widgets: Note; Clock, including the LED typeface and the horizontal analog layout; Website, with its anti-framing explanation shown in-card
- the backends and settings dialogs, capability generation from `.env.local`, and the log viewer
- per-card params
- persistence with quarantine-not-clobber semantics
- the repo skeleton and the CI scrub gate
- the BDOBB Help system: native Help menu and version-scoped documentation window, with help content fetched per version from the `bdobb-help` repository
- bug reports routed to GitHub Issues and enhancement requests routed to Canny
- the application icon across every platform target

*Not in this version* must list, each with the version that delivered it —
these come straight from `206e48d`'s closing lines:

- chat / agent / MCP — v6.0.0
- apps.json interchange and the parameter-group UI — v5.0.0
- the reference-backend test environment — v5.0.0
- iPadOS and touch — v7.0.0
- CSP, region error boundaries, the startup-error banner, and review-era test hardening — v4.0.0

*Gotchas* must include one entry for the backfilled tail: that the Help system,
the analog clock layout, the bug-report routing and the icon were authored
after this episode and replayed onto every release snapshot, so their design
docs do not sit at the tag you would expect — the `embedded-help-system` spec is
at v3.0.0 but the `clock-horizontal-analog-layout` spec only appears at v10.0.0.

- [ ] **Step 6: Append to the ledger**

Add one row to `aggregats/.ledger.md` per feature subsection written, with
`v3.0.0-features.md` in the Document column.

- [ ] **Step 7: Verify coverage against the release commit**

Run:

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 206e48d
```

Read each bulleted item in the output and confirm it appears in the document.
Confirm every item after "Stripped for later episodes:" and "Held back for
v4.0.0" appears in *Not in this version*. Fix any omission before continuing.

- [ ] **Step 8: Verify nothing was staged**

```bash
cd /Users/artcashin/Developer/bdobb && git status --short
```

Expected: no `aggregats/` path appears (the directory is ignored).

---

## Task 3: v4.0.0 — the adversarial-review layer

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v4.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md` — every feature listed there is already built and must not be re-described.
- Produces: the v4 delta document, plus its ledger rows.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' efcd679
```

- [ ] **Step 2: Read the design doc that first appears at this tag**

```bash
cd /Users/artcashin/Developer/bdobb && git show v4.0.0:docs/superpowers/specs/2026-08-02-bdobb-reconciliation-design.md && git show v4.0.0:docs/superpowers/plans/2026-08-02-bdobb-reconciliation.md
```

- [ ] **Step 3: Check what changed in the help content**

```bash
diff -rq ~/Developer/bdobb-help/v3.0.0 ~/Developer/bdobb-help/v4.0.0
```

Read the full text of any file this reports as differing. If it reports nothing,
this version's document draws on the commit body and the spec alone — record
that in the document as a one-line note under *What this version adds*.

- [ ] **Step 4: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v4.0.0/troubleshooting-using-bdobb.md
cat ~/Developer/substack-articles/04-claude-vs-qwen/outline.md ~/Developer/substack-articles/04-claude-vs-qwen/draft.md
```

The Ep. 4 article is *claude-vs-qwen*, not the review layer — mine it only for
traps that pertain to CSP, error boundaries, the startup banner, or the review
process itself.

- [ ] **Step 5: Write the document**

Create `aggregats/v4.0.0-features.md` with `**Pairs with:** openbb-docker
v3.0.0` and `**Assumes built:** v3.0.0`.

*What this version adds* must cover one subsection for each of:

- the strict Content-Security-Policy — `script-src 'self'`, `object-src 'none'`, with `connect-src` and `style-src` deliberately loose, and the reason each is loose (user-configured backends; Plotly's CSSOM styling)
- error boundaries around every top-level pane and dialog, so a render throw degrades to one error card rather than a dead app
- the startup banner naming which loaders failed, replacing log-only reporting
- the review-era regression suites: per-boundary containment, layout-write suppression, real-mount persistence
- the reconciliation plan and design spec — the merge process itself, shipped as documentation

- [ ] **Step 6: Check the ledger for duplicates**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v4.0.0-features.md` in
the Document column.

- [ ] **Step 7: Verify coverage**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' efcd679
```

Confirm each bulleted item appears in the document.

---

## Task 4: v5.0.0 — test environment and Workspace interchange

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v5.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md`.
- Produces: the v5 delta document, plus its ledger rows.

This version added no design doc. The help repository doubled in size here — from
5 pages to 10 — so it carries most of the detail.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 837f2ae
```

- [ ] **Step 2: Read the docs file this version added**

```bash
cd /Users/artcashin/Developer/bdobb && git show v5.0.0:docs/test-environment.md
```

- [ ] **Step 3: Read the new and changed help content**

```bash
diff -rq ~/Developer/bdobb-help/v4.0.0 ~/Developer/bdobb-help/v5.0.0
```

Then read in full each file the diff reports as added or differing. The five
pages new at this version are `Configuration/backends-and-connections.md`,
`Getting Started/connecting-a-backend.md`, `Getting Started/importing-dashboards.md`,
`Getting Started/installing-and-running.md`, and `Interface/dashboards-and-widgets.md`.

- [ ] **Step 4: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v5.0.0/troubleshooting-using-bdobb.md
cat ~/Developer/substack-articles/05-try-bdobb/outline.md ~/Developer/substack-articles/05-try-bdobb/draft.md
```

The Ep. 5 article is *try-bdobb* — mine it for install, first-run and
import/export traps, not for its narrative.

- [ ] **Step 5: Write the document**

Create `aggregats/v5.0.0-features.md` with `**Pairs with:** openbb-docker
v3.0.0` and `**Assumes built:** v3.0.0 through v4.0.0`.

*What this version adds* must cover one subsection for each of:

- `pnpm reference-backend` — OpenBB's own reference implementation (~70 widgets) cloned, installed and served locally, with no account, no keys and no tailnet required
- the conformance suite `pnpm test:reference` — opt-in, failing loudly when the backend is down, pinned to an upstream revision in CI, using the spec owner's corpus as the oracle
- apps.json Import/Export on the dashboard strip — Workspace interchange with parameter groups, app sections in the tab strip, and unresolved widgets reported rather than silently dropped
- the `docs/test-environment.md` runbook

*Infrastructure & prerequisites* must record what the reference backend needs to
run locally, as described in `docs/test-environment.md`.

- [ ] **Step 6: Check the ledger for duplicates, then append**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v5.0.0-features.md` in
the Document column.

- [ ] **Step 7: Verify coverage**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 837f2ae
```

Confirm each bulleted item appears in the document.

---

## Task 5: v6.0.0 — the analyst

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v6.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md`.
- Produces: the v6 delta document, plus its ledger rows.

This is the first version whose paired stack version changes — openbb-docker
v6.0.0 is the MCP server this release talks to.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' ddbda67
```

- [ ] **Step 2: Read the design doc that first appears at this tag**

```bash
cd /Users/artcashin/Developer/bdobb && git show v6.0.0:docs/superpowers/specs/2026-08-06-settings-tabs-design.md && git show v6.0.0:docs/superpowers/plans/2026-08-06-settings-tabs.md
```

- [ ] **Step 3: Read the new and changed help content**

```bash
diff -rq ~/Developer/bdobb-help/v5.0.0 ~/Developer/bdobb-help/v6.0.0
```

Then read in full each file reported as added or differing. New at this version:
`Integrations/rita-ai-agent-setup.md`, `Integrations/tailscale-networking.md`,
`Widgets/ai-chat.md`, and `troubleshooting-infrastructure.md` — the last is a
whole new troubleshooting page, and it is a gotcha source from here on.

- [ ] **Step 4: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v6.0.0/troubleshooting-using-bdobb.md ~/Developer/bdobb-help/v6.0.0/troubleshooting-infrastructure.md
cat ~/Developer/substack-articles/06-private-ai-stack/outline.md ~/Developer/substack-articles/06-private-ai-stack/draft.md
```

- [ ] **Step 5: Write the document**

Create `aggregats/v6.0.0-features.md` with `**Pairs with:** openbb-docker
v6.0.0` and `**Assumes built:** v3.0.0 through v5.0.0`.

*What this version adds* must cover one subsection for each of:

- the agent protocol client: `agents.json`, SSE streaming, the `get_widget_data` round trip, and abort/timeout handling — noting that the SSE parser was stress-tested across roughly 8,900 chunk-split positions
- MCP: streamable-http discovery and tool assembly under a byte budget, where a server restarted without `--tool-discovery` is skipped visibly rather than fatally
- the Rita pane: hover, pin, and the unread dot; dashboard context sharing with a privacy toggle that also gates widget-derived MCP servers
- chat persistence, and markdown / table / chart artifacts with export and share targets
- the settings tabs redesign
- live-captured SSE and MCP fixtures, and the opt-in live-endpoint suite
- `deploy/spark` — the sanitized agent deployment runbook and env example

*Infrastructure & prerequisites* must record the openbb-docker v6.0.0 MCP server
and the Tailscale networking setup, drawing on
`Integrations/tailscale-networking.md`.

- [ ] **Step 6: Check the ledger for duplicates, then append**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v6.0.0-features.md` in
the Document column.

- [ ] **Step 7: Verify coverage**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' ddbda67
```

Confirm each bulleted item appears in the document.

---

## Task 6: v7.0.0 — the iPadOS adventure

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v7.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md`.
- Produces: the v7 delta document, plus its ledger rows.

No design doc at this version. The release commit body is detailed and the
episode draft is directly on-subject.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 2bfe909
```

- [ ] **Step 2: Read the new and changed help content**

```bash
diff -rq ~/Developer/bdobb-help/v6.0.0 ~/Developer/bdobb-help/v7.0.0
```

Then read in full each file reported as added or differing. New at this version:
`iPad App/installing-on-ipad.md` and `iPad App/ipad-interface-differences.md`.

- [ ] **Step 3: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v7.0.0/troubleshooting-using-bdobb.md ~/Developer/bdobb-help/v7.0.0/troubleshooting-infrastructure.md
cat ~/Developer/substack-articles/07-ipados-adventure/outline.md ~/Developer/substack-articles/07-ipados-adventure/draft.md
```

- [ ] **Step 4: Write the document**

Create `aggregats/v7.0.0-features.md` with `**Pairs with:** openbb-docker
v6.0.0` and `**Assumes built:** v3.0.0 through v6.0.0`.

*What this version adds* must cover one subsection for each of:

- `pnpm ios:check` / `ios:init` / `ios:dev` / `ios:build` — a preflight that names each missing toolchain piece together with its fix, and the documented distinction that `ios:dev` serves the frontend from your Mac while `ios:build` is self-contained
- the free-Apple-ID signing flow: `pnpm ios:team` writing `APPLE_DEVELOPMENT_TEAM` into `.env.local`, which is gitignored, and why the generated Xcode project stays uncommitted (Xcode writes the team id into it)
- runtime input paradigms: `usePointerKind` reading `(pointer: fine)` reactively, so hover applies with a trackpad or keyboard while touch gets tap-to-open and tap-outside-to-dismiss, switching live when a Magic Keyboard docks or undocks
- iPad polish: safe-area insets, overscroll suppression, text-size-adjust, and selection callout disabled on chrome but not on data
- `bundle.iOS.minimumSystemVersion` of 16.0 — the WebKit floor for container queries

*Gotchas* must record that grid rearrange by touch is a documented known gap at
this version, not a bug to go hunting for.

- [ ] **Step 5: Check the ledger for duplicates, then append**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v7.0.0-features.md` in
the Document column.

- [ ] **Step 6: Verify coverage**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 2bfe909
```

Confirm each bulleted item appears in the document.

---

## Task 7: v8.0.0 — the News rail

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v8.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md`.
- Produces: the v8 delta document, plus its ledger rows.

This release commit body is a single line with no detail, and there is no design
doc. Per the global constraints, no code diff is read. The help repository and
the episode draft carry this document — expect it to be less specific about
implementation than its neighbours, and do not invent detail to fill the gap.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' fd64383
```

Expected: the subject line and a co-author trailer, nothing more.

- [ ] **Step 2: Read the new and changed help content — the primary source here**

```bash
diff -rq ~/Developer/bdobb-help/v7.0.0 ~/Developer/bdobb-help/v8.0.0
```

Then read in full each file reported as added or differing. New at this version:
`Widgets/news-ticker.md`, `Integrations/rss-feed-sources.md`, and
`Configuration/secrets-and-access.md`.

- [ ] **Step 3: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v8.0.0/troubleshooting-using-bdobb.md ~/Developer/bdobb-help/v8.0.0/troubleshooting-infrastructure.md
cat ~/Developer/substack-articles/08-rss-ticker/draft.md
```

There is no `outline.md` for Ep. 8 — the draft is the only article source.

- [ ] **Step 4: Write the document**

Create `aggregats/v8.0.0-features.md` with `**Pairs with:** openbb-docker
v8.0.0` and `**Assumes built:** v3.0.0 through v7.0.0`.

*What this version adds* must cover, at minimum:

- the News rail as a built-in — the wire delivered natively rather than through an external widget
- RSS feed source configuration
- whatever `Configuration/secrets-and-access.md` newly requires, if it is tied to the news feed rather than inherited

*Infrastructure & prerequisites* must record the openbb-docker v8.0.0 stack and
the RSS feed service it introduces.

Where the sources do not establish a detail, say so in the document — a line
reading `Not recorded in the sources for this version.` is correct, and
inventing plausible implementation detail is not.

- [ ] **Step 5: Check the ledger for duplicates, then append**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v8.0.0-features.md` in
the Document column.

- [ ] **Step 6: Verify against the help delta**

```bash
diff -rq ~/Developer/bdobb-help/v7.0.0 ~/Developer/bdobb-help/v8.0.0
```

Confirm every added or differing page is reflected somewhere in the document, or
consciously excluded with a reason.

---

## Task 8: v9.0.0 — live_grid, the tape

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v9.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md`.
- Produces: the v9 delta document, plus its ledger rows.

Single-line release commit body, no design doc — same conditions as Task 7. This
version also carries the planned-page hazard.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 1aec95c
```

- [ ] **Step 2: Read the new and changed help content — the primary source here**

```bash
diff -rq ~/Developer/bdobb-help/v8.0.0 ~/Developer/bdobb-help/v9.0.0
```

Then read in full each file reported as added or differing, **except** the two
planned pages. New and shipped at this version: `Widgets/live-quotes.md`,
`Configuration/kdb-cache.md`, `Integrations/eodhd-data-provider.md`.

- [ ] **Step 3: Confirm the two planned pages are excluded**

Run:

```bash
head -8 ~/Developer/bdobb-help/v9.0.0/Widgets/real-time-chart.md ~/Developer/bdobb-help/v9.0.0/Widgets/arcticdb-explorer.md
```

Expected: both show `planned` in their frontmatter tags. Neither describes a
v9 feature. `real-time-chart` belongs in *Not in this version* as shipped at
v10.0.0; `arcticdb-explorer` belongs there as Ep. 11, out of scope.

- [ ] **Step 4: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v9.0.0/troubleshooting-using-bdobb.md ~/Developer/bdobb-help/v9.0.0/troubleshooting-infrastructure.md
cat ~/Developer/substack-articles/09-eodhd-live-data/draft.md
```

There is no `outline.md` for Ep. 9 — the draft is the only article source.

- [ ] **Step 5: Write the document**

Create `aggregats/v9.0.0-features.md` with `**Pairs with:** openbb-docker
v9.0.0` and `**Assumes built:** v3.0.0 through v8.0.0`.

*What this version adds* must cover, at minimum:

- the `live_grid` renderer — streaming quotes presented as the tape
- the EODHD data provider integration
- the kdb+ cache configuration as it is exposed to the user at this version

*Not in this version* must list:

- **Real-time chart** — shipped at v10.0.0 (help page present here but marked planned)
- **ArcticDB explorer** — Ep. 11, outside this document set's scope (help page present here but marked planned)

*Infrastructure & prerequisites* must record the openbb-docker v9.0.0 stack, the
`live-grid` and `rss-ticker` services, and the EODHD API key.

- [ ] **Step 6: Check the ledger for duplicates, then append**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v9.0.0-features.md` in
the Document column.

- [ ] **Step 7: Verify the planned pages did not leak**

Run:

```bash
grep -niE "arcticdb|real-time chart|realtime chart" /Users/artcashin/Developer/bdobb/aggregats/v9.0.0-features.md
```

Expected: matches appear **only** under the *Not in this version* heading. Any
match inside *What this version adds* is a defect — remove it.

---

## Task 9: v10.0.0 — the live chart

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/v10.0.0-features.md`
- Modify: `/Users/artcashin/Developer/bdobb/aggregats/.ledger.md`

**Interfaces:**
- Consumes: `aggregats/.ledger.md`.
- Produces: the final delta document, plus its ledger rows.

The v9 and v10 help folders contain the **same file list** — v10's delta is
entirely in the *content* of seven files. A file-listing comparison would report
v10 as adding nothing, so content comparison is mandatory here.

- [ ] **Step 1: Read the release commit body**

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 04f68d2
```

Note its closing paragraph: this snapshot was stripped of Symphony (Ep. 12),
which had landed on main ahead of episode order under this project's
backward-strip convention.

- [ ] **Step 2: Read the design docs that first appear at this tag**

```bash
cd /Users/artcashin/Developer/bdobb && git show v10.0.0:docs/superpowers/specs/2026-08-07-live-chart-design.md
```

Then the same for
`docs/superpowers/specs/2026-08-06-news-rail-favicons-design.md` and
`docs/superpowers/specs/2026-08-07-clock-horizontal-analog-layout-design.md`.

Note the ordering asymmetry: the clock spec first appears at this tag even
though the feature itself is in the v3.0.0 tree and is documented in v3's
baseline document. Do **not** re-describe the clock layout here; if the spec
records a lesson worth keeping, put it in v3's *Gotchas*, not in this document.

- [ ] **Step 3: Read the changed help content — content, not file list**

```bash
diff -r ~/Developer/bdobb-help/v9.0.0 ~/Developer/bdobb-help/v10.0.0
```

Note this is `diff -r`, without `-q`, so the actual content changes are shown.
Seven files differ: `Configuration/kdb-cache.md`,
`Integrations/eodhd-data-provider.md`, `Widgets/arcticdb-explorer.md`,
`Widgets/live-quotes.md`, `Widgets/real-time-chart.md`, `about-this-guide.md`,
and `home.md`. `Widgets/real-time-chart.md` has lost its planned marker at this
version — it is now a shipped feature and its full text is a primary source.
`Widgets/arcticdb-explorer.md` is **still** planned here and stays excluded.

- [ ] **Step 4: Read the gotcha sources**

```bash
cat ~/Developer/bdobb-help/v10.0.0/troubleshooting-using-bdobb.md ~/Developer/bdobb-help/v10.0.0/troubleshooting-infrastructure.md
cat ~/Developer/substack-articles/10-real-time-chart/outline.md ~/Developer/substack-articles/10-real-time-chart/draft.md
```

- [ ] **Step 5: Write the document**

Create `aggregats/v10.0.0-features.md` with `**Pairs with:** openbb-docker
v10.0.0` and `**Assumes built:** v3.0.0 through v9.0.0`.

*What this version adds* must cover one subsection for each of:

- the live chart: seeded from live-grid's kdb+ cache via `/series`, then extending itself over the existing `live_grid_ws` stream — the same socket that drives the v9 tape
- client-side bucketing, with line, area and candle chart types
- the volume panel, gated on data availability
- multi-symbol overlay normalized to percent change, and small multiples
- News rail favicons

*Gotchas* must record the contrast the episode draws: the reference dashboard
this was modelled on re-polls on an auto-refresh timer, while this chart plots
the stream it is already receiving — same picture, opposite mechanism. Building
it as a poller is the trap.

*Not in this version* must list:

- **ArcticDB explorer** — Ep. 11, outside this document set's scope
- **Symphony** — Ep. 12; it had landed on main ahead of episode order and was stripped back out of this snapshot

- [ ] **Step 6: Check the ledger for duplicates, then append**

Open `aggregats/.ledger.md` and confirm none of the features you just wrote
already has a row. If one does, remove it from this document — it belongs to the
earlier version — then append the remaining rows with `v10.0.0-features.md` in
the Document column.

- [ ] **Step 7: Verify the clock was not duplicated**

Run:

```bash
grep -nil "analog" /Users/artcashin/Developer/bdobb/aggregats/*.md
```

Expected: `v3.0.0-features.md` only, plus possibly `.ledger.md`. If
`v10.0.0-features.md` appears, the clock layout has been described twice —
remove it from v10.

---

## Task 10: README and the final cross-document audit

**Files:**
- Create: `/Users/artcashin/Developer/bdobb/aggregats/README.md`
- Modify: any document the audit finds defective

**Interfaces:**
- Consumes: all eight documents and `aggregats/.ledger.md`.
- Produces: the README, and an audited document set.

- [ ] **Step 1: Write the README**

Create `aggregats/README.md` covering: that these are rebuild documents rather
than release notes; that `v3.0.0-features.md` is a complete baseline and
`v4`–`v10` are additions only, to be read in version order; the end-state-only
rule and where reversed decisions live (Gotchas); that `.ledger.md` is the
working index of which document claims which feature; that the set stops at
v10.0.0, with Ep. 11 and Ep. 12 out of scope; and that the directory is
gitignored on purpose.

- [ ] **Step 2: Audit — every release commit feature appears exactly once**

Run:

```bash
cd /Users/artcashin/Developer/bdobb && for c in 206e48d efcd679 837f2ae ddbda67 2bfe909 fd64383 1aec95c 04f68d2; do echo "===== $c"; git show -s --format='%B' $c; done
```

For each bulleted item across all eight bodies, confirm it appears in exactly
one document. Record any gap and fix it.

- [ ] **Step 3: Audit — no feature is claimed twice**

Open `aggregats/.ledger.md` and check the Feature column for entries that name
the same thing under different wording. Any true duplicate: keep the earliest
version's description, delete the later one, and if the later version genuinely
reworked it, replace the later entry with the rework plus a forward pointer from
the earlier document.

- [ ] **Step 4: Audit — no planned page was written up as shipped**

Run:

```bash
grep -nil "arcticdb" /Users/artcashin/Developer/bdobb/aggregats/v*.md
```

Expected: ArcticDB appears only under *Not in this version* headings in
`v9.0.0-features.md` and `v10.0.0-features.md`. Open each match and confirm the
heading it sits under.

- [ ] **Step 5: Audit — troubleshooting entries were each handled**

For each version, list the entries in that version's troubleshooting pages:

```bash
grep -h "^#" ~/Developer/bdobb-help/v*/troubleshooting-*.md | sort -u
```

Confirm each is either present as a gotcha in some document or was consciously
dropped as not build-relevant. Fix any that was simply missed.

- [ ] **Step 6: Audit — the strip declarations were honoured**

Run:

```bash
cd /Users/artcashin/Developer/bdobb && git show -s --format='%B' 206e48d | sed -n '/Stripped/,$p' && git show -s --format='%B' 04f68d2 | sed -n '/Snapshot stripped/,$p'
```

Confirm every item named appears in the corresponding document's *Not in this
version* section.

- [ ] **Step 7: Final check — nothing was committed**

Run:

```bash
cd /Users/artcashin/Developer/bdobb && git status --short && git log --oneline -3
```

Expected: no `aggregats/` path in the status output, and the only commit this
plan produced is the `.gitignore` change from Task 1.

---

## Success criteria

The work is done when all of the following hold:

- Nine files exist under `aggregats/`: eight version documents, plus `README.md`, plus the working `.ledger.md`.
- Every feature named in a release commit body appears in exactly one document (Task 10 Step 2).
- No feature is described in two documents (Task 10 Step 3).
- No page marked `status: planned` is written up as a shipped feature (Task 10 Step 4).
- Every troubleshooting entry is either a gotcha or a conscious omission (Task 10 Step 5).
- Every "stripped for later episodes" declaration appears in a *Not in this version* section (Task 10 Step 6).
- `git status --short` shows no `aggregats/` path, and the only commit is the `.gitignore` change (Task 10 Step 7).
