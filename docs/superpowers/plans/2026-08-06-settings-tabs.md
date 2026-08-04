# Tabbed Settings Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Settings dialog's five stacked sections into four tabs (Rita, MCP, Appearance, Logs), each in its own component, without changing what any setting means or how saving works.

**Architecture:** `SettingsDialog.tsx` keeps the modal, the draft state, save/cancel, the `loadError` banner, and gains a `role="tablist"` strip. Each tab's markup moves to `src/components/dialogs/settings/<Name>Tab.tsx`, receiving the draft and its updater as props. Because the draft stays lifted, unmounting a tab cannot lose an unsaved edit.

**Tech Stack:** React 18, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-06-settings-tabs-design.md`

## Global Constraints

- Four tabs, in this order: **Rita**, **MCP**, **Appearance**, **Logs**. The dialog opens on Rita every time — the active tab is NOT persisted.
- Today's "Send chat to…" section belongs to the **Rita** tab.
- One **Save Settings** button in the modal footer saves every tab's changes. An edit on one tab must survive switching tabs. **Cancel** discards the whole draft.
- Draft state (`localSettings`) and the save/cancel handlers stay in `SettingsDialog.tsx`. Tab components receive the draft and an updater as props and must NOT read or write `useSettingsStore` themselves.
- Transient non-draft state (MCP budget-check result, log tail + its error) may live in the owning tab component.
- The `loadError` banner stays above the tab strip, visible on every tab.
- Accessibility: container `role="tablist"` with an accessible name; each tab `role="tab"` + `aria-selected` + `aria-controls`; roving tabindex (`0` active, `-1` others); panel `role="tabpanel"` + `aria-labelledby`; Left/Right arrows move and activate, Home/End jump to first/last. Ids from `useId()`.
- No change to any setting's meaning, validation, or saved schema. No light theme. No change to the Rita pane.
- Existing SettingsDialog test cases MOVE to the tab that now owns them rather than being rewritten or deleted.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Tab strip + tab shell, with sections moved verbatim

**Files:**
- Modify: `src/components/dialogs/SettingsDialog.tsx`
- Create: `src/components/dialogs/settings/RitaTab.tsx`, `McpTab.tsx`, `AppearanceTab.tsx`, `LogsTab.tsx`
- Modify: `src/components/dialogs/SettingsDialog.test.tsx`
- Modify: `src/styles.css` (tab strip styling)

**Interfaces:**
- Consumes: `Settings`, `ShareTarget`, `McpBudgetExceeded`, `McpUnreachable` from existing modules; `useSettingsStore`, `assembleTools`, `clearMcpCache`, `getLogPath`, `readLogTail`, `logError`, `isHttpUrl`, `defaultTemplate` exactly as `SettingsDialog.tsx` uses them today.
- Produces: four tab components. Each takes at minimum:
  - `RitaTab`: `{ settings: Settings; onChange: (patch: Partial<Settings>) => void; fieldIds: string }`
  - `McpTab`: same shape as RitaTab
  - `AppearanceTab`: `{ settings: Settings }`
  - `LogsTab`: `{}` (owns its own log state)
  Add props beyond these only if the moved markup genuinely needs them.

**Approach:** This is a move, not a rewrite. Cut each section's JSX and the handlers only it uses out of `SettingsDialog.tsx` and paste them into the tab component, changing only what the prop boundary forces (e.g. `localSettings` → `settings`, `setLocalSettings(...)` → `onChange(...)`). Do not redesign controls, re-word copy, or change validation.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/dialogs/SettingsDialog.test.tsx` (keep the existing tests; they will be moved in Task 2):

```typescript
  describe("tabs", () => {
    it("shows four tabs and opens on Rita", async () => {
      await renderOpen();
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Rita", "MCP", "Appearance", "Logs"]);
      expect(screen.getByRole("tab", { name: "Rita" })).toHaveAttribute("aria-selected", "true");
    });

    it("swaps the panel when another tab is clicked", async () => {
      await renderOpen();
      // The Rita URL field is on the Rita tab; MCP's add-server field is not.
      expect(screen.getByLabelText("Rita URL")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
      expect(screen.queryByLabelText("Rita URL")).not.toBeInTheDocument();
      expect(screen.getByLabelText("New MCP server URL")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    });

    it("keeps an edit made on one tab when another tab is visited", async () => {
      // The whole risk of this refactor: a tab unmounting must not drop a
      // draft edit, because Save writes the draft, not the DOM.
      await renderOpen();
      fireEvent.change(screen.getByLabelText("Rita URL"), {
        target: { value: "http://localhost:9999" },
      });
      fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
      fireEvent.click(screen.getByRole("tab", { name: "Rita" }));
      expect(screen.getByLabelText("Rita URL")).toHaveValue("http://localhost:9999");
    });

    it("saves an edit made on a tab that is not the active one", async () => {
      await renderOpen();
      fireEvent.change(screen.getByLabelText("Rita URL"), {
        target: { value: "http://localhost:9999" },
      });
      fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
      fireEvent.click(screen.getByText("Save Settings"));
      await waitFor(() =>
        expect(updateMock).toHaveBeenCalledWith(
          expect.objectContaining({ ritaUrl: "http://localhost:9999" })
        )
      );
    });

    it("moves between tabs with arrow keys", async () => {
      await renderOpen();
      const rita = screen.getByRole("tab", { name: "Rita" });
      rita.focus();
      fireEvent.keyDown(rita, { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(screen.getByRole("tab", { name: "MCP" }), { key: "End" });
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
    });

    it("shows the load-error banner on every tab", async () => {
      setStoreState({ loadError: "settings.json is corrupt" });
      await renderOpen();
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    });
  });
```

