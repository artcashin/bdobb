import { describe, expect, it, vi } from "vitest";
import { markdownToMessageML, rowsToCsv, defaultRenderChartPng } from "./symphonyPayload";
import type { ColumnDef } from "./types";

describe("markdownToMessageML", () => {
  it("wraps plain text in a messageML root with a line break", () => {
    expect(markdownToMessageML("Hello world")).toBe("<messageML>Hello world<br/></messageML>");
  });

  it("escapes XML special characters", () => {
    expect(markdownToMessageML('A & B <tag> "quoted"')).toBe(
      "<messageML>A &amp; B &lt;tag&gt; &quot;quoted&quot;<br/></messageML>"
    );
  });

  it("converts bold and italic", () => {
    expect(markdownToMessageML("**bold** and *italic*")).toBe(
      "<messageML><b>bold</b> and <i>italic</i><br/></messageML>"
    );
  });

  it("converts inline code", () => {
    expect(markdownToMessageML("run `npm test`")).toBe(
      "<messageML>run <code>npm test</code><br/></messageML>"
    );
  });

  it("converts links", () => {
    expect(markdownToMessageML("[BDOBB](https://example.com/a?b=c&d=e)")).toBe(
      '<messageML><a href="https://example.com/a?b=c&amp;d=e">BDOBB</a><br/></messageML>'
    );
  });

  it("preserves underscores and asterisks inside a link URL instead of letting them open emphasis tags in the href attribute", () => {
    expect(markdownToMessageML("[docs](https://x.com/foo_bar_baz)")).toBe(
      '<messageML><a href="https://x.com/foo_bar_baz">docs</a><br/></messageML>'
    );
    expect(markdownToMessageML("[docs](https://x.com/a*b*c)")).toBe(
      '<messageML><a href="https://x.com/a*b*c">docs</a><br/></messageML>'
    );
  });

  it("preserves an underscore in a URL even when preceded by a slash, proving the href placeholder actually shields the emphasis passes", () => {
    // Without the href-placeholder mechanism, the emphasis regexes' "not
    // preceded by alphanumeric" guard would NOT suppress this: `/` is not
    // alphanumeric, so `_b_` here would be free to be read as emphasis. The
    // other link tests above pass with or without the placeholder mechanism
    // in place, so only this case actually detects its removal.
    expect(markdownToMessageML("[docs](https://x.com/a/_b_/c)")).toBe(
      '<messageML><a href="https://x.com/a/_b_/c">docs</a><br/></messageML>'
    );
  });

  it("does not mangle intraword underscores in plain text as emphasis", () => {
    expect(markdownToMessageML("snake_case_id")).toBe(
      "<messageML>snake_case_id<br/></messageML>"
    );
  });

  it("does not treat whitespace-flanked asterisks as emphasis", () => {
    expect(markdownToMessageML("5 * 3 and 2 * 4")).toBe(
      "<messageML>5 * 3 and 2 * 4<br/></messageML>"
    );
  });

  it("renders a non-http(s) link scheme as plain text instead of an anchor", () => {
    expect(markdownToMessageML("[click](javascript:doEvil)")).toBe(
      "<messageML>click<br/></messageML>"
    );
  });

  it("converts a heading to bold", () => {
    expect(markdownToMessageML("# Title")).toBe("<messageML><b>Title</b><br/></messageML>");
  });

  it("converts a bullet list", () => {
    expect(markdownToMessageML("- one\n- two")).toBe(
      "<messageML><ul><li>one</li><li>two</li></ul></messageML>"
    );
  });

  it("converts a numbered list", () => {
    expect(markdownToMessageML("1. one\n2. two")).toBe(
      "<messageML><ol><li>one</li><li>two</li></ol></messageML>"
    );
  });

  it("closes a list before resuming plain text", () => {
    expect(markdownToMessageML("- one\ntext after")).toBe(
      "<messageML><ul><li>one</li></ul>text after<br/></messageML>"
    );
  });

  it("treats an empty string as an empty message", () => {
    expect(markdownToMessageML("")).toBe("<messageML><br/></messageML>");
  });
});

