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
