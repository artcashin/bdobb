# Embedded Help System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give BDOBB a native Help menu that opens a dedicated window showing searchable, browsable documentation matching the exact version installed, sourced from a new `bdobb-help` content repo.

**Architecture:** A new public repo (`bdobb-help`) holds one full-snapshot folder per BDOBB version (`v3.0.0/` … `v9.0.0/`), each a complete copy of the topic-organized help vault as it stood at that release. BDOBB's build fetches the folder matching its own `package.json` version, converts it (wikilinks → internal links, images copied, search index + nav tree built), and bundles the result into a second Tauri window opened from a native "Help" menu item.

**Tech Stack:** Node scripts (fetch + conversion, plain ESM, no new runtime deps beyond `minisearch`), React 19 + `react-markdown` (already a dependency) + `remark-gfm` (new) for the window's frontend, Tauri v2's `tauri::menu` / `WebviewWindowBuilder` (Rust, part of the core `tauri` crate — no new Cargo feature needed) for the native menu and window.

## Global Constraints

- Exact version match only: the fetch step requires `bdobb-help/vX.Y.Z/` to match `package.json`'s `version` exactly. No fallback to a lower version — missing folder is a hard build error.
- The Help window has no `connect-src` needs and talks to no backend — all content is static, bundled at build time.
- Content in `bdobb-help` version folders is edited by hand in Tolaria, not generated — the conversion pipeline only transforms format (wikilinks, images, frontmatter), never authors prose.
- Follow existing repo conventions: co-located `*.test.ts(x)`/`*.test.mjs` files, minimal dependencies (hand-roll small parsers rather than pulling in a library for one field, matching `scripts/generate-capabilities.mjs`'s existing style), external links open via `@tauri-apps/plugin-opener` under Tauri (see `MarkdownRenderer.tsx`'s `ExternalLink` pattern).
- This plan's scope is **A + B only** (per the approved spec): the pipeline and UI, validated against `v9.0.0` (current `HEAD`). Rolling this feature into bdobb's actual historical git tags (`v3.0.0`–`v8.0.0`) is explicitly deferred to a future plan.
- All work happens in the isolated worktree at `/Users/artcashin/Developer/bdobb-help-system` (branch `feat/embedded-help-system`, based on `origin/main`) — never in the shared checkout at `/Users/artcashin/Developer/bdobb`, which has another session's uncommitted work in it.

---

## Phase 1 — `bdobb-help` content repo

### Task 1: Scaffold the `bdobb-help` repo and its verification script

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/README.md`
- Create: `/Users/artcashin/Developer/bdobb-help/scripts/verify-snapshot.mjs`

**Interfaces:**
- Produces: `node scripts/verify-snapshot.mjs <version-folder>` — CLI, exit code 0 on clean, 1 with error lines printed on any broken wikilink or image reference. Every later content task in this plan runs this against its own folder.

- [ ] **Step 1: Create the repo directory and initialize git**

```bash
mkdir -p /Users/artcashin/Developer/bdobb-help/scripts
cd /Users/artcashin/Developer/bdobb-help
git init -b main
```

- [ ] **Step 2: Write the README**

```markdown
# bdobb-help

Source content for BDOBB's in-app Help window, staged and reviewed as a
[Tolaria](https://github.com/refactoringhq/tolaria) vault.

Each top-level folder (`v3.0.0/`, `v4.0.0/`, ...) is a complete,
self-contained snapshot of the help content as it stood at that BDOBB
release — wikilinks and images only ever resolve within their own folder.
BDOBB's build fetches the folder matching its own version at build time; see
`bdobb`'s `scripts/fetch-help-content.mjs`.

Run `node scripts/verify-snapshot.mjs <folder>` after editing any version
folder to catch broken wikilinks or missing image references before they
ship.
```

- [ ] **Step 3: Write the verification script**

```javascript
#!/usr/bin/env node
// Verifies one bdobb-help version-folder snapshot: every [[wikilink]]
// resolves to a page that exists within the same folder, and every image
// reference resolves to a file in that folder's attachments/. Run after
// editing any version folder — a broken cross-reference here ships as a
// dead link or missing image in BDOBB's Help window.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/verify-snapshot.mjs <version-folder>");
  process.exit(1);
}
if (!existsSync(target)) {
  console.error(`no such folder: ${target}`);
  process.exit(1);
}

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "attachments" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (extname(entry) === ".md") out.push(full);
  }
  return out;
}

const files = walk(target);
const slugs = new Set(files.map((f) => f.split("/").pop().replace(/\.md$/, "")));
const attachmentsDir = join(target, "attachments");
const attachments = existsSync(attachmentsDir)
  ? new Set(readdirSync(attachmentsDir))
  : new Set();

let errors = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(target, file);

  for (const m of text.matchAll(/\[\[([a-zA-Z0-9_-]+)/g)) {
    if (!slugs.has(m[1])) {
      console.error(`${rel}: broken wikilink [[${m[1]}]] — no such page in this snapshot`);
      errors++;
    }
  }

  for (const m of text.matchAll(/!\[[^\]]*\]\((\.{0,2}\/?attachments\/[^)]+)\)/g)) {
    const filename = m[1].split("/").pop();
    if (!attachments.has(filename)) {
      console.error(`${rel}: broken image reference ${m[1]} — ${filename} not in attachments/`);
      errors++;
    }
  }
}

if (errors > 0) {
  console.error(`\n${errors} problem(s) found in ${target}`);
  process.exit(1);
}
console.log(`${target}: ${files.length} pages, all wikilinks and images resolve.`);
```

- [ ] **Step 4: Verify the script runs (no folders exist yet, so it should error cleanly)**

Run: `node scripts/verify-snapshot.mjs v9.0.0`
Expected: `no such folder: v9.0.0` (exit code 1) — confirms the script itself runs without a syntax error before any content exists.

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/verify-snapshot.mjs
git commit -m "chore: scaffold bdobb-help repo and snapshot verifier"
```

---

### Task 2: `v9.0.0/` snapshot (base — copy of the current 24-page vault)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v9.0.0/` (24 markdown files + `attachments/`, copied from `/Users/artcashin/Tolaria/BDOBB Help/`)

This version needs no content edits — it's already the full, current vault exactly as written (all 24 pages, all 25 images). Every later version folder is derived from this one by removal.

- [ ] **Step 1: Copy the vault verbatim**

```bash
cd /Users/artcashin/Developer/bdobb-help
mkdir -p v9.0.0
cp -R "/Users/artcashin/Tolaria/BDOBB Help/"* v9.0.0/
# Drop Tolaria's own git history and app-managed files — not part of the content
rm -rf v9.0.0/.git v9.0.0/.obsidian 2>/dev/null
find v9.0.0 -name ".DS_Store" -delete
```

- [ ] **Step 2: Confirm the file count matches expectations**

Run: `find v9.0.0 -name "*.md" | wc -l`
Expected: `24`

Run: `ls v9.0.0/attachments | wc -l`
Expected: `25`

- [ ] **Step 3: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v9.0.0`
Expected: `v9.0.0: 24 pages, all wikilinks and images resolve.`

- [ ] **Step 4: Commit**

```bash
git add v9.0.0
git commit -m "content: v9.0.0 snapshot (full current vault)"
```

---

### Task 3: `v8.0.0/` snapshot (strip v9-only content)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v8.0.0/` (derived from `v9.0.0/`)

v9-only content is everything from Ep. 9 (live quotes, EODHD) plus the forward-looking planned/optional pages that ship alongside it (real-time chart, ArcticDB explorer, kdb+ cache). None of Ep. 9's content had screenshots, so the attachments set is identical to v9.0.0's.

- [ ] **Step 1: Copy v9.0.0 as the starting point**

```bash
cd /Users/artcashin/Developer/bdobb-help
cp -R v9.0.0 v8.0.0
```

- [ ] **Step 2: Remove v9-only pages**