describe("rowsToCsv", () => {
  it("returns an empty string for no rows", () => {
    expect(rowsToCsv([], null)).toBe("");
  });

  it("derives a header from row keys when no columns are declared", () => {
    const csv = rowsToCsv([{ name: "Alice", age: 30 }], null);
    expect(csv).toBe("name,age\r\nAlice,30");
  });

  it("uses declared column headerName and order, and drops hidden columns", () => {
    const cols: ColumnDef[] = [
      { field: "age", headerName: "Age" },
      { field: "secret", headerName: "Secret", hide: true },
      { field: "name", headerName: "Name" },
    ];
    const csv = rowsToCsv([{ name: "Alice", age: 30, secret: "x" }], cols);
    expect(csv).toBe("Age,Name\r\n30,Alice");
  });

  it("quotes values containing commas, quotes or newlines", () => {
    const csv = rowsToCsv([{ note: 'has, a "quote"\nand newline' }], null);
    expect(csv).toBe('note\r\n"has, a ""quote""\nand newline"');
  });

  it("renders null/undefined cells as empty", () => {
    const csv = rowsToCsv([{ a: null, b: undefined }], null);
    expect(csv).toBe("a,b\r\n,");
  });

  it("neutralizes a leading formula-trigger character to prevent CSV formula injection", () => {
    expect(rowsToCsv([{ note: "=1+1" }], null)).toBe("note\r\n'=1+1");
    expect(rowsToCsv([{ note: "@SUM(A1)" }], null)).toBe("note\r\n'@SUM(A1)");
  });

  it("does not prefix a bare numeric literal even when it starts with + or -", () => {
    // Market data is full of negative change/return/P&L cells; `-5` parses
    // as a number in a spreadsheet, not a formula, so it must pass through
    // untouched rather than being coerced to text with a literal apostrophe.
    expect(rowsToCsv([{ note: "-5" }], null)).toBe("note\r\n-5");
    expect(rowsToCsv([{ note: "+5" }], null)).toBe("note\r\n+5");
    expect(rowsToCsv([{ note: "-1.25" }], null)).toBe("note\r\n-1.25");
    expect(rowsToCsv([{ note: "1e-3" }], null)).toBe("note\r\n1e-3");
  });

  it("still neutralizes a leading -/+ when the rest of the cell isn't a numeric literal", () => {
    expect(rowsToCsv([{ note: "-cmd|'/c calc'!A1" }], null)).toBe(
      "note\r\n'-cmd|'/c calc'!A1"
    );
  });

  it("neutralizes a formula trigger hidden behind leading whitespace, since Sheets trims on import before evaluating", () => {
    expect(rowsToCsv([{ note: "  =1+1" }], null)).toBe("note\r\n'  =1+1");
    expect(rowsToCsv([{ note: "\t=1+1" }], null)).toBe("note\r\n'\t=1+1");
  });

  it("applies the quote prefix inside RFC 4180 quoting, not outside it", () => {
    expect(rowsToCsv([{ note: "=1+1,x" }], null)).toBe('note\r\n"\'=1+1,x"');
  });
});

describe("defaultRenderChartPng", () => {
  it("throws a clear error when the data has no recognizable chart shape", async () => {
    await expect(defaultRenderChartPng({ nonsense: true })).rejects.toThrow(/no chart data/i);
  });

  it("calls Plotly.toImage with the figure and returns the base64 payload", async () => {
    const toImage = vi.fn(async () => "data:image/png;base64,QUJD");
    const result = await defaultRenderChartPng(
      { data: [{ x: [1], y: [2], type: "scatter" }], layout: { title: "t" } },
      { toImage: toImage as never }
    );
    expect(toImage).toHaveBeenCalled();
    expect(result).toEqual({ base64: "QUJD", mimeType: "image/png" });
  });

  it("builds a figure from record rows with a date column", async () => {
    const toImage = vi.fn(async () => "data:image/png;base64,WFla");
    const rows = [
      { date: "2026-07-01", close: 1.5 },
      { date: "2026-07-02", close: 2.8 },
    ];
    const result = await defaultRenderChartPng(rows, { toImage: toImage as never });
    expect(toImage).toHaveBeenCalled();
    expect(result.base64).toBe("WFla");
  });
});
