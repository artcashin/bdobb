import Plotly from "plotly.js-dist-min";
import type { ColumnDef } from "./types";
import { buildFigureFromRecords, isPlotlyFigure, type PlotlyFigure } from "./chartShapes";

// ---- markdown -> Symphony MessageML ----
//
// MessageML is Symphony's constrained XML message format. This is a small,
// line-oriented converter -- not a general markdown parser -- covering the
// constructs a widget note realistically contains: headings, bold/italic,
// inline code, links, and bullet/numbered lists. Anything else passes
// through as escaped plain text, which is always valid MessageML even if it
// loses formatting.

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Private-Use-Area markers wrapping the href placeholder index below. They
// cannot occur in real input (nothing upstream of this function produces PUA
// codepoints), so a placeholder can never collide with ordinary text -- e.g.
// a literal digit elsewhere on the line -- the way a plain numeric token
// would.
const HREF_PLACEHOLDER_OPEN = "";
const HREF_PLACEHOLDER_CLOSE = "";
const HREF_PLACEHOLDER = new RegExp(
  `${HREF_PLACEHOLDER_OPEN}(\\d+)${HREF_PLACEHOLDER_CLOSE}`,
  "g"
);

/** Applies inline formatting to one already-escaped-safe line of text. */
function inlineToMessageML(rawLine: string): string {
  let t = escapeXml(rawLine);
  // Links first: the label may itself contain characters the later bold/
  // italic passes would otherwise misinterpret.
  // `t` is already escaped, so the captured url/label are too -- do not
  // escape them again (that would double-encode "&" to "&amp;amp;").
  //
  // The emitted href is protected behind a placeholder token so the
  // emphasis passes below never see it: `_`/`*` are completely ordinary in
  // URLs (Wikipedia titles, S3 keys, ticker slugs) and would otherwise be
  // read as emphasis markers, splicing <i>/<b> tags into an XML attribute
  // value and producing a message Symphony's parser rejects outright.
  //
  // A non-http(s) scheme (e.g. `javascript:`) is not turned into an anchor
  // at all -- the label is emitted as plain text instead.
  const hrefs: string[] = [];
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    if (!/^https?:/i.test(url)) return label;
    const token = `${HREF_PLACEHOLDER_OPEN}${hrefs.push(url) - 1}${HREF_PLACEHOLDER_CLOSE}`;
    return `<a href="${token}">${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/__([^_]+)__/g, "<b>$1</b>");
  // The opening delimiter must not be preceded by an alphanumeric (so
  // `snake_case_id` and `a*b*c` are left alone -- CommonMark suppresses
  // intraword emphasis for exactly this reason) and must not be followed by
  // whitespace (so "5 * 3 and 2 * 4" isn't read as emphasis either); the
  // closing delimiter mirrors that on the trailing side.
  t = t.replace(/(?<![A-Za-z0-9])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, "<i>$1</i>");
  t = t.replace(/(?<![A-Za-z0-9])_(?!\s)([^_]+?)(?<!\s)_(?!_)/g, "<i>$1</i>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  if (hrefs.length) t = t.replace(HREF_PLACEHOLDER, (_m, i: string) => hrefs[Number(i)]);
  return t;
}

/** Converts a markdown string into a `<messageML>` document. */
export function markdownToMessageML(markdown: string): string {
  const lines = (markdown ?? "").split(/\r?\n/);
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const ulItem = /^[-*]\s+(.*)$/.exec(line);
    const olItem = /^\d+\.\s+(.*)$/.exec(line);

    if (heading) {
      closeList();
      out.push(`<b>${inlineToMessageML(heading[1])}</b><br/>`);
      continue;
    }
    if (ulItem) {
      if (listTag !== "ul") {
        closeList();
        out.push("<ul>");
        listTag = "ul";
      }
      out.push(`<li>${inlineToMessageML(ulItem[1])}</li>`);
      continue;
    }
    if (olItem) {
      if (listTag !== "ol") {
        closeList();
        out.push("<ol>");
        listTag = "ol";
      }
      out.push(`<li>${inlineToMessageML(olItem[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`${inlineToMessageML(line)}<br/>`);
  }
  closeList();
  return `<messageML>${out.join("")}</messageML>`;
}

// ---- table rows -> CSV ----

// A cell starting with one of these opens a formula in Excel/Sheets when the
// recipient opens the attachment -- `=1+1`, `@SUM(A1)`, `+x`, `-x`. This is
// backend-controlled data landing in a third party's spreadsheet, so a
// leading quote neutralizes it the same way spreadsheet apps themselves
// recommend (RFC 4180 quoting, applied below, is unrelated and doesn't
// prevent this -- Excel treats a quoted `"=1+1"` cell as a formula too).
const FORMULA_TRIGGER = /^[=+\-@]/;

function csvEscape(value: string): string {
  const safe = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Serializes rows to CSV. Declared columns (headerName, order, visibility)
 * are honored when given, matching what the card's table view shows; values
 * are emitted as plain strings/numbers rather than through the on-screen
 * display formatter (thousands separators, "%", etc.), which a spreadsheet
 * or downstream tool would rather re-derive itself.
 */
export function rowsToCsv(
  rows: Record<string, unknown>[],
  columns?: ColumnDef[] | null
): string {
  if (rows.length === 0) return "";
  const declared = (columns ?? []).filter(
    (c): c is ColumnDef => c != null && typeof c.field === "string" && !c.hide
  );
  const cols: Pick<ColumnDef, "field" | "headerName">[] = declared.length
    ? declared
    : Object.keys(rows[0]).map((field) => ({ field }));

  const header = cols.map((c) => csvEscape(c.headerName || c.field));
  const body = rows.map((row) => cols.map((c) => csvEscape(csvCell(row[c.field]))));
  return [header, ...body].map((r) => r.join(",")).join("\r\n");
}

// ---- chart data -> PNG ----

export interface ChartPngResult {
  base64: string;
  mimeType: string;
}

function isRecordArray(x: unknown): x is Record<string, unknown>[] {
  return Array.isArray(x) && (x.length === 0 || (typeof x[0] === "object" && x[0] !== null));
}

/**
 * Recovers a Plotly figure from the same shapes ChartRenderer accepts: a
 * figure as-is, a bare trace array, table rows (via buildFigureFromRecords),
 * or a `{results: [...]}` envelope.
 */
function toFigure(data: unknown): PlotlyFigure | null {
  if (isPlotlyFigure(data)) return data;

  if (Array.isArray(data)) {
    const first = data[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const looksLikeTrace = "x" in first || "y" in first || "type" in first;
      if (!looksLikeTrace) return buildFigureFromRecords(data as Record<string, unknown>[]);
    }
    return { data, layout: {} };
  }

  if (data !== null && typeof data === "object" && "results" in data) {
    const results = (data as Record<string, unknown>).results;
    if (isRecordArray(results)) return buildFigureFromRecords(results);
  }

  return null;
}

/**
 * Renders a widget's chart data to a PNG using Plotly's headless image
 * export (`Plotly.toImage` accepts a plain `{data, layout}` figure directly,
 * without a mounted DOM node).
 *
 * Not exercised against the real Plotly renderer by this repo's test suite:
 * jsdom has no `<canvas>` backing (the `canvas` npm package isn't
 * installed, and every existing chart test -- see ChartRenderer.test.tsx --
 * mocks `plotly.js-dist-min` entirely), so the rasterization step cannot run
 * under vitest. Tests here inject a fake `toImage`. The real call is
 * therefore implemented but unverified end to end outside the actual Tauri
 * webview.
 */
export async function defaultRenderChartPng(
  data: unknown,
  deps: { toImage?: typeof Plotly.toImage } = {}
): Promise<ChartPngResult> {
  const figure = toFigure(data);
  if (!figure) throw new Error("No chart data to send");

  const toImage = deps.toImage ?? Plotly.toImage;
  const dataUrl = await toImage(
    { data: figure.data, layout: figure.layout ?? {} },
    { format: "png", width: 900, height: 500 }
  );
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, "");
  return { base64, mimeType: "image/png" };
}