Verified against the current test file, so use these exact names: the helpers are `renderOpen()` and `setStoreState({ settings?, loadError? })`; the settings-store update mock is reached as `(useSettingsStore as any).__update`, NOT a bare `updateMock` — replace `updateMock` in the save test above with whatever local alias the file already uses for it (check how the existing save test asserts on it) . Add `waitFor` to the imports if absent. The Rita URL input already has a `<label htmlFor>` reading exactly `Rita URL` (SettingsDialog.tsx:224), so `getByLabelText("Rita URL")` works as written — do not add a second label.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/dialogs/SettingsDialog.test.tsx`
Expected: the six new tests FAIL (no elements with `role="tab"`); the pre-existing tests still pass.

- [ ] **Step 3: Create the four tab components**

Create `src/components/dialogs/settings/RitaTab.tsx`, moving the "Rita Configuration" section AND the "Send chat to…" section, plus the share-target handlers (`addShareTarget`, `updateShareTarget`, `removeShareTarget`) that only those sections use:

```tsx
import type { Settings } from "../../../lib/types";
import { defaultTemplate, type ShareTarget } from "../../../lib/chatShare";
import { isHttpUrl } from "../../../lib/safeUrl";

export interface RitaTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  fieldIds: string;
}

export default function RitaTab({ settings, onChange, fieldIds }: RitaTabProps) {
  // ... the two sections' JSX, moved verbatim, with:
  //   localSettings          -> settings
  //   setLocalSettings(fn)   -> onChange(patch)
  // Keep the <div className="settings-section"> wrappers and their <h3>
  // titles: within a tab they still label the groups ("Send chat to…"
  // remains a labelled group under Rita).
}
```

Create `McpTab.tsx` the same way for the "MCP Servers" section, moving `handleAddMcpServer`, `handleRemoveMcpServer`, `handleToggleMcpServer`, `checkMcpBudget`, and the `newMcpUrl` / `mcpChecking` / `mcpCheck` state into it (that state is transient, not part of the draft).

Create `AppearanceTab.tsx` for the theme row (props: `{ settings }`).

Create `LogsTab.tsx` for the Log section, moving `logPath`, `logLines`, `logLoadError`, `loadLog`, and the effect that calls it. The effect currently keys off `isOpen`; inside a tab that only mounts when selected, load on mount instead.

- [ ] **Step 4: Add the tab strip to SettingsDialog**

In `SettingsDialog.tsx`, keep `localSettings`, `handleSave`, the `loadError` banner, and the footer. Replace the five stacked sections with:

```tsx
  const TABS = [
    { id: "rita", label: "Rita" },
    { id: "mcp", label: "MCP" },
    { id: "appearance", label: "Appearance" },
    { id: "logs", label: "Logs" },
  ] as const;
  type TabId = (typeof TABS)[number]["id"];
  const [activeTab, setActiveTab] = useState<TabId>("rita");
```

Reset to `"rita"` whenever the dialog opens, in the existing `isOpen` effect, so a reopen never lands on a stale tab.

Render the strip and panel:

```tsx
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`${fieldIds}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={activeTab === t.id}
              aria-controls={`${fieldIds}-panel-${t.id}`}
              tabIndex={activeTab === t.id ? 0 : -1}
              className={`settings-tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight" ? (i + 1) % TABS.length
                  : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
                  : e.key === "Home" ? 0
                  : e.key === "End" ? TABS.length - 1
                  : null;
                if (next === null) return;
                e.preventDefault();
                setActiveTab(TABS[next].id);
                document.getElementById(`${fieldIds}-tab-${TABS[next].id}`)?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${fieldIds}-panel-${activeTab}`}
          aria-labelledby={`${fieldIds}-tab-${activeTab}`}
        >
          {activeTab === "rita" && (
            <RitaTab
              settings={localSettings}
              onChange={(patch) => setLocalSettings((prev) => ({ ...prev, ...patch }))}
              fieldIds={fieldIds}
            />
          )}
          {activeTab === "mcp" && (
            <McpTab
              settings={localSettings}
              onChange={(patch) => setLocalSettings((prev) => ({ ...prev, ...patch }))}
              fieldIds={fieldIds}
            />
          )}
          {activeTab === "appearance" && <AppearanceTab settings={localSettings} />}
          {activeTab === "logs" && <LogsTab />}
        </div>
```