```bash
rm v8.0.0/Widgets/live-quotes.md
rm v8.0.0/Widgets/real-time-chart.md
rm v8.0.0/Widgets/arcticdb-explorer.md
rm v8.0.0/Integrations/eodhd-data-provider.md
rm v8.0.0/Configuration/kdb-cache.md
```

- [ ] **Step 3: Edit `v8.0.0/home.md`** — remove these five bullets (under Widgets and Configuration):

```
- [[live-quotes|Live Quotes (Live Grid)]] — a real-time watchlist across equities, crypto, and forex
- [[real-time-chart|Real-Time Chart]] *(planned)* — a live-plotting chart on top of live quotes
- [[arcticdb-explorer|ArcticDB Explorer]] *(planned)* — browsing a historical tick-data vault
- [[kdb-cache|kdb+ Cache (Optional)]] — the optional in-memory tick store behind live quotes and the planned chart
```
and, under Integrations:
```
- [[eodhd-data-provider|EODHD Data Provider]] — the data vendor behind [[live-quotes|Live Quotes]]
```

- [ ] **Step 4: Edit `v8.0.0/about-this-guide.md`** — remove the "Ep. 9" table row and the "Ep. 10–12 plan" table row entirely.

- [ ] **Step 5: Edit `v8.0.0/troubleshooting-using-bdobb.md`** — remove the entire `## Live Quotes` section (both entries and the "See also" line under it).

- [ ] **Step 6: Edit `v8.0.0/troubleshooting-infrastructure.md`** — remove the entire `## Live Quotes / EODHD Backend` section (both entries and its "See also" line).

- [ ] **Step 7: Edit `v8.0.0/Interface/dashboards-and-widgets.md`** — in the "Widget library" bullet list, remove the line:
```
- Feature-specific widget types: [[news-ticker|News Ticker]] (window/rail), [[live-quotes|Live Quotes]] (live grid), [[ai-chat|AI Chat]] (chat pane).
```
replace with:
```
- Feature-specific widget types: [[news-ticker|News Ticker]] (window/rail), [[ai-chat|AI Chat]] (chat pane).
```

- [ ] **Step 8: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v8.0.0`
Expected: `v8.0.0: 19 pages, all wikilinks and images resolve.` (24 − 5 removed = 19)

If it reports any broken wikilink, search that page for the removed slug and remove or reword the reference, then re-run.

- [ ] **Step 9: Commit**

```bash
git add v8.0.0
git commit -m "content: v8.0.0 snapshot (strip live quotes / EODHD / planned pages)"
```

---

### Task 4: `v7.0.0/` snapshot (strip v8-only content)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v7.0.0/` (derived from `v8.0.0/`)

v8-only content is the news ticker (Ep. 8). `tailscale-networking.md` is **not** removed — Rita/MCP (Ep. 6) still needs it — but its ticker-specific parts are trimmed.

- [ ] **Step 1: Copy v8.0.0 as the starting point**

```bash
cd /Users/artcashin/Developer/bdobb-help
cp -R v8.0.0 v7.0.0
```

- [ ] **Step 2: Remove v8-only pages**

```bash
rm v7.0.0/Widgets/news-ticker.md
rm v7.0.0/Integrations/rss-feed-sources.md
rm v7.0.0/Configuration/secrets-and-access.md
```

- [ ] **Step 3: Edit `v7.0.0/tailscale-networking.md`** —

Replace the opening paragraph:
```
Several backends in this guide — the [[news-ticker|news ticker]], the [[live-quotes|live quotes]] service, the [[rita-ai-agent-setup|MCP tool server]] — are designed to run privately on a Tailscale tailnet rather than being exposed publicly. This page covers the pattern and its sharp edges.
```
with:
```
The [[rita-ai-agent-setup|MCP tool server]] is designed to run privately on a Tailscale tailnet rather than being exposed publicly. This page covers the pattern and its sharp edges.
```

Remove the entire `## Identity-based auth (no tokens in URLs)` section (it's specific to the news ticker's token model) and the `## Trusting an identity header is only safe if Serve is the *only* door` section's reference to it if present — keep the `## The pattern`, `## The userspace-networking trap` sections, and the closing "See also" line, but drop `[[secrets-and-access|Secrets and Access]]` and `[[news-ticker|News Ticker]]` from that line, leaving just:
```
*See also: [[rita-ai-agent-setup|Setting Up the Rita AI Agent]] · [[troubleshooting-infrastructure|Configuring the Infrastructure]]*
```

- [ ] **Step 4: Edit `v7.0.0/home.md`** — remove these three bullets:
```
- [[news-ticker|News Ticker]] — the Bloomberg-style headline wire
- [[rss-feed-sources|RSS Feed Sources]] — running and configuring the news ticker's feed service
- [[secrets-and-access|Secrets and Access]] — the news ticker's key model and why a token lives in the URL
```

- [ ] **Step 5: Edit `v7.0.0/about-this-guide.md`** — remove the "Ep. 8" table row.

- [ ] **Step 6: Edit `v7.0.0/troubleshooting-using-bdobb.md`** — remove the entire `## News Ticker` section.

- [ ] **Step 7: Edit `v7.0.0/troubleshooting-infrastructure.md`** — remove the entire `## News Ticker Service` section, and drop the now-broken `[[news-ticker|News Ticker]]`, `[[rss-feed-sources|RSS Feed Sources]]`, and `[[tailscale-networking|Tailscale Networking]]` references from the intro paragraph and any remaining "See also" lines that name them, keeping the rest of that paragraph's meaning intact.

- [ ] **Step 8: Edit `v7.0.0/Interface/dashboards-and-widgets.md`** — the feature-specific widget types line becomes:
```
- Feature-specific widget types: [[ai-chat|AI Chat]] (chat pane).
```

- [ ] **Step 9: Prune attachments no longer referenced**

```bash
cd v7.0.0/attachments
rm -f news-window.png news-window-substack-tab.png new-headlines-pill.png \
      ticker-status-live.png ticker-status-dead.png ticker-config-yaml.png \
      news-widget-picker.png proxy-log-lines.png future-dated-article-bug.png \
      secrets-generation.png
cd ../..
```

- [ ] **Step 10: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v7.0.0`
Expected: `v7.0.0: 16 pages, all wikilinks and images resolve.` (19 − 3 = 16)

Fix any reported broken link, then re-run.

- [ ] **Step 11: Commit**

```bash
git add v7.0.0
git commit -m "content: v7.0.0 snapshot (strip news ticker)"
```

---

### Task 5: `v6.0.0/` snapshot (strip v7-only content)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v6.0.0/` (derived from `v7.0.0/`)

v7-only content is the iPad app (Ep. 7). No screenshots existed for Ep. 7, so no attachment changes.

- [ ] **Step 1: Copy v7.0.0 as the starting point**

```bash
cd /Users/artcashin/Developer/bdobb-help
cp -R v7.0.0 v6.0.0
```

- [ ] **Step 2: Remove the iPad App folder**

```bash
rm -rf "v6.0.0/iPad App"
```

- [ ] **Step 3: Edit `v6.0.0/home.md`** — remove the entire `## iPad App` section (heading and its two bullets).

- [ ] **Step 4: Edit `v6.0.0/about-this-guide.md`** — remove the "Ep. 7" table row.

- [ ] **Step 5: Edit `v6.0.0/troubleshooting-using-bdobb.md`** — remove the entire `## iPad App` section.

