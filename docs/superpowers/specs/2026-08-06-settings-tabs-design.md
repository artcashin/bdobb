# Tabbed Settings dialog

**Date:** 2026-08-06 · **Status:** Approved (Art, 2026-08-06)

## Goal

The Settings dialog stacks five sections in one scrolling modal — Rita
Configuration, MCP Servers, "Send chat to…", Appearance, Log. Finding
anything means scrolling past everything else, and the file has grown to
460 lines. Split the sections into four tabs and give each tab its own
component.

## Tabs

| Tab | Contains (from today's sections) |
|---|---|
| **Rita** | Rita URL field, context-sharing toggle, **and** the "Send chat to…" share targets |
| **MCP** | MCP server list, add-server field, tool-budget check |
| **Appearance** | The theme row |
| **Logs** | Log path, log tail viewer, Reload button, load errors |

"Send chat to…" moves under Rita (Art's call): sending a conversation is a
Rita concern, and it leaves four tabs instead of five.

Appearance is deliberately thin — `Settings.theme` is the literal type
`"dark"` and `persistence.ts` rejects any other value, so the tab holds one
informational row until light theme lands. Keeping it as its own tab is the
approved choice.

## Behavior

- Tabs are client-side state only. No routing, no persistence of the active
  tab: the dialog always opens on **Rita**.
- The single **Save Settings** button stays in the modal footer and saves
  every tab's changes. Switching tabs must never discard an edit made in
  another tab — draft state stays lifted in `SettingsDialog`, so a tab
  component unmounting cannot lose it.
- **Cancel** keeps its current meaning: close without saving, discarding the
  whole draft across all tabs.
- The `loadError` banner concerns the settings file as a whole, so it stays
  above the tab strip, visible on every tab.
- Tab-specific transient state that is not part of the saved draft (the MCP
  budget-check result, the log tail and its error) may live in the tab
  component. Re-running the check or reloading the log on remount is
  acceptable; losing an unsaved *setting* is not.

## Files

`SettingsDialog.tsx` keeps the modal, the tab strip, the draft state, the
save/cancel handlers, and the `loadError` banner. Each tab's markup moves
to its own component under `src/components/dialogs/settings/`:

- `RitaTab.tsx` — Rita URL, context sharing, share targets
- `McpTab.tsx` — server list, add field, budget check
- `AppearanceTab.tsx` — theme row
- `LogsTab.tsx` — path, tail, reload

Tabs receive the draft and its updater as props; they do not read or write
the settings store directly. This keeps save semantics in one place and each
tab independently testable.

## Accessibility

A real tablist, not styled buttons:

- container `role="tablist"` with an accessible name
- each tab `role="tab"`, `aria-selected`, `aria-controls` pointing at its panel,
  and `tabIndex` following the roving-tabindex convention (`0` for the active
  tab, `-1` for the rest)
- the panel `role="tabpanel"` with `aria-labelledby` pointing back at its tab
- Left/Right arrows move between tabs and activate; Home/End jump to first/last

Ids are generated with `useId()`, as the dialog already does for its fields.

## Testing

- **Dialog tests**: the four tabs render; Rita is active on open; clicking a
  tab swaps the panel; **an edit made on one tab survives switching to
  another and back, and is included in the save payload** (the regression this
  design most risks); the `loadError` banner shows regardless of active tab;
  arrow-key navigation moves between tabs; `aria-selected` tracks the active
  tab.
- **Per-tab tests**: each tab component renders its own controls and calls its
  updater — the existing SettingsDialog test cases move to the tab that now
  owns them, rather than being rewritten.
- Hermetic: stores and `lib/logger` mocked, as the existing dialog tests do.

## Out of scope

- Any change to what a setting means, its validation, or the saved schema.
- Light theme.
- Persisting the active tab across dialog openings.
- The Rita pane's pin affordance (raised separately; the pin works, it is just
  hard to find).