- [ ] **Step 5: Style the tab strip**

In `src/styles.css`, beside the existing `.settings-section` rules, add a strip consistent with the app's existing chip/tab styling (see `.dash-tab` and `.widget-library-category-btn` for the house voice):

```css
/* Settings tab strip: a real tablist, styled like the dashboard tabs so the
   two read as the same control. */
.settings-tabs {
  display: flex; gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.settings-tab {
  padding: 6px 12px;
  background: none; border: none; border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--text-dim); font-size: 12px;
}
.settings-tab:hover { color: var(--text); border-color: var(--border); }
.settings-tab.active { color: var(--text); border-bottom-color: var(--accent); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/components/dialogs/SettingsDialog.test.tsx`
Expected: PASS — including the pre-existing tests. Pre-existing tests that query a control now on a non-default tab will fail until Task 2 moves them; if that happens, add the one-line tab click they need to keep them passing here and move them properly in Task 2.

- [ ] **Step 7: Full verification and commit**

Run: `pnpm typecheck && pnpm test:run`
Expected: clean; all tests pass.

```bash
git add src/components/dialogs/SettingsDialog.tsx src/components/dialogs/settings src/components/dialogs/SettingsDialog.test.tsx src/styles.css
git commit -m "feat: split the Settings dialog into Rita, MCP, Appearance and Logs tabs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Move the existing tests to their tabs

**Files:**
- Modify: `src/components/dialogs/SettingsDialog.test.tsx`
- Create: `src/components/dialogs/settings/RitaTab.test.tsx`, `McpTab.test.tsx`, `LogsTab.test.tsx`

**Interfaces:**
- Consumes: the four tab components from Task 1 and their prop shapes.
- Produces: nothing consumed later.

**Approach:** `SettingsDialog.test.tsx` keeps only what belongs to the dialog itself: the tab tests from Task 1, the save/cancel behavior, and the `loadError` banner. Every other existing case moves to the test file for the tab that now owns its controls, rendering that tab component directly with props instead of driving it through the dialog. Move the assertions verbatim; only the render setup changes.

- [ ] **Step 1: Inventory the existing cases**

Run: `pnpm vitest run src/components/dialogs/SettingsDialog.test.tsx --reporter=verbose`
Write down every test name and which tab's controls it touches. Each one must end up in exactly one file — none may be dropped.

- [ ] **Step 2: Create the per-tab test files**

For each tab, create its test file with a small render helper, e.g. for `RitaTab`:

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RitaTab from "./RitaTab";
import { DEFAULT_SETTINGS } from "../../../lib/persistence";

function renderTab(over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const onChange = vi.fn();
  render(
    <RitaTab settings={{ ...DEFAULT_SETTINGS, ...over }} onChange={onChange} fieldIds="t" />
  );
  return { onChange };
}
```

Mock the same modules the dialog test mocks (`../../../lib/agent/mcp`, `../../../lib/logger`, and the Tauri-backed log helpers) in the tab test files that need them — check the existing dialog test's `vi.mock` calls and carry over only the ones each tab actually requires.

Move each case into its file, adjusting only the render call and, where a test asserted `updateSettings` was called, asserting the tab's `onChange` was called with the same patch instead.

- [ ] **Step 3: Delete the moved cases from the dialog test**

Remove exactly the cases you moved. Confirm the count: every name from Step 1 appears in exactly one file now.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm typecheck && pnpm test:run`
Expected: clean; total test count is unchanged or higher than before Task 1 (nothing was silently dropped). State the before/after counts in your report.

- [ ] **Step 5: Commit**

```bash
git add src/components/dialogs
git commit -m "test: move Settings cases to the tab components that own them

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Verification gate

**Files:** none — verification only.

- [ ] **Step 1: Full check**

Run: `pnpm typecheck && pnpm test:run && pnpm build && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: all clean/green.

- [ ] **Step 2: Confirm nothing was lost in the move**

Grep the dialog and tab components together for every control that existed before: Rita URL input, context-sharing toggle, share-target add/edit/remove, MCP add/remove/toggle, budget check, theme row, log path, log tail, Reload log. Each must appear exactly once across the five files.

Run: `grep -rn "settings-section-title" src/components/dialogs/settings src/components/dialogs/SettingsDialog.tsx`
Expected: the section titles that existed before still exist, each in exactly one tab.