- [ ] **Step 6: Edit `v6.0.0/Configuration/app-data-and-settings.md`** — remove the `## Settings live outside your config files` section (it's iPad-precedence content), keeping only `## If you renamed the app and "lost" your settings`. Update the trailing "See also" line to drop `[[ipad-interface-differences|iPad Interface Differences]]`:
```
*See also: [[troubleshooting-using-bdobb|Using BDOBB]]*
```
Also drop the sentence in the intro that says "This matters most on iPad, but the underlying rule applies everywhere" — replace with a plain lead-in appropriate to the remaining section, e.g. delete that sentence entirely since the remaining section doesn't need it.

- [ ] **Step 7: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v6.0.0`
Expected: `v6.0.0: 14 pages, all wikilinks and images resolve.` (16 − 2 = 14)

Fix any reported broken link, then re-run.

- [ ] **Step 8: Commit**

```bash
git add v6.0.0
git commit -m "content: v6.0.0 snapshot (strip iPad app)"
```

---

### Task 6: `v5.0.0/` snapshot (strip v6-only content)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v5.0.0/` (derived from `v6.0.0/`)

v6-only content is AI chat / Rita (Ep. 6) — the first version with any infrastructure-side troubleshooting at all, so `troubleshooting-infrastructure.md` is removed entirely (it would otherwise be empty). No screenshots existed for Ep. 6, so no attachment changes.

- [ ] **Step 1: Copy v6.0.0 as the starting point**

```bash
cd /Users/artcashin/Developer/bdobb-help
cp -R v6.0.0 v5.0.0
```

- [ ] **Step 2: Remove v6-only pages**

```bash
rm v5.0.0/Widgets/ai-chat.md
rm v5.0.0/Integrations/rita-ai-agent-setup.md
rm v5.0.0/tailscale-networking.md
rm v5.0.0/troubleshooting-infrastructure.md
```

- [ ] **Step 3: Edit `v5.0.0/home.md`** — remove these three bullets:
```
- [[ai-chat|AI Chat]] — talking to a private AI agent about your dashboards
- [[rita-ai-agent-setup|Setting Up the Rita AI Agent]] — deploying a private agent for [[ai-chat|AI Chat]]
- [[tailscale-networking|Tailscale Networking]] — private-network deployment and identity-based auth
```
and remove the whole "Configuring the Infrastructure" bullet under Troubleshooting, leaving only:
```
## Troubleshooting

- [[troubleshooting-using-bdobb|Using BDOBB]] — issues in the app itself: install, build, settings, day-to-day widget behavior
```

- [ ] **Step 4: Edit `v5.0.0/about-this-guide.md`** — remove the "Ep. 6" table row.

- [ ] **Step 5: Edit `v5.0.0/troubleshooting-using-bdobb.md`** — remove the entire `## AI Chat` section.

- [ ] **Step 6: Edit `v5.0.0/Interface/layout-and-navigation.md`** — in the `## The AI pane` section, replace:
```
The chat pane (see [[ai-chat|AI Chat]]) lives on the right edge and folds to a thin strip the same way the rail does — open on hover/interaction, folded when idle.
```
with:
```
The chat pane lives on the right edge and folds to a thin strip the same way the rail does — open on hover/interaction, folded when idle.
```
(The fold/unread-dot behavior itself shipped at v3 — only the dedicated AI Chat page and its cross-link are v6+.)

- [ ] **Step 7: Edit `v5.0.0/Interface/dashboards-and-widgets.md`** — the feature-specific widget types line loses its last remaining entry; replace:
```
- Feature-specific widget types: [[ai-chat|AI Chat]] (chat pane).
```
with:
```
- Feature-specific widget types: none yet at this version — every widget is a table, chart, metric tile, markdown/PDF document, parameter form, or website card.
```

- [ ] **Step 8: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v5.0.0`
Expected: `v5.0.0: 10 pages, all wikilinks and images resolve.` (14 − 4 = 10)

Fix any reported broken link, then re-run.

- [ ] **Step 9: Commit**

```bash
git add v5.0.0
git commit -m "content: v5.0.0 snapshot (strip AI chat / Rita)"
```

---

### Task 7: `v3.0.0/` snapshot (strip v5-only content — down to Ep. 3 only)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v3.0.0/` (derived from `v5.0.0/`)

v5-only content is Getting Started (reference backend, connecting a backend, importing dashboards) and the widget-library page. v3.0.0 is the earliest version, containing only the layout/design content from Ep. 3.

- [ ] **Step 1: Copy v5.0.0 as the starting point**

```bash
cd /Users/artcashin/Developer/bdobb-help
cp -R v5.0.0 v3.0.0
```

- [ ] **Step 2: Remove v5-only pages and folder**

```bash
rm -rf "v3.0.0/Getting Started"
rm v3.0.0/Interface/dashboards-and-widgets.md
```

- [ ] **Step 3: Rewrite `v3.0.0/home.md`** in full, to only reference what remains:

```markdown
---
type: Note
tags: [bdobb, help, home, index]
---

# BDOBB Help

BDOBB (Better Desktop for OpenBB) is a private desktop app for OpenBB-compatible backends. This vault is the searchable help guide: use Tolaria's search to jump straight to a topic, or browse by section below.

## Interface

- [[layout-and-navigation|Layout and Navigation]] — the icon rail, the AI pane, and how BDOBB degrades gracefully

## Configuration

- [[app-data-and-settings|App Data and Settings]] — where your dashboards and settings actually live

## Troubleshooting

- [[troubleshooting-using-bdobb|Using BDOBB]] — issues in the app itself: install, build, settings, day-to-day widget behavior

## About

- [[about-this-guide|About This Guide]] — where this content comes from, episode by episode
```

- [ ] **Step 4: Rewrite `v3.0.0/about-this-guide.md`** in full:

```markdown
---
type: Note
tags: [bdobb, help, about, sources]
---

# About This Guide

This help system documents BDOBB (Better Desktop for OpenBB) by topic and task, not by publication order — but everything in it is drawn from the *Adventures in OpenBB* article series, and each article cites the episode(s) it came from.

| Episode | Covers | Feeds into |
|---|---|---|
| Ep. 3 — "I Asked for Electron and Got Talked Out of It" | The design decisions behind BDOBB's layout: the hover rail, the AI pane's fold/unread behavior, per-service degraded states, the app-rename data migration. | [[layout-and-navigation\|Layout and Navigation]], [[app-data-and-settings\|App Data and Settings]] |

Episode 4 ("Same Blueprint, Two Builders") is a development-process retrospective — how BDOBB was built, comparing a frontier-model workflow against a local model — rather than a description of user-facing functionality, so it isn't represented as help content here.

Original drafts live in `~/Developer/substack-articles/` on the machine this guide was generated from.
```

- [ ] **Step 5: Rewrite `v3.0.0/troubleshooting-using-bdobb.md`** in full (only the Settings and App Data section survives):

```markdown
---
type: Note
tags: [bdobb, help, troubleshooting, using-bdobb]
---

# Troubleshooting: Using BDOBB

Symptom-first index of issues you hit while using the BDOBB app itself.

## Settings and App Data

**I renamed/reinstalled the app and my dashboards are gone.**
See [[app-data-and-settings|App Data and Settings]] — most likely your data is sitting under an old bundle identifier's folder, not actually deleted.

---
*Sources: Adventures in OpenBB, Episode 3.*
```

- [ ] **Step 6: Edit `v3.0.0/Interface/layout-and-navigation.md`** — in the `## Website-card widgets` section, replace:
```
Some widget types are simply embedded pages — a backend-served HTML document shown inside a card, the same mechanism a browser iframe uses. This is how widgets like the [[news-ticker|news ticker]] are rendered without needing a bespoke integration: if a backend can serve a page, BDOBB can embed it.
```
with:
```
Some widget types are simply embedded pages — a backend-served HTML document shown inside a card, the same mechanism a browser iframe uses. If a backend can serve a page, BDOBB can embed it without needing a bespoke integration.
```
and in `## Degraded states`, replace:
```
- **A widget receives malformed or unexpected data** — you get a raw view of what actually arrived (see [[importing-dashboards|Importing Dashboards]]), never a blank card.
```
with:
```
- **A widget receives malformed or unexpected data** — you get a raw view of what actually arrived, never a blank card.
```

- [ ] **Step 7: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v3.0.0`
Expected: `v3.0.0: 4 pages, all wikilinks and images resolve.`

Fix any reported broken link, then re-run.

- [ ] **Step 8: Commit**

```bash
git add v3.0.0
git commit -m "content: v3.0.0 snapshot (Ep. 3 only — earliest version)"
```

---

### Task 8: `v4.0.0/` snapshot (verbatim copy of v3.0.0)

**Files:**
- Create: `/Users/artcashin/Developer/bdobb-help/v4.0.0/` (identical to `v3.0.0/`)

Episode 4 is a development-process retrospective, not help content — nothing user-facing shipped between v3.0.0 and v4.0.0 that belongs in this vault.

- [ ] **Step 1: Copy v3.0.0 verbatim**

```bash
cd /Users/artcashin/Developer/bdobb-help
cp -R v3.0.0 v4.0.0
```

- [ ] **Step 2: Update the copied `about-this-guide.md`'s citation line to reflect both versions apply**

In `v4.0.0/troubleshooting-using-bdobb.md`, the footer already just says "Episode 3" — leave it as is; nothing about the content differs at v4.

- [ ] **Step 3: Run the verifier**

Run: `node scripts/verify-snapshot.mjs v4.0.0`
Expected: `v4.0.0: 4 pages, all wikilinks and images resolve.`

- [ ] **Step 4: Commit**

```bash
git add v4.0.0
git commit -m "content: v4.0.0 snapshot (identical to v3.0.0 — Ep. 4 has no help content)"
```

---

### Task 9: Push `bdobb-help` to GitHub

**Files:** none (repo operation only)

- [ ] **Step 1: Create the repo on GitHub**

```bash
cd /Users/artcashin/Developer/bdobb-help
gh repo create artcashin/bdobb-help --public --source=. --remote=origin --description "Source content for BDOBB's in-app Help window"
```

- [ ] **Step 2: Push**

```bash
git push -u origin main
```

- [ ] **Step 3: Verify**

Run: `gh repo view artcashin/bdobb-help --json url,visibility`
Expected: `visibility: "PUBLIC"`, url set — confirms the repo is live and reachable for Phase 2's fetch step (and for GitHub Actions in future release builds).

---

## Phase 2 — bdobb fetch/convert pipeline

All Phase 2 and 3 file paths are relative to `/Users/artcashin/Developer/bdobb-help-system` (the isolated worktree).

### Task 10: `resolveVersionDir` — exact-match version folder resolution

**Files:**
- Create: `scripts/help/resolveVersionDir.mjs`
- Test: `scripts/help/resolveVersionDir.test.mjs`

**Interfaces:**
- Produces: `resolveVersionDir(cacheDir: string, version: string): string` — returns the absolute path to `<cacheDir>/v<version>`, throws `Error` if it doesn't exist.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVersionDir } from "./resolveVersionDir.mjs";

describe("resolveVersionDir", () => {
  it("returns the path when an exact version folder exists", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bdobb-help-test-"));
    mkdirSync(join(cacheDir, "v9.0.0"));
    try {
      expect(resolveVersionDir(cacheDir, "9.0.0")).toBe(join(cacheDir, "v9.0.0"));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("throws when no folder matches the version exactly", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bdobb-help-test-"));
    mkdirSync(join(cacheDir, "v8.0.0"));
    try {
      expect(() => resolveVersionDir(cacheDir, "9.0.0")).toThrow(
        /no bdobb-help snapshot for v9\.0\.0/
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/help/resolveVersionDir.test.mjs`
Expected: FAIL — `Cannot find module './resolveVersionDir.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves the exact version folder inside a cloned bdobb-help checkout.
 * Throws if no folder matches the version exactly — no "closest lower
 * version" fallback, so a missing snapshot fails the build instead of
 * silently shipping the wrong version's docs.
 */
export function resolveVersionDir(cacheDir, version) {
  const candidate = join(cacheDir, `v${version}`);
  if (!existsSync(candidate)) {
    throw new Error(
      `[fetch-help-content] no bdobb-help snapshot for v${version} ` +
        `(looked for ${candidate}). Create that folder in the bdobb-help repo before releasing this version.`
    );
  }
  return candidate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/help/resolveVersionDir.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/help/resolveVersionDir.mjs scripts/help/resolveVersionDir.test.mjs
git commit -m "feat: add resolveVersionDir for exact-match help content lookup"
```

---

### Task 11: `rewriteWikilinks` — Tolaria wikilinks → internal `help://` links

**Files:**
- Create: `scripts/help/wikilinks.mjs`
- Test: `scripts/help/wikilinks.test.mjs`

**Interfaces:**
- Produces: `rewriteWikilinks(markdown: string, knownSlugs: Set<string>): string` — throws `Error` on any `[[slug]]` whose slug isn't in `knownSlugs`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from "vitest";
import { rewriteWikilinks } from "./wikilinks.mjs";

describe("rewriteWikilinks", () => {
  it("rewrites a plain wikilink to a help:// link using the slug as label", () => {
    const known = new Set(["news-ticker"]);
    expect(rewriteWikilinks("See [[news-ticker]] for details.", known)).toBe(
      "See [news-ticker](help://news-ticker) for details."
    );
  });

  it("rewrites a piped wikilink using the custom display text", () => {
    const known = new Set(["news-ticker"]);
    expect(rewriteWikilinks("See [[news-ticker|News Ticker]] for details.", known)).toBe(
      "See [News Ticker](help://news-ticker) for details."
    );
  });

  it("throws when the target slug isn't in this version's page set", () => {
    const known = new Set(["news-ticker"]);
    expect(() => rewriteWikilinks("See [[live-quotes]].", known)).toThrow(
      /Unresolved wikilink \[\[live-quotes\]\]/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/help/wikilinks.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
const WIKILINK_RE = /\[\[([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Rewrites Tolaria [[slug]] / [[slug|text]] wikilinks to standard markdown
 * links against an internal help:// scheme, which the Help window's link
 * handler intercepts for in-app navigation. Throws on any slug not present
 * in this version folder's page set — this is what catches a page that
 * still references a feature removed from an earlier (backward-stripped)
 * version snapshot.
 */
export function rewriteWikilinks(markdown, knownSlugs) {
  return markdown.replace(WIKILINK_RE, (match, slug, text) => {
    if (!knownSlugs.has(slug)) {
      throw new Error(
        `Unresolved wikilink [[${slug}]] — no page with that slug in this version folder.`
      );
    }
    const label = text ?? slug;
    return `[${label}](help://${slug})`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/help/wikilinks.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/help/wikilinks.mjs scripts/help/wikilinks.test.mjs
git commit -m "feat: add rewriteWikilinks for internal help:// link scheme"
```

---

### Task 12: `rewriteImagePaths` — attachment paths → bundled asset paths

**Files:**
- Create: `scripts/help/images.mjs`
- Test: `scripts/help/images.test.mjs`

**Interfaces:**
- Produces: `rewriteImagePaths(markdown: string): string` — rewrites any `![alt](.../attachments/foo.png)` reference to `![alt](./assets/foo.png)`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from "vitest";
import { rewriteImagePaths } from "./images.mjs";

describe("rewriteImagePaths", () => {
  it("rewrites a sibling-relative attachment path", () => {
    expect(rewriteImagePaths("![the rail](../attachments/rail-hover.gif)")).toBe(
      "![the rail](./assets/rail-hover.gif)"
    );
  });

  it("rewrites a root-relative attachment path", () => {
    expect(rewriteImagePaths("![a screenshot](attachments/news-window.png)")).toBe(
      "![a screenshot](./assets/news-window.png)"
    );
  });

  it("leaves non-attachment images untouched", () => {
    expect(rewriteImagePaths("![external](https://example.com/x.png)")).toBe(
      "![external](https://example.com/x.png)"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/help/images.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
const IMAGE_RE = /!\[([^\]]*)\]\((\.{0,2}\/?attachments\/[^)]+)\)/g;

/**
 * Rewrites attachment-relative image paths (however deep the source page
 * sits — "../attachments/x.png" or "attachments/x.png") to the flat
 * ./assets/ layout the conversion step copies attachments into.
 */
export function rewriteImagePaths(markdown) {
  return markdown.replace(IMAGE_RE, (match, alt, path) => {
    const filename = path.split("/").pop();
    return `![${alt}](./assets/${filename})`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/help/images.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/help/images.mjs scripts/help/images.test.mjs
git commit -m "feat: add rewriteImagePaths for bundled asset layout"
```

---

### Task 13: `extractTitle` and `stripFrontmatter`

**Files:**
- Create: `scripts/help/title.mjs`
- Create: `scripts/help/frontmatter.mjs`
- Test: `scripts/help/title.test.mjs`
- Test: `scripts/help/frontmatter.test.mjs`

**Interfaces:**
- Produces: `extractTitle(markdown: string): string` — first H1 text, throws if none found.
- Produces: `stripFrontmatter(markdown: string): { tags: string[], body: string }` — parses the `tags: [a, b, c]` line out of YAML frontmatter; returns `{ tags: [], body: markdown }` unchanged if there's no frontmatter block.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/help/title.test.mjs
import { describe, it, expect } from "vitest";
import { extractTitle } from "./title.mjs";

describe("extractTitle", () => {
  it("extracts the first H1", () => {
    expect(extractTitle("# News Ticker\n\nSome body text.")).toBe("News Ticker");
  });

  it("throws when there's no H1", () => {
    expect(() => extractTitle("Just a paragraph, no heading.")).toThrow(
      /No H1 title found/
    );
  });
});
```

```javascript
// scripts/help/frontmatter.test.mjs
import { describe, it, expect } from "vitest";
import { stripFrontmatter } from "./frontmatter.mjs";

describe("stripFrontmatter", () => {
  it("extracts tags and strips the frontmatter block", () => {
    const input = `---
type: Note
tags: [bdobb, help, widgets, news-ticker]
---

# News Ticker

Body text.`;
    const result = stripFrontmatter(input);
    expect(result.tags).toEqual(["bdobb", "help", "widgets", "news-ticker"]);
    expect(result.body).toBe("# News Ticker\n\nBody text.");
  });

  it("returns the markdown unchanged when there is no frontmatter", () => {
    const input = "# Just a page\n\nNo frontmatter here.";
    expect(stripFrontmatter(input)).toEqual({ tags: [], body: input });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run scripts/help/title.test.mjs scripts/help/frontmatter.test.mjs`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementations**

```javascript
// scripts/help/title.mjs
/** Returns the first H1's text — matches Tolaria's own title convention. */
export function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) throw new Error("No H1 title found in page.");
  return match[1].trim();
}
```

```javascript
// scripts/help/frontmatter.mjs
/**
 * Minimal frontmatter parser — only extracts what the conversion step
 * needs (the tags array), avoiding a YAML dependency for one field,
 * matching this repo's existing generate-capabilities.mjs style.
 */
export function stripFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { tags: [], body: markdown };
  const [, front, body] = match;
  const tagsLine = front.split("\n").find((l) => l.startsWith("tags:"));
  let tags = [];
  if (tagsLine) {
    const inner = tagsLine.slice(tagsLine.indexOf("[") + 1, tagsLine.indexOf("]"));
    tags = inner
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return { tags, body: body.trim() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/help/title.test.mjs scripts/help/frontmatter.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/help/title.mjs scripts/help/title.test.mjs scripts/help/frontmatter.mjs scripts/help/frontmatter.test.mjs
git commit -m "feat: add extractTitle and stripFrontmatter conversion helpers"
```

---

### Task 14: `convertVersionFolder` — orchestrator

**Files:**
- Create: `scripts/help/convert.mjs`
- Test: `scripts/help/convert.test.mjs`
- Test fixture: `scripts/help/__fixtures__/sample-version/home.md`
- Test fixture: `scripts/help/__fixtures__/sample-version/Widgets/news-ticker.md`
- Test fixture: `scripts/help/__fixtures__/sample-version/attachments/example.png`

**Interfaces:**
- Consumes: `rewriteWikilinks` (Task 11), `rewriteImagePaths` (Task 12), `extractTitle`/`stripFrontmatter` (Task 13).
- Produces: `convertVersionFolder(versionDir: string, outDir: string): Array<{slug, title, tags, category, content}>`. Writes `<outDir>/<slug>.md`, `<outDir>/assets/*`, `<outDir>/nav.json`, `<outDir>/search-index.json`.

- [ ] **Step 1: Add the `minisearch` dependency**

```bash
pnpm add minisearch
```

- [ ] **Step 2: Create fixture files**

`scripts/help/__fixtures__/sample-version/home.md`:
```markdown
---
type: Note
tags: [bdobb, help, home]
---

# Sample Help

- [[news-ticker|News Ticker]] — the wire
```

`scripts/help/__fixtures__/sample-version/Widgets/news-ticker.md`:
```markdown
---
type: Note
tags: [bdobb, help, widgets, news-ticker]
---

# News Ticker

The wire. ![a shot](../attachments/example.png)
```

`scripts/help/__fixtures__/sample-version/attachments/example.png` — a 1x1 placeholder PNG (any valid tiny PNG binary works; content is never inspected by the conversion step).

- [ ] **Step 3: Write the failing test**

```javascript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertVersionFolder } from "./convert.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "__fixtures__/sample-version");

describe("convertVersionFolder", () => {
  let outDir;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "bdobb-help-convert-test-"));
    convertVersionFolder(fixtureDir, outDir);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a converted page per markdown file", () => {
    expect(existsSync(join(outDir, "home.md"))).toBe(true);
    expect(existsSync(join(outDir, "news-ticker.md"))).toBe(true);
  });

  it("rewrites the wikilink and image path in the converted content", () => {
    const content = readFileSync(join(outDir, "home.md"), "utf8");
    expect(content).toContain("[News Ticker](help://news-ticker)");

    const ticker = readFileSync(join(outDir, "news-ticker.md"), "utf8");
    expect(ticker).toContain("![a shot](./assets/example.png)");
  });

  it("copies attachments into assets/", () => {
    expect(existsSync(join(outDir, "assets/example.png"))).toBe(true);
  });

  it("writes a nav tree grouping pages by their source folder", () => {
    const nav = JSON.parse(readFileSync(join(outDir, "nav.json"), "utf8"));
    expect(nav.Widgets).toEqual([{ slug: "news-ticker", title: "News Ticker" }]);
  });

  it("writes a search index covering every page", () => {
    const index = JSON.parse(readFileSync(join(outDir, "search-index.json"), "utf8"));
    expect(index).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run scripts/help/convert.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 5: Write the implementation**

```javascript
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, relative, extname, basename } from "node:path";
import MiniSearch from "minisearch";
import { rewriteWikilinks } from "./wikilinks.mjs";
import { rewriteImagePaths } from "./images.mjs";
import { extractTitle } from "./title.mjs";
import { stripFrontmatter } from "./frontmatter.mjs";

function walkMarkdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "attachments" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkMarkdownFiles(full));
    } else if (extname(entry) === ".md") {
      out.push(full);
    }
  }
  return out;
}

/**
 * Converts one bdobb-help version folder into the flat bundle the Help
 * window consumes: per-page markdown with wikilinks/images rewritten, a
 * nav tree grouped by source subfolder, and a MiniSearch index.
 */
export function convertVersionFolder(versionDir, outDir) {
  const files = walkMarkdownFiles(versionDir);
  const slugOf = (filePath) => basename(filePath, ".md");
  const knownSlugs = new Set(files.map(slugOf));

  const pages = files.map((filePath) => {
    const raw = readFileSync(filePath, "utf8");
    const { tags, body } = stripFrontmatter(raw);
    const withLinks = rewriteWikilinks(body, knownSlugs);
    const withImages = rewriteImagePaths(withLinks);
    const title = extractTitle(withImages);
    const rel = relative(versionDir, filePath);
    const category = rel.includes("/") ? rel.split("/")[0] : null;
    return { slug: slugOf(filePath), title, tags, category, content: withImages };
  });

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });

  const attachmentsDir = join(versionDir, "attachments");
  try {
    for (const file of readdirSync(attachmentsDir)) {
      copyFileSync(join(attachmentsDir, file), join(outDir, "assets", file));
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  for (const page of pages) {
    writeFileSync(join(outDir, `${page.slug}.md`), page.content, "utf8");
  }

  const nav = pages
    .filter((p) => p.slug !== "home")
    .reduce((tree, p) => {
      const key = p.category ?? "General";
      (tree[key] ??= []).push({ slug: p.slug, title: p.title });
      return tree;
    }, {});
  writeFileSync(join(outDir, "nav.json"), JSON.stringify(nav, null, 2), "utf8");

  const miniSearch = new MiniSearch({
    fields: ["title", "tags", "content"],
    storeFields: ["title", "slug"],
  });
  miniSearch.addAll(
    pages.map((p) => ({
      id: p.slug,
      title: p.title,
      tags: p.tags.join(" "),
      content: p.content,
    }))
  );
  writeFileSync(join(outDir, "search-index.json"), JSON.stringify(miniSearch), "utf8");

  return pages;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run scripts/help/convert.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/help/convert.mjs scripts/help/convert.test.mjs scripts/help/__fixtures__
git commit -m "feat: add convertVersionFolder orchestrator"
```

---

### Task 15: `fetch-help-content.mjs` and build wiring

**Files:**
- Create: `scripts/fetch-help-content.mjs`
- Modify: `package.json` (scripts, `.gitignore`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `resolveVersionDir` (Task 10), `convertVersionFolder` (Task 14).
- Produces: `src/help/generated/` — the bundle Phase 3's frontend imports from.

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// Fetches the bdobb-help content repo, resolves the version folder matching
// this package's own version, and converts it into src/help/generated/ for
// Vite to bundle. Wired into `pnpm dev` / `pnpm build`, same pattern as
// generate-capabilities.mjs.
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveVersionDir } from "./help/resolveVersionDir.mjs";
import { convertVersionFolder } from "./help/convert.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

const REPO_URL = "https://github.com/artcashin/bdobb-help.git";
const cacheDir = resolve(root, ".help-cache");
const outDir = resolve(root, "src/help/generated");

function fetchRepo() {
  if (existsSync(resolve(cacheDir, ".git"))) {
    execFileSync("git", ["-C", cacheDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
    execFileSync("git", ["-C", cacheDir, "reset", "--hard", "origin/main", "--quiet"], {
      stdio: "inherit",
    });
  } else {
    mkdirSync(cacheDir, { recursive: true });
    execFileSync("git", ["clone", "--quiet", REPO_URL, cacheDir], { stdio: "inherit" });
  }
}

fetchRepo();

const versionDir = resolveVersionDir(cacheDir, version);

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

convertVersionFolder(versionDir, outDir);

console.log(`[fetch-help-content] bundled help content for v${version} from ${versionDir}`);
```

- [ ] **Step 2: Wire into `package.json`'s `dev` and `build` scripts**

Modify the `"scripts"` block:
```json
    "dev": "node scripts/generate-capabilities.mjs && node scripts/fetch-help-content.mjs && vite",
    "build": "node scripts/generate-capabilities.mjs && node scripts/fetch-help-content.mjs && tsc && vite build",
```
and add a standalone entry for manual runs, alongside the existing `capabilities` line:
```json
    "help:fetch": "node scripts/fetch-help-content.mjs",
```

- [ ] **Step 3: Gitignore the cache and generated output**

Add to `.gitignore`:
```
.help-cache/
src/help/generated/
```

- [ ] **Step 4: Run it end-to-end**

Run: `pnpm help:fetch`
Expected: clones `bdobb-help`, prints `[fetch-help-content] bundled help content for v9.0.0 from .../.help-cache/v9.0.0`, and `src/help/generated/` now contains 24 `.md` files, `assets/` (25 images), `nav.json`, `search-index.json`.

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `pnpm vitest run`
Expected: all existing tests plus the new Phase 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-help-content.mjs package.json .gitignore
git commit -m "feat: wire fetch-help-content into dev/build"
```

---

## Phase 3 — bdobb UI: native Help menu and window

### Task 16: Native Help menu and second Tauri window

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `help.html`
- Create: `src/help/main.tsx`
- Create: `src/help/HelpApp.tsx` (placeholder shell — filled in by Task 17)
- Modify: `vite.config.ts` (multi-entry build)
- Modify: `src-tauri/tauri.conf.json` (register the second window as hidden at startup)

**Interfaces:**
- Produces: a `help` menu event that shows/creates a webview window labeled `"help"` pointing at `help.html`.

- [ ] **Step 1: Add the second window to `tauri.conf.json`**, hidden at startup — the menu handler shows it:

```json
    "windows": [
      {
        "title": "BDOBB",
        "width": 1440,
        "height": 900,
        "minWidth": 1024,
        "minHeight": 700
      },
      {
        "label": "help",
        "title": "BDOBB Help",
        "url": "help.html",
        "width": 1000,
        "height": 720,
        "minWidth": 640,
        "minHeight": 480,
        "visible": false
      }
    ],
```

- [ ] **Step 2: Add the multi-page entry to `vite.config.ts`**

```typescript
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => ({
  envDir: mode === "test" ? path.resolve(__dirname, "./src/test/env") : undefined,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        help: path.resolve(__dirname, "help.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
}));
```

- [ ] **Step 3: Create `help.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>BDOBB Help</title>
  </head>

  <body>
    <div id="root"></div>
    <script type="module" src="/src/help/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `src/help/main.tsx`**

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import HelpApp from "./HelpApp";
import "../styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HelpApp />
  </React.StrictMode>
);
```

- [ ] **Step 5: Create a placeholder `src/help/HelpApp.tsx`** (Task 17 replaces this)

```typescript
export default function HelpApp() {
  return <div className="help-app">Loading…</div>;
}
```

- [ ] **Step 6: Add the Help menu to `src-tauri/src/lib.rs`**

Modify the `run()` function:

```rust
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![check_frameable])
        .setup(|app| {
            let help_item = MenuItem::with_id(app, "help_open", "BDOBB Help", true, None::<&str>)?;
            let help_menu = Submenu::with_items(app, "Help", true, &[&help_item])?;
            let menu = Menu::with_items(app, &[&help_menu])?;
            app.set_menu(menu)?;

            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id() == "help_open" {
                    if let Some(window) = handle.get_webview_window("help") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(The window is declared `"visible": false` in `tauri.conf.json` — it exists from launch, and the menu handler shows/focuses it rather than constructing it fresh each click, so repeated clicks never create duplicates.)

- [ ] **Step 7: Build and manually verify**

Run: `pnpm tauri dev`
Expected: BDOBB launches; a native "Help" menu appears in the menu bar (macOS: next to Window/View); clicking "BDOBB Help" opens a second window titled "BDOBB Help" showing "Loading…"; clicking it again focuses the same window rather than opening a new one.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json vite.config.ts help.html src/help/main.tsx src/help/HelpApp.tsx
git commit -m "feat: add native Help menu and second Tauri window"
```

---

### Task 17: Sidebar navigation

**Files:**
- Create: `src/help/HelpNav.tsx`
- Test: `src/help/HelpNav.test.tsx`
- Create: `src/help/loadContent.ts`
- Test: `src/help/loadContent.test.ts`

**Interfaces:**
- Produces: `loadNav(): Record<string, Array<{slug: string, title: string}>>` — reads the bundled `nav.json`.
- Produces: `<HelpNav nav={...} activeSlug={...} onSelect={(slug: string) => void} />`.

- [ ] **Step 1: Write the failing test for `loadContent`**

```typescript
// src/help/loadContent.test.ts
import { describe, it, expect, vi } from "vitest";
import { loadNav } from "./loadContent";

vi.mock("./generated/nav.json", () => ({
  default: { Widgets: [{ slug: "news-ticker", title: "News Ticker" }] },
}));

describe("loadNav", () => {
  it("returns the bundled nav tree", () => {
    expect(loadNav()).toEqual({ Widgets: [{ slug: "news-ticker", title: "News Ticker" }] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/help/loadContent.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `loadContent.ts`**

```typescript
import navData from "./generated/nav.json";

export type NavTree = Record<string, Array<{ slug: string; title: string }>>;

/** Reads the version-specific nav tree bundled by scripts/fetch-help-content.mjs. */
export function loadNav(): NavTree {
  return navData as NavTree;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/help/loadContent.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `HelpNav`**

```typescript
// src/help/HelpNav.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpNav from "./HelpNav";

describe("HelpNav", () => {
  const nav = {
    Widgets: [
      { slug: "news-ticker", title: "News Ticker" },
      { slug: "ai-chat", title: "AI Chat" },
    ],
  };

  it("renders each category and its pages", () => {
    render(<HelpNav nav={nav} activeSlug="news-ticker" onSelect={() => {}} />);
    expect(screen.getByText("Widgets")).toBeInTheDocument();
    expect(screen.getByText("News Ticker")).toBeInTheDocument();
    expect(screen.getByText("AI Chat")).toBeInTheDocument();
  });

  it("calls onSelect with the page's slug when clicked", () => {
    const onSelect = vi.fn();
    render(<HelpNav nav={nav} activeSlug="news-ticker" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("AI Chat"));
    expect(onSelect).toHaveBeenCalledWith("ai-chat");
  });

  it("marks the active page", () => {
    render(<HelpNav nav={nav} activeSlug="news-ticker" onSelect={() => {}} />);
    expect(screen.getByText("News Ticker").closest("button")).toHaveClass("active");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run src/help/HelpNav.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 7: Write `HelpNav.tsx`**

```typescript
import type { NavTree } from "./loadContent";

interface HelpNavProps {
  nav: NavTree;
  activeSlug: string | null;
  onSelect: (slug: string) => void;
}

export default function HelpNav({ nav, activeSlug, onSelect }: HelpNavProps) {
  return (
    <nav className="help-nav">
      {Object.entries(nav).map(([category, pages]) => (
        <div key={category} className="help-nav-category">
          <h3>{category}</h3>
          <ul>
            {pages.map((page) => (
              <li key={page.slug}>
                <button
                  className={page.slug === activeSlug ? "active" : ""}
                  onClick={() => onSelect(page.slug)}
                >
                  {page.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run src/help/HelpNav.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add src/help/loadContent.ts src/help/loadContent.test.ts src/help/HelpNav.tsx src/help/HelpNav.test.tsx
git commit -m "feat: add Help window sidebar navigation"
```

---

### Task 18: Content pane — markdown rendering with internal link handling

**Files:**
- Create: `src/help/HelpContent.tsx`
- Test: `src/help/HelpContent.test.tsx`
- Modify: `src/help/loadContent.ts` (add `loadPage`)
- Test: `src/help/loadContent.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new from earlier tasks besides `react-markdown` (existing dependency) and the `ExternalLink`-style pattern from `src/components/renderers/MarkdownRenderer.tsx`.
- Produces: `loadPage(slug: string): string` — reads a bundled page's markdown by slug. `<HelpContent slug={...} onNavigate={(slug: string) => void} />`.

- [ ] **Step 1: Add `remark-gfm`**

```bash
pnpm add remark-gfm
```

- [ ] **Step 2: Extend the failing test for `loadContent`**

```typescript
// add to src/help/loadContent.test.ts
import { loadPage } from "./loadContent";

vi.mock("./generated/news-ticker.md?raw", () => ({
  default: "# News Ticker\n\nThe wire.",
}));

describe("loadPage", () => {
  it("returns the bundled markdown for a given slug", () => {
    expect(loadPage("news-ticker")).toBe("# News Ticker\n\nThe wire.");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/help/loadContent.test.ts`
Expected: FAIL — `loadPage` not exported

- [ ] **Step 4: Add `loadPage` to `loadContent.ts`**

Vite's `?raw` import suffix pulls a file's contents as a plain string at build time — exactly what's needed for markdown bundled by the conversion step. Since the slug is dynamic, use `import.meta.glob` with `eager: true` and `query: "?raw"` to pull every generated page in at once:

```typescript
import navData from "./generated/nav.json";

export type NavTree = Record<string, Array<{ slug: string; title: string }>>;

export function loadNav(): NavTree {
  return navData as NavTree;
}

const pages = import.meta.glob("./generated/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Returns the bundled markdown for a page by slug, e.g. "news-ticker". */
export function loadPage(slug: string): string {
  const entry = pages[`./generated/${slug}.md`];
  if (!entry) throw new Error(`No bundled help page for slug "${slug}"`);
  return entry;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/help/loadContent.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the failing test for `HelpContent`**

```typescript
// src/help/HelpContent.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpContent from "./HelpContent";

vi.mock("./loadContent", () => ({
  loadPage: (slug: string) =>
    slug === "news-ticker"
      ? "# News Ticker\n\nSee [Live Quotes](help://live-quotes) for the tape."
      : "# Live Quotes\n\nThe tape.",
}));

describe("HelpContent", () => {
  it("renders the page's markdown", () => {
    render(<HelpContent slug="news-ticker" onNavigate={() => {}} />);
    expect(screen.getByRole("heading", { name: "News Ticker" })).toBeInTheDocument();
  });

  it("intercepts help:// links and calls onNavigate instead of following them", () => {
    const onNavigate = vi.fn();
    render(<HelpContent slug="news-ticker" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Live Quotes"));
    expect(onNavigate).toHaveBeenCalledWith("live-quotes");
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/help/HelpContent.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 8: Write `HelpContent.tsx`**

Following the existing `ExternalLink` pattern in `src/components/renderers/MarkdownRenderer.tsx` (external links open via the system browser under Tauri), extended so a `help://` link navigates within the window instead:

```typescript
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { loadPage } from "./loadContent";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface HelpContentProps {
  slug: string;
  onNavigate: (slug: string) => void;
}

export default function HelpContent({ slug, onNavigate }: HelpContentProps) {
  const markdown = loadPage(slug);

  const HelpLink: Components["a"] = ({ href, children, ...rest }) => {
    if (href?.startsWith("help://")) {
      const targetSlug = href.slice("help://".length);
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(targetSlug);
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }
    const handleExternalClick = (): void => {
      if (!href || !isTauri()) return;
      import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(href))
        .catch(() => {});
    };
    return (
      <a
        href={href}
        onClick={(e) => {
          if (href && isTauri()) e.preventDefault();
          handleExternalClick();
        }}
        {...rest}
      >
        {children}
      </a>
    );
  };

  return (
    <div className="help-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: HelpLink }}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm vitest run src/help/HelpContent.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 10: Commit**

```bash
git add src/help/HelpContent.tsx src/help/HelpContent.test.tsx src/help/loadContent.ts src/help/loadContent.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add Help window content pane with internal link navigation"
```

---

### Task 19: Search box

**Files:**
- Create: `src/help/HelpSearch.tsx`
- Test: `src/help/HelpSearch.test.tsx`
- Modify: `src/help/loadContent.ts` (add `loadSearchIndex`)
- Test: `src/help/loadContent.test.ts` (extend)

**Interfaces:**
- Produces: `loadSearchIndex(): MiniSearch` — rehydrates the bundled index. `<HelpSearch onSelect={(slug: string) => void} />`.

- [ ] **Step 1: Extend the failing test for `loadContent`**

```typescript
// add to src/help/loadContent.test.ts
import { loadSearchIndex } from "./loadContent";

describe("loadSearchIndex", () => {
  it("returns a MiniSearch instance that can search bundled pages", () => {
    const index = loadSearchIndex();
    expect(typeof index.search).toBe("function");
  });
});
```

(This test runs against the real bundled `search-index.json` — run `pnpm help:fetch` first if it hasn't been run yet in this checkout, same as any other test relying on generated content.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/help/loadContent.test.ts`
Expected: FAIL — `loadSearchIndex` not exported

- [ ] **Step 3: Add `loadSearchIndex` to `loadContent.ts`**

```typescript
import MiniSearch from "minisearch";
import searchIndexData from "./generated/search-index.json";

// ...(loadNav, loadPage unchanged above)...

/** Rehydrates the search index bundled by scripts/fetch-help-content.mjs. */
export function loadSearchIndex(): MiniSearch {
  return MiniSearch.loadJS(searchIndexData, {
    fields: ["title", "tags", "content"],
    storeFields: ["title", "slug"],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/help/loadContent.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for `HelpSearch`**

```typescript
// src/help/HelpSearch.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpSearch from "./HelpSearch";

const mockResults = [{ id: "news-ticker", title: "News Ticker", slug: "news-ticker" }];

vi.mock("./loadContent", () => ({
  loadSearchIndex: () => ({
    search: vi.fn(() => mockResults),
  }),
}));

describe("HelpSearch", () => {
  it("shows matching results as you type", () => {
    render(<HelpSearch onSelect={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ticker" } });
    expect(screen.getByText("News Ticker")).toBeInTheDocument();
  });

  it("calls onSelect with the result's slug when clicked", () => {
    const onSelect = vi.fn();
    render(<HelpSearch onSelect={onSelect} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ticker" } });
    fireEvent.click(screen.getByText("News Ticker"));
    expect(onSelect).toHaveBeenCalledWith("news-ticker");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run src/help/HelpSearch.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 7: Write `HelpSearch.tsx`**

```typescript
import { useMemo, useState } from "react";
import { loadSearchIndex } from "./loadContent";

interface HelpSearchProps {
  onSelect: (slug: string) => void;
}

export default function HelpSearch({ onSelect }: HelpSearchProps) {
  const index = useMemo(() => loadSearchIndex(), []);
  const [query, setQuery] = useState("");

  const results = query.trim() ? index.search(query) : [];

  return (
    <div className="help-search">
      <input
        role="searchbox"
        type="search"
        placeholder="Search help…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="help-search-results">
          {results.map((r) => (
            <li key={r.id}>
              <button onClick={() => onSelect(r.slug)}>{r.title}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run src/help/HelpSearch.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add src/help/HelpSearch.tsx src/help/HelpSearch.test.tsx src/help/loadContent.ts src/help/loadContent.test.ts
git commit -m "feat: add Help window search"
```

---

### Task 20: Wire `HelpApp` together, style, and smoke test

**Files:**
- Modify: `src/help/HelpApp.tsx` (replace the Task 16 placeholder)
- Test: `src/help/HelpApp.test.tsx`
- Modify: `src/styles.css` (add `.help-*` styles using existing tokens)

**Interfaces:**
- Consumes: `loadNav` (Task 17), `HelpNav` (Task 17), `HelpContent` (Task 18), `HelpSearch` (Task 19).

- [ ] **Step 1: Write the failing test**

```typescript
// src/help/HelpApp.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import HelpApp from "./HelpApp";

vi.mock("./loadContent", () => ({
  loadNav: () => ({
    Widgets: [
      { slug: "news-ticker", title: "News Ticker" },
      { slug: "ai-chat", title: "AI Chat" },
    ],
  }),
  loadPage: (slug: string) => `# ${slug === "news-ticker" ? "News Ticker" : "AI Chat"}\n\nBody.`,
  loadSearchIndex: () => ({ search: () => [] }),
}));

describe("HelpApp", () => {
  it("shows the first nav page by default", () => {
    render(<HelpApp />);
    expect(screen.getByRole("heading", { name: "News Ticker" })).toBeInTheDocument();
  });

  it("navigates when a sidebar item is clicked", () => {
    render(<HelpApp />);
    fireEvent.click(screen.getByText("AI Chat"));
    expect(screen.getByRole("heading", { name: "AI Chat" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/help/HelpApp.test.tsx`
Expected: FAIL — current placeholder doesn't render nav or content

- [ ] **Step 3: Write `HelpApp.tsx`**

```typescript
import { useState } from "react";
import HelpNav from "./HelpNav";
import HelpContent from "./HelpContent";
import HelpSearch from "./HelpSearch";
import { loadNav } from "./loadContent";

function firstSlug(nav: ReturnType<typeof loadNav>): string | null {
  const firstCategory = Object.values(nav)[0];
  return firstCategory?.[0]?.slug ?? null;
}

export default function HelpApp() {
  const nav = loadNav();
  const [activeSlug, setActiveSlug] = useState<string | null>(firstSlug(nav));

  return (
    <div className="help-app">
      <aside className="help-sidebar">
        <HelpSearch onSelect={setActiveSlug} />
        <HelpNav nav={nav} activeSlug={activeSlug} onSelect={setActiveSlug} />
      </aside>
      <main className="help-main">
        {activeSlug ? (
          <HelpContent slug={activeSlug} onNavigate={setActiveSlug} />
        ) : (
          <p>No help content available for this version.</p>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/help/HelpApp.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Add styles using existing tokens**

Append to `src/styles.css`:

```css
.help-app {
  display: flex;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
}

.help-sidebar {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
  padding: 12px;
  overflow-y: auto;
}

.help-nav-category h3 {
  color: var(--text-dim);
  font-size: 12px;
  text-transform: uppercase;
  margin: 16px 0 4px;
}

.help-nav button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.help-nav button.active {
  background: var(--bg-card);
  color: var(--accent);
}

.help-search input {
  width: 100%;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 4px;
  padding: 6px 8px;
}

.help-search-results {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}

.help-main {
  flex: 1;
  overflow-y: auto;
  padding: 32px;
}

.help-content img {
  max-width: 100%;
}
```

- [ ] **Step 6: Run the full test suite**

Run: `pnpm vitest run`
Expected: all tests PASS, including every test added in Tasks 10–20.

- [ ] **Step 7: Manual end-to-end smoke test**

Run: `pnpm tauri dev`

Checklist:
- Help menu → "BDOBB Help" opens the second window.
- Sidebar shows all categories/pages from `v9.0.0`'s nav (Getting Started, Interface, Widgets, Configuration, Integrations, iPad App).
- Clicking a sidebar item loads that page's content, including a rendered image (e.g. `news-ticker`'s screenshots) and a GFM table (e.g. `backends-and-connections`).
- Clicking an in-content wikilink (e.g. `live-quotes` → EODHD Data Provider) navigates within the window and updates the sidebar's active state.
- Typing in search surfaces matching pages; clicking a result navigates to it.
- Closing and reopening via the Help menu shows the same window (not a duplicate), retaining no state is fine (fresh load is expected).

- [ ] **Step 8: Commit**

```bash
git add src/help/HelpApp.tsx src/help/HelpApp.test.tsx src/styles.css
git commit -m "feat: wire up Help window UI end to end"
```

---

## Self-Review

**Spec coverage:**
- Content repo, full-snapshot version folders (v3–v9) — Tasks 2–9. ✓
- Public GitHub repo — Task 9. ✓
- Fetch/convert pipeline, exact-version hard error — Tasks 10, 14, 15. ✓
- Wikilink/image/frontmatter conversion, search index, nav tree — Tasks 11–14. ✓
- Native Help menu, dedicated window, no main-app store coupling — Task 16. ✓
- Sidebar + content + search UI, styled with existing tokens — Tasks 17–20. ✓
- Local dev fetch mechanism matching CI — Task 15 (`pnpm dev`/`pnpm build` both run it). ✓
- Testing section's fixture-based coverage for the pipeline and UI — present in every code task; the spec's "known gap" (only v9.0.0 exercised by a real build) is inherent to this session's scope and called out again in Task 20's smoke test, which only exercises v9.0.0. ✓

**Placeholder scan:** no TBD/TODO; every code step has complete code; every content task has an exact file manifest and exact edit text rather than "trim as appropriate."

**Type consistency:** `NavTree` (Task 17) is used identically in `HelpNav`, `HelpApp`. `loadNav`/`loadPage`/`loadSearchIndex` (Tasks 17–19) are the exact names `HelpApp` imports in Task 20. `rewriteWikilinks`/`rewriteImagePaths`/`extractTitle`/`stripFrontmatter` (Tasks 11–13) are the exact names `convert.mjs` imports in Task 14. `resolveVersionDir` (Task 10) is the exact name `fetch-help-content.mjs` imports in Task 15.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-06-embedded-help-system.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
