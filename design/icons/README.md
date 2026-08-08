# BDOBB app icon candidates

Four icon candidates for BDOBB, designed 2026-08-07. Each is a full-bleed
1024×1024 SVG master with the mark held inside a ~78% safe zone, so the
macOS/iPadOS corner masks never clip it. Palette is the app's own:
LED green `#3dff8a`, accent blue `#4f8cc9`, near-black navy base.
`bdobb-icon-candidates.html` is a self-contained review page showing each
candidate through the macOS / Windows / iPadOS masks and at 64/32/16 px.

| File | Candidate | Concept |
|---|---|---|
| `candidate-a-tape-b.svg` | A · "Segment B" | LED-segment B (Clock-widget typeface spirit) over a blue ticker tape. Strongest 16 px silhouette. |
| `candidate-b-candles.svg` | B · "The Tape" | Three rising candlesticks, blue → glowing green, with a green signal line. Most self-describing. |
| `candidate-c-bar-b.svg` | C · "Data-bar B" | The B built from horizontal data bars, blue base grading to LED green. Watch the 8-vs-B read at 16 px. |
| `candidate-d-terminal.svg` | D · "The Widget" | Blue widget-card frame holding a green LED stairstep sparkline — the app's own thesis in one picture. Designer's first choice. |

## Producing the real icon set from a chosen candidate

1. Export the chosen SVG to a 1024×1024 PNG (opaque — iPadOS requires no
   transparency; these masters are opaque by design).
2. Run `pnpm tauri icon <path-to-png>` — this generates `icon.icns` (macOS),
   `icon.ico` (Windows, 16–256 px), the Linux PNG ladder, and the iOS
   AppIcon set for the Ep. 7 iPadOS build, into `src-tauri/icons/`.
3. Hand-check the generated 16 px slice on Windows. If it muddies, rasterize
   a simplified small-size variant and splice it into the `.ico`
   (ICO files carry independent images per size).
