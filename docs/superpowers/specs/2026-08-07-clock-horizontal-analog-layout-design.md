# Clock widget: horizontal analog layout

**Date:** 2026-08-07 · **Status:** Approved (Art, 2026-08-07)

## Goal

The Clock widget currently has one layout: a vertical list of rows, each
showing a zone as digital LED-style text (city · offset/zone meta · HH:MM).
Add a second layout option — a horizontal row of analog wall-clock faces,
one per zone, with the city, region and GMT offset captioned underneath in
decreasing type size.

## What ships

1. **A new `layout` prop on `ClockRenderer`**, `"vertical" | "horizontal"`,
   defaulting to `"vertical"`. The existing vertical/digital code path is
   untouched — every saved dashboard keeps rendering exactly as it does
   today.
2. **A new `AnalogFace` component** (own file, `renderers/AnalogFace.tsx`):
   a small SVG clock face taking just `{ hour, minute }`. Traditional white
   face, thin dark border, 12 plain rectangular batons around the rim (no
   numerals), black hour and minute hands, no second hand.

   The baton-ring styling deliberately evokes railway-clock minimalism
   without reproducing an actual Swiss railway clock: proportions aren't
   copied from the real design, and — since there's no second hand at all —
   the single most recognizable and design-protected element of that clock
   (the red lollipop second hand) is absent by construction, not by a
   defensive tweak.

   Hand angles come from data `ClockRenderer` already computes (`hh`/`mm`
   strings), parsed and taken mod 12 — an analog face is inherently 12-hour
   and doesn't care about the widget's `hour12` display setting or AM/PM. No
   new `Intl` calls are needed.
3. **A horizontal gallery** (`.clock-gallery`): a flex row of `.clock-tile`
   elements, one per zone, `overflow-x: auto` — extra zones scroll
   sideways rather than wrapping to a second row.
4. **Each tile:** the `AnalogFace` on top, then a three-line caption below
   it, reusing fields already present in `rows`:
   - City (largest, e.g. "New York")
   - Region — the existing zone-alias label (e.g. "US/Eastern"), smaller
   - GMT offset (e.g. "GMT-4"), smallest and most muted
5. **Accessibility:** each tile carries an `aria-label` with the spoken
   equivalent (city, HH:MM, region, offset). The `AnalogFace` SVG itself is
   `aria-hidden` — the hands convey nothing to a screen reader that the
   tile's label doesn't already say, unlike the vertical layout's plain
   digital text which is inherently readable.
6. **Config wiring:** a new "Layout" param on the Clock widget definition,
   defaulting to Vertical, so existing cards are unaffected.

## Interfaces touched

### `src/components/renderers/AnalogFace.tsx` (new file)

```tsx
interface AnalogFaceProps {
  /** 0-23 (or 1-12 under a 12-hour format) — only hour % 12 affects the hand. */
  hour: number;
  minute: number;
}

const BATON_ANGLES = Array.from({ length: 12 }, (_, i) => i * 30);

/**
 * A plain analog wall-clock face: 12 unmarked batons, hour and minute hands,
 * no numerals, no second hand. Deliberately generic railway-clock styling —
 * not a reproduction of any specific trademarked design.
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
          x="48.5" y="4" width="3" height="10" rx="1"
          fill="#1a1a1a"
          transform={`rotate(${angle} 50 50)`}
        />
      ))}
      <rect
        className="analog-hand-hour"
        x="48" y="22" width="4" height="28" rx="2"
        fill="#1a1a1a"
        transform={`rotate(${hourAngle} 50 50)`}
      />
      <rect
        className="analog-hand-minute"
        x="48.75" y="10" width="2.5" height="40" rx="1.25"
        fill="#1a1a1a"
        transform={`rotate(${minuteAngle} 50 50)`}
      />
      <circle cx="50" cy="50" r="3" fill="#1a1a1a" />
    </svg>
  );
}
```

