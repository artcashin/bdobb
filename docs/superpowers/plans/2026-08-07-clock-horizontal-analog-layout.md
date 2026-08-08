# Clock Horizontal Analog Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Horizontal (analog)" layout option to the Clock widget: a scrolling row of analog wall-clock faces, one per configured time zone, captioned with city / region / GMT offset in decreasing type size — alongside the existing vertical digital-list layout, which stays the default and is otherwise untouched.

**Architecture:** A new standalone `AnalogFace` SVG component computes hour/minute hand angles from numbers already available in `ClockRenderer`'s zone data. `ClockRenderer` gains a `layout` prop that branches to either the existing vertical JSX tree or a new horizontal gallery of `AnalogFace` tiles. A new "Layout" widget param (`builtins.ts`) exposes the choice in the card's settings panel, wired through `WidgetCard.tsx` exactly like the existing `face`/`hour12` params.

**Tech Stack:** React + TypeScript, inline SVG (no chart/canvas library), Vitest + Testing Library, existing CSS custom-property theme (`--text`, `--text-dim`).

## Global Constraints

- No second hand on the analog face, and no numerals — 12 plain batons only. (Spec: "What ships" item 2.)
- The face is a fixed traditional white/black design regardless of app theme — no dark-mode variant. (Spec: "Out of scope.")
- Overflow is horizontal scroll only — tiles never wrap to a second row. (Spec: "What ships" item 3.)
- Default `layout` is `"vertical"`; every existing saved dashboard card must render identically to before this change with no prop passed. (Spec: "What ships" item 1.)
- The vertical/digital code path in `ClockRenderer.tsx` must not be modified — only a new branch is added alongside it.
- Hand angles derive from the existing `hh`/`mm` string fields already computed in `rows` (parsed and mod-12'd) — no new `Intl.DateTimeFormat` calls. (Spec: "Interfaces touched" → `AnalogFace`.)

---

### Task 1: `AnalogFace` component

**Files:**
- Create: `src/components/renderers/AnalogFace.tsx`
- Test: `src/components/renderers/AnalogFace.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (standalone).
- Produces: `export default function AnalogFace({ hour, minute }: { hour: number; minute: number }): JSX.Element` — an SVG with `className="analog-face"`, a `rect.analog-hand-hour` and a `rect.analog-hand-minute` each carrying a `transform="rotate(<deg> 50 50)"` attribute, and exactly 12 top-level `<rect>` batons plus the two hand rects (14 `rect`s total). Task 2 imports this component and passes it `hour`/`minute` as plain numbers (any int, including values ≥ 12 — the component itself takes `hour % 12`).

- [ ] **Step 1: Write the failing tests**

  Create `src/components/renderers/AnalogFace.test.tsx`:

  ```tsx
  import { render } from "@testing-library/react";
  import { describe, expect, it } from "vitest";
  import AnalogFace from "./AnalogFace";

  describe("AnalogFace", () => {
    it("points the hour hand to the hour-plus-fraction angle", () => {
      // 15:30 -> hour%12 = 3, +30/60 = 3.5 -> 3.5 * 30 = 105deg.
      const { container } = render(<AnalogFace hour={15} minute={30} />);
      expect(container.querySelector(".analog-hand-hour")).toHaveAttribute(
        "transform",
        "rotate(105 50 50)"
      );
    });

    it("points the minute hand to minute * 6 degrees", () => {
      const { container } = render(<AnalogFace hour={15} minute={30} />);
      expect(container.querySelector(".analog-hand-minute")).toHaveAttribute(
        "transform",
        "rotate(180 50 50)"
      );
    });

    it("treats a 24-hour value the same as its 12-hour equivalent", () => {
      // 15:00 and 3:00 must point the hour hand identically.
      const { container: c24 } = render(<AnalogFace hour={15} minute={0} />);
      const { container: c12 } = render(<AnalogFace hour={3} minute={0} />);
      expect(c24.querySelector(".analog-hand-hour")).toHaveAttribute(
        "transform",
        c12.querySelector(".analog-hand-hour")!.getAttribute("transform")!
      );
    });

    it("draws 12 unmarked batons and no numerals", () => {
      const { container } = render(<AnalogFace hour={0} minute={0} />);
      expect(container.querySelectorAll("rect")).toHaveLength(14); // 12 batons + 2 hands
      expect(container.querySelector("text")).toBeNull();
    });

    it("draws no second hand", () => {
      const { container } = render(<AnalogFace hour={0} minute={0} />);
      expect(container.querySelector('[class*="second"]')).toBeNull();
    });

    it("is aria-hidden, since the tile around it carries the spoken time", () => {
      const { container } = render(<AnalogFace hour={0} minute={0} />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });
  });
  ```

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/components/renderers/AnalogFace.test.tsx`
  Expected: FAIL — `Cannot find module './AnalogFace'` (the component doesn't exist yet).

- [ ] **Step 3: Implement `AnalogFace`**

  Create `src/components/renderers/AnalogFace.tsx`:

  ```tsx
  interface AnalogFaceProps {
    /** 0-23 (or 1-12 under a 12-hour display) — only hour % 12 affects the hand. */
    hour: number;
    minute: number;
  }

  const BATON_ANGLES = Array.from({ length: 12 }, (_, i) => i * 30);

  /**
   * A plain analog wall-clock face: 12 unmarked batons, hour and minute
   * hands, no numerals, no second hand. Deliberately generic railway-clock
   * styling, not a reproduction of any specific trademarked design.
   */
  export default function AnalogFace({ hour, minute }: AnalogFaceProps) {
    const hourAngle = ((hour % 12) + minute / 60) * 30;
    const minuteAngle = minute * 6;

    return (
      <svg className="analog-face" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="48" fill="#fff" stroke="#1a1a1a" strokeWidth="2" />
        {BATON_ANGLES.map((angle) => (
          <rect
            key={angle}
            x="48.5"
            y="4"
            width="3"
            height="10"
            rx="1"
            fill="#1a1a1a"
            transform={`rotate(${angle} 50 50)`}
          />
        ))}
        <rect
          className="analog-hand-hour"
          x="48"
          y="22"
          width="4"
          height="28"
          rx="2"
          fill="#1a1a1a"
          transform={`rotate(${hourAngle} 50 50)`}
        />
        <rect
          className="analog-hand-minute"
          x="48.75"
          y="10"
          width="2.5"
          height="40"
          rx="1.25"
          fill="#1a1a1a"
          transform={`rotate(${minuteAngle} 50 50)`}
        />
        <circle cx="50" cy="50" r="3" fill="#1a1a1a" />
      </svg>
    );
  }
  ```

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/components/renderers/AnalogFace.test.tsx`
  Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/renderers/AnalogFace.tsx src/components/renderers/AnalogFace.test.tsx
  git commit -m "feat(clock): add AnalogFace SVG component

  A plain analog wall-clock face — 12 unmarked batons, hour and minute
  hands, no numerals, no second hand — for the Clock widget's upcoming
  horizontal layout."
  ```

---

### Task 2: `ClockRenderer` horizontal layout

**Files:**
- Modify: `src/components/renderers/ClockRenderer.tsx`
- Modify: `src/components/renderers/ClockRenderer.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `AnalogFace` from Task 1 — `import AnalogFace from "./AnalogFace"`, called as `<AnalogFace hour={number} minute={number} />`.
- Produces: `ClockRendererProps.layout?: "vertical" | "horizontal"` (default `"vertical"`). Task 3's `WidgetCard.tsx` passes this prop through from the new widget param. Horizontal output uses classes `.clock-gallery`, `.clock-tile`, `.clock-tile-caption`, `.clock-tile-city`, `.clock-tile-region`, `.clock-tile-offset` — Task 3 does not touch these, listed here only so a later reader isn't surprised by new class names appearing in `styles.css`.

- [ ] **Step 1: Write the failing tests**

  Add to `src/components/renderers/ClockRenderer.test.tsx` (inside the existing top-level `describe("ClockRenderer", ...)` block, after the last existing `it(...)`):

  ```tsx
  it("defaults to the vertical digital list", () => {
    const { container } = render(<ClockRenderer zones={["UTC"]} />);
    expect(container.querySelector(".clock-list")).toBeInTheDocument();
    expect(container.querySelector(".clock-gallery")).toBeNull();
  });

  it("horizontal layout renders one analog tile per zone instead of digital rows", () => {
    const { container } = render(
      <ClockRenderer zones={["America/New_York", "Asia/Tokyo"]} layout="horizontal" />
    );
    expect(container.querySelectorAll(".clock-tile")).toHaveLength(2);
    expect(container.querySelector(".clock-time")).toBeNull();
    expect(container.querySelector(".clock-list")).toBeNull();
    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(screen.getByText("US/Eastern")).toBeInTheDocument();
    expect(screen.getByText("GMT-4")).toBeInTheDocument();
  });

  it("horizontal layout labels each tile with the spoken time for screen readers", () => {
    // 15:30 UTC, per the fixed system time this suite sets in beforeEach.
    const { container } = render(<ClockRenderer zones={["UTC"]} layout="horizontal" />);
    expect(container.querySelector(".clock-tile")).toHaveAttribute(
      "aria-label",
      "UTC, 15:30, UTC, GMT+0"
    );
  });

  it("horizontal layout still reports an invalid zone", () => {
    const { container } = render(
      <ClockRenderer zones={["America/New_York", "Mars/Olympus"]} layout="horizontal" />
    );
    expect(container.querySelectorAll(".clock-tile")).toHaveLength(1);
    expect(container.querySelector(".clock-invalid")).toHaveTextContent(
      "Unknown time zone: Mars/Olympus"
    );
  });
  ```

  This suite's `beforeEach` already sets `vi.setSystemTime(new Date("2026-08-01T15:30:00Z"))` and imports `render`/`screen` — no new imports needed.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/components/renderers/ClockRenderer.test.tsx`
  Expected: FAIL on all four new tests — `layout` prop doesn't exist yet, so `container.querySelector(".clock-gallery")` etc. never match and the "defaults to vertical" test's negative assertion happens to pass, but the three horizontal tests fail because no `.clock-tile` is ever rendered.

- [ ] **Step 3: Implement the horizontal branch**

  In `src/components/renderers/ClockRenderer.tsx`:

  Add the import at the top of the file, after the existing `useEffect, useMemo, useState` import:

  ```tsx
  import AnalogFace from "./AnalogFace";
  ```

  Extend `ClockRendererProps` (currently `zones`, `hour12?`, `face?`):

  ```tsx
  interface ClockRendererProps {
    /** IANA zone names, in display order. */
    zones: string[];
    /** 12-hour, suffixed with a bare A or P, instead of 24-hour. */
    hour12?: boolean;
    /** "dots" for the matrix face, "solid" for the filled one. */
    face?: "dots" | "solid";
    /** "vertical" for the digital list (default), "horizontal" for analog tiles. */
    layout?: "vertical" | "horizontal";
  }
  ```

  Update the function signature to destructure and default the new prop:

  ```tsx
  export default function ClockRenderer({
    zones,
    hour12 = false,
    face = "dots",
    layout = "vertical",
  }: ClockRendererProps) {
  ```

  Immediately after the existing empty-state block —

  ```tsx
  if (rows.length === 0) {
    return <div className="renderer-empty">No valid time zones set for this card.</div>;
  }
  ```

  — and before the existing `return (<div className="clock-list" ...)`, insert the new branch:

  ```tsx
  if (layout === "horizontal") {
    return (
      <div className="clock-gallery" aria-live="off">
        {rows.map((r) => {
          const hourNum = parseInt(r.hh, 10) % 12;
          const minuteNum = parseInt(r.mm, 10);
          return (
            <div
              className="clock-tile"
              key={r.zone}
              aria-label={`${r.city}, ${r.hh}:${r.mm}, ${r.label}, ${r.offset}`}
            >
              <AnalogFace hour={hourNum} minute={minuteNum} />
              <div className="clock-tile-caption">
                <span className="clock-tile-city">{r.city}</span>
                <span className="clock-tile-region">{r.label}</span>
                <span className="clock-tile-offset">{r.offset}</span>
              </div>
            </div>
          );
        })}
        {invalid.length > 0 && (
          <div className="clock-invalid">Unknown time zone: {invalid.join(", ")}</div>
        )}
      </div>
    );
  }
  ```

  The existing vertical `return` block below this stays completely unchanged.

  Then add the new styles to `src/styles.css`, immediately after the existing `.clock-invalid { ... }` rule (the last line of the clock block, before `.note-view`):

  ```css
  /* Horizontal layout: a scrolling row of analog clock tiles. */
  .clock-gallery {
    height: 100%;
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 12px 16px;
    overflow-x: auto;
  }

  .clock-tile {
    flex: 0 0 auto;
    width: 96px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .analog-face { width: 80px; height: 80px; flex: none; }

  .clock-tile-caption {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    line-height: 1.3;
    max-width: 96px;
  }

  .clock-tile-city {
    font-size: 14px; font-weight: 600; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%;
  }
  .clock-tile-region { font-size: 11px; color: var(--text-dim); opacity: 0.85; }
  .clock-tile-offset {
    font-size: 9px; color: var(--text-dim); opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  ```

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/components/renderers/ClockRenderer.test.tsx`
  Expected: PASS (all previously-existing tests plus the 4 new ones — the full file, not just the new cases, since this task edits shared code).

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/renderers/ClockRenderer.tsx src/components/renderers/ClockRenderer.test.tsx src/styles.css
  git commit -m "feat(clock): add horizontal analog layout to ClockRenderer

  New layout prop (\"vertical\" default | \"horizontal\") branches to a
  scrolling row of AnalogFace tiles captioned city/region/GMT-offset,
  instead of the digital list. Vertical path is untouched."
  ```

---

### Task 3: Widget config wiring

**Files:**
- Modify: `src/lib/builtins.ts`
- Modify: `src/lib/builtins.test.ts`
- Modify: `src/components/WidgetCard.tsx`

**Interfaces:**
- Consumes: `ClockRendererProps.layout` from Task 2 (the `<ClockRenderer>` call in `WidgetCard.tsx` gains a `layout` prop).
- Produces: `CLOCK_LAYOUT_PARAM = "layout"` exported from `builtins.ts`, and a "Layout" entry in `BUILTIN_CLOCK_ID`'s `params` array with `options: [{ value: "vertical" }, { value: "horizontal" }]` and default `value: "vertical"`. Nothing downstream of this task.

- [ ] **Step 1: Write the failing tests**

  Add to `src/lib/builtins.test.ts` (new top-level `describe`, after the existing `describe("Symphony built-in", ...)` block):

  ```typescript
  import {
    BUILTIN_CLOCK_ID,
    CLOCK_LAYOUT_PARAM,
    CLOCK_FACE_PARAM,
  } from "./builtins";

  describe("Clock built-in", () => {
    it("declares a layout param defaulting to vertical", () => {
      const widget = findBuiltin(BUILTIN_CLOCK_ID)!;
      const layout = widget.params.find((p) => p.paramName === CLOCK_LAYOUT_PARAM)!;
      expect(layout).toBeDefined();
      expect(layout.value).toBe("vertical");
      expect(layout.options).toEqual([
        { label: "Vertical (digital list)", value: "vertical" },
        { label: "Horizontal (analog)", value: "horizontal" },
      ]);
    });

    it("notes on the Typeface param that it only applies to the vertical layout", () => {
      const widget = findBuiltin(BUILTIN_CLOCK_ID)!;
      const face = widget.params.find((p) => p.paramName === CLOCK_FACE_PARAM)!;
      expect(face.description).toMatch(/only applies to the vertical layout/i);
    });
  });
  ```

  Add the three new names (`BUILTIN_CLOCK_ID`, `CLOCK_LAYOUT_PARAM`, `CLOCK_FACE_PARAM`) to this test file's existing top import from `"./builtins"` rather than as a second import statement, if you're editing by hand rather than pasting the block above verbatim.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/lib/builtins.test.ts`
  Expected: FAIL — `CLOCK_LAYOUT_PARAM` is not exported yet, and the Typeface description doesn't yet mention "vertical layout".

- [ ] **Step 3: Add the param**

  In `src/lib/builtins.ts`, add the new constant directly below the existing `export const CLOCK_FACE_PARAM = "face";`:

  ```typescript
  /** "vertical" for the digital list, "horizontal" for a row of analog faces. */
  export const CLOCK_LAYOUT_PARAM = "layout";
  ```

  In the `BUILTIN_CLOCK_ID` widget definition's `params` array, insert a new entry immediately after the `CLOCK_ZONES_PARAM` entry and before the `CLOCK_CYCLE_PARAM` entry:

  ```typescript
  param({
    paramName: CLOCK_LAYOUT_PARAM,
    label: "Layout",
    description:
      "Vertical stacks a digital list; horizontal shows analog wall-clock " +
      "faces in a row.",
    value: "vertical",
    options: [
      { label: "Vertical (digital list)", value: "vertical" },
      { label: "Horizontal (analog)", value: "horizontal" },
    ],
  }),
  ```

  Update the existing `CLOCK_FACE_PARAM` entry's `description` (currently `"The matrix face needs roughly 32px to read as dots on a non-HiDPI display."`) to end with the new clause:

  ```typescript
  description:
    "The matrix face needs roughly 32px to read as dots on a non-HiDPI " +
    "display. Only applies to the Vertical layout.",
  ```

- [ ] **Step 4: Wire it through `WidgetCard.tsx`**

  In `src/components/WidgetCard.tsx`, add `CLOCK_LAYOUT_PARAM` to the existing import from `"../lib/builtins"` (alongside `CLOCK_FACE_PARAM` and the other `CLOCK_*` names already imported there).

  In the `BUILTIN_CLOCK_ID` branch, the existing call:

  ```tsx
  <ClockRenderer
    zones={raw.split(",").map((z) => z.trim()).filter(Boolean)}
    hour12={hour12}
    face={fetchParams[CLOCK_FACE_PARAM] === "solid" ? "solid" : "dots"}
  />
  ```

  gains one more prop:

  ```tsx
  <ClockRenderer
    zones={raw.split(",").map((z) => z.trim()).filter(Boolean)}
    hour12={hour12}
    face={fetchParams[CLOCK_FACE_PARAM] === "solid" ? "solid" : "dots"}
    layout={fetchParams[CLOCK_LAYOUT_PARAM] === "horizontal" ? "horizontal" : "vertical"}
  />
  ```

- [ ] **Step 5: Run the tests and confirm they pass**

  Run: `npx vitest run src/lib/builtins.test.ts`
  Expected: PASS (all Symphony tests plus the 2 new Clock tests).

  Then run the full suite once to confirm nothing else broke:

  Run: `npx vitest run`
  Expected: PASS, no failures.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/builtins.ts src/lib/builtins.test.ts src/components/WidgetCard.tsx
  git commit -m "feat(clock): expose Layout param for horizontal analog view

  New \"Layout\" widget param (vertical default | horizontal) wired
  through WidgetCard into ClockRenderer. Typeface's description now
  notes it only applies to the vertical layout, since ParamDef has no
  conditional-visibility mechanism to hide it under horizontal."
  ```

---

## Self-Review Notes

- **Spec coverage:** every "What ships" item (1–6) maps to a task — layout prop/default (Task 2), `AnalogFace` visuals and no-second-hand/no-numerals constraints (Task 1), gallery/scroll and tile caption (Task 2), accessibility `aria-label` (Task 2), config param (Task 3). "Out of scope" items are not implemented anywhere in this plan, as intended.
- **Type consistency:** `layout?: "vertical" | "horizontal"` is defined once in Task 2 and consumed verbatim (same union, same prop name) in Task 3's `WidgetCard.tsx` edit. `AnalogFace`'s `{ hour, minute }: number` signature from Task 1 matches the `hourNum`/`minuteNum` values Task 2 passes in.
- **No placeholders:** every step has complete, copy-pasteable code; no "add tests for the above" or "similar to Task N" shorthand.
