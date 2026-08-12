# Per-version feature aggregation (v3.0.0 – v10.0.0)

**Date:** 2026-08-12
**Status:** approved (design); implementation not started

## Purpose

Produce one feature document per BDOBB release, v3.0.0 through v10.0.0, that
together describe how to build the application from nothing. Read in sequence,
the eight documents compose the whole app as it stands at v10.

These are rebuild documents, not release notes. Each feature is described in
the form its design finally settled into, so a reader can build straight from
the text without constructing something a later version tears out. What was
tried and abandoned survives only as a recorded trap, never as an instruction.

## Output

A new gitignored directory at the repository root:

```
aggregats/
  README.md              how to read these, and in what order
  v3.0.0-features.md     full baseline — everything the app is at v3
  v4.0.0-features.md     additions only
  v5.0.0-features.md     additions only
  v6.0.0-features.md     additions only
  v7.0.0-features.md     additions only
  v8.0.0-features.md     additions only
  v9.0.0-features.md     additions only
  v10.0.0-features.md    additions only
```

`aggregats/` is added to `.gitignore`. The directory is deliberately separate
from `docs/` and `.superpowers/`.

`v3.0.0-features.md` is the baseline and carries the entire application as of
v3. Every later document is a delta that assumes its predecessors were built.

## Document template

Each document has five sections.

### 1. Identity

Version, episode number, the release's one-line thesis (taken from the release
commit subject), and the openbb-docker stack version it pairs with. The two
repositories tag independently — the stack is tagged only when it changed — so
the pairing is *newest stack tag at or below this episode*:

| bdobb | stack |
|---|---|
| v3.0.0 | openbb-docker v3.0.0 |
| v4.0.0 | v3.0.0 |
| v5.0.0 | v3.0.0 |
| v6.0.0 | v6.0.0 |
| v7.0.0 | v6.0.0 |
| v8.0.0 | v8.0.0 |
| v9.0.0 | v9.0.0 |
| v10.0.0 | v10.0.0 |

For deltas, this section also states what the reader must already have built.

### 2. What this version adds

One subsection per feature, covering user-visible behavior, the design
decisions as finally settled, and what the feature requires. For v3, this
section is the whole application rather than a delta.

### 3. Infrastructure & prerequisites

Backend services, data providers, credentials, and toolchain pieces this
version newly demands. Only what is *new* at this version; prerequisites
inherited from earlier versions are not restated.

### 4. Gotchas

Traps to expect while building this version, each written as a short entry:
the symptom, the cause, and the rule that came out of it. Two kinds:

- **In use** — failure modes that reached users, from the help repository's
  troubleshooting pages.
- **At build time** — dead ends and reversed decisions, from the episode
  drafts.

### 5. Not in this version

Features the sources mention in this version's vicinity but that shipped
later, each with the version that actually delivered it. This section exists
to defuse two specific hazards documented under *Known hazards* below.

## The correction rule

The instruction "remove things that we changed" resolves as follows:

1. A feature body describes only the end state — the form the decision finally
   settled into. An approach that was tried and reversed never appears as an
   instruction.
2. The reversal is recorded exactly once, in **Gotchas**, as *tried X → failed
   because Y → do Z instead*.
3. Where a feature introduced at version N was substantially reworked at a
   later version M, the feature stays described at N (the additions-only
   structure forbids hoisting M's work into N) and carries a one-line forward
   pointer: *reworked in vM — see that document*. The rework itself is
   described in M's document.

## Sources

Per version N, in precedence order:

| Section | Source |
|---|---|
| Feature list (authoritative) | the `vN.0.0: …` squashed release commit body in the bdobb repository |
| Design detail | specs and plans under `docs/superpowers/` present at tag `vN.0.0` and absent at `v(N-1).0.0` |
| User-facing behavior | files under `~/Developer/bdobb-help/vN.0.0/` that are new or changed relative to `v(N-1).0.0`, excluding pages marked `status: planned` |
| Gotchas, in use | `~/Developer/bdobb-help/vN.0.0/troubleshooting-*.md` |
| Gotchas, at build time | `~/Developer/substack-articles/0N-*/draft.md` and `outline.md` |

Where sources disagree, the release commit body wins on *what shipped*; the
help repository wins on *how it behaves for a user*.

**Out of scope by decision:** tag-to-tag code diffs are not read. Where a
release commit body is terse — v8.0.0 and v9.0.0 have single-line bodies — that
document rests almost entirely on the help repository and the episode draft.
Those two documents will be the least detailed about implementation, and that
is an accepted consequence.

### Design-doc availability

Only four of the eight releases introduced a design document. This is why the
release commit bodies, not the specs, are the authoritative feature list.

| tag | design docs first appearing at this tag |
|---|---|
| v3.0.0 | openbb-desk, keys-widget, provider-badges, embedded-help-system, ai-stack, desktop-app |
| v4.0.0 | bdobb-reconciliation |
| v5.0.0 | *none* |
| v6.0.0 | settings-tabs |
| v7.0.0 | *none* |
| v8.0.0 | *none* |
| v9.0.0 | *none* |
| v10.0.0 | news-rail-favicons, clock-horizontal-analog-layout, live-chart |

### Episode-to-article alignment

Article folders map to episodes by number (`0N-*` ↔ episode N ↔ bdobb vN).
From episode 7 onward the article subject and the release subject coincide.
For episodes 4 and 5 they diverge — the release is the adversarial-review layer
and the test environment, while the articles are *claude-vs-qwen* and
*try-bdobb*. For those two, the drafts are mined only for traps that pertain to
the release's own features.

## Known hazards

**Planned pages in the help repository.** The help repository ships
forward-looking pages, marked `status: planned` in frontmatter with a banner in
the body. `bdobb-help/v9.0.0` already contains `Widgets/real-time-chart.md` and
`Widgets/arcticdb-explorer.md`, features belonging to episodes 10 and 11. Any
page carrying `status: planned` is excluded from the version's feature list and
belongs in *Not in this version*.

**Deliberate strip-and-defer.** This project cuts a release by stripping later
episodes' work back out of main, and the release commit bodies say so
explicitly — v3.0.0's body names chat/agent/MCP as v6, apps.json interchange
and the reference-backend test environment as v5, iPadOS as v7, and CSP plus
error boundaries as v4. Those declarations are authoritative and feed *Not in
this version* directly.

**Identical file sets, changed content.** `bdobb-help/v9.0.0` and `v10.0.0`
contain the same file list; v10's delta is entirely in the content of seven
files. File-set comparison alone would report v10 as adding nothing, so content
comparison is required, not just a listing.

## Process

The documents are written sequentially, v3 → v10. Each delta must know what the
earlier documents already claimed in order to avoid restating it, so they
cannot be produced in parallel.

`aggregats/README.md` is written last, once the eight documents exist.

## Success criteria

- Every feature named in a release commit body appears in exactly one document.
- No feature is described in two documents.
- No page marked `status: planned` is written up as a shipped feature.
- Every entry in every version's troubleshooting pages is either turned into a
  gotcha or consciously dropped as not build-relevant.
- Every "stripped for later episodes" declaration in a release commit body
  appears in that version's *Not in this version* section.
- `aggregats/` is present in `.gitignore` and no file under it is staged.