Hands are drawn pointing up (12 o'clock, angle 0) and rotated clockwise
around the face center — standard SVG `rotate(deg, cx, cy)` semantics
already match clock-hand direction, no sign flip needed.

### `src/components/renderers/ClockRenderer.tsx`

- `ClockRendererProps` gains:
  ```typescript
  /** "vertical" for the digital list (default), "horizontal" for analog tiles. */
  layout?: "vertical" | "horizontal";
  ```
- Import `AnalogFace` from `./AnalogFace`.
- New branch, inserted after the existing `rows.length === 0` empty-state
  check and before the current `return (<div className="clock-list" ...)`:
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
- The existing vertical `return` is otherwise unchanged, including its own
  `invalid.length > 0` block — the horizontal branch duplicates that block
  rather than sharing it, since the two branches now return fully separate
  trees and forcing a shared tail would cost more than the four duplicated
  lines.

### `src/lib/builtins.ts`

- New constant, alongside the other `CLOCK_*_PARAM` exports:
  ```typescript
  /** "vertical" for the digital list, "horizontal" for a row of analog faces. */
  export const CLOCK_LAYOUT_PARAM = "layout";
  ```
- New param in `BUILTIN_CLOCK_ID`'s `params`, inserted right after the
  `CLOCK_ZONES_PARAM` entry:
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
- The existing `CLOCK_FACE_PARAM` ("Typeface") description gains a trailing
  clause: `" Only applies to the Vertical layout."` — `ParamDef` has no
  conditional-visibility mechanism (no `dependsOn` or similar), so the
  param stays visible but inert under Horizontal; the description is the
  minimal honest fix rather than adding a visibility system for one field.

### `src/components/WidgetCard.tsx`

- Import `CLOCK_LAYOUT_PARAM` alongside the other clock param imports.
- The `BUILTIN_CLOCK_ID` branch's `<ClockRenderer>` call gains:
  ```tsx
  layout={fetchParams[CLOCK_LAYOUT_PARAM] === "horizontal" ? "horizontal" : "vertical"}
  ```
  matching the existing ternary pattern already used for `face`.

### `src/styles.css`

Alongside the existing clock rules:

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

Sizes follow the existing `.clock-city`/`.clock-meta` hierarchy in spirit
(city largest and boldest, offset smallest and most muted) but are new,
smaller values sized for an 80px face rather than the 26px-line-height
digital row.

## Testing

`src/components/renderers/AnalogFace.test.tsx` (new):

- hour/minute hand `transform` attributes match the expected angle,
  including the fractional hour-hand creep (e.g. 15:30 → hour hand at
  `rotate(105 50 50)`, minute hand at `rotate(180 50 50)`)
- the face renders exactly 12 baton rects and no `<text>` element (no
  numerals)

`src/components/renderers/ClockRenderer.test.tsx` (additions):

- `layout="horizontal"` renders one `.clock-tile` per valid zone, no
  `.clock-time` and no `.clock-list` anywhere in the tree
- city, region and offset text are all present per tile (reusing the same
  zone fixtures and expected strings the existing vertical tests already
  assert)
- each tile's `aria-label` contains the zone's HH:MM
- omitting `layout` (and passing `layout="vertical"` explicitly) both still
  render `.clock-list` and never `.clock-gallery` — the default-behavior
  regression guard
- an invalid zone in horizontal layout still renders the `.clock-invalid`
  notice

All existing tests in this file are unmodified and must keep passing
unchanged, since the vertical path's code is untouched.

## Out of scope

- A second hand, or any smooth/sweeping motion — explicitly excluded per
  discussion.
- Numerals on the face, in any of 4-numeral or full 1–12 form.
- A dark/theme-matched face variant — the face is traditional white/black
  regardless of the dashboard's theme.
- Conditional param visibility (hiding "Typeface" when Layout is
  Horizontal) — `ParamDef` has no such mechanism; adding one is a separate,
  larger change with no other current use case.
- Wrap-to-next-row behavior for overflow — horizontal scroll only, per
  discussion.
- Per-tile size configuration, or a param to control face diameter.
- Any change to the legacy `timezone`/`hour12` fallback params, or to the
  offset/zone-alias computation — this feature only adds a rendering mode
  on top of data the widget already produces.
