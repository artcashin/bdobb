import { describe, expect, it } from "vitest";
import { chatToMarkdown, recordsToMarkdownTable, exportFilename } from "./chatExport";
import type { AgentCall, ChatMessage } from "./agent/types";

const AT = "2026-08-01T14:32:05.000Z";

const CONVO: ChatMessage[] = [
  { role: "human", content: "What did AAPL close at?" },
  { role: "ai", content: "AAPL closed at 294.38." },
];

const WIDGET_CALL: AgentCall = {
  kind: "widget_data",
  at: "2026-08-01T14:32:01.000Z",
  label: "Historical Prices",
  url: "https://api.example/api/v1/equity/price/historical?symbol=AAPL",
  params: { symbol: "AAPL" },
  ok: true,
  durationMs: 132,
  rows: 2,
};

const TOOL_CALL: AgentCall = {
  kind: "agent_tool",
  at: "2026-08-01T14:32:02.000Z",
  label: "create_table_from_text",
  input: { name: "fruit_prices" },
};

describe("recordsToMarkdownTable", () => {
  it("renders a header, rule and one row per record", () => {
    const md = recordsToMarkdownTable([
      { item: "Apple", price: 1.29 },
      { item: "Banana", price: 0.89 },
    ]);
    expect(md.split("\n")).toEqual([
      "| item | price |",
      "| --- | --- |",
      "| Apple | 1.29 |",
      "| Banana | 0.89 |",
    ]);
  });

  it("escapes pipes and flattens newlines so the table cannot break", () => {
    const md = recordsToMarkdownTable([{ note: "a|b", text: "line1\nline2" }]);
    expect(md).toContain("a\\|b");
    expect(md).toContain("line1 line2");
    // Two content lines only: header, rule, one row.
    expect(md.split("\n")).toHaveLength(3);
  });

  it("handles an empty set", () => {
    expect(recordsToMarkdownTable([])).toBe("_(empty table)_");
  });
});

describe("chatToMarkdown", () => {
  it("renders the conversation with speaker headings", () => {
    const md = chatToMarkdown(CONVO, [], { exportedAt: AT });
    expect(md).toContain("# Rita conversation");
    expect(md).toContain("### You\n\nWhat did AAPL close at?");
    expect(md).toContain("### Rita\n\nAAPL closed at 294.38.");
  });

  it("includes the metadata it was given", () => {
    const md = chatToMarkdown(CONVO, [], {
      exportedAt: AT,
      ritaUrl: "https://rita.example",
      dashboardName: "Research",
    });
    expect(md).toContain(`- Exported: ${AT}`);
    expect(md).toContain("- Dashboard: Research");
    expect(md).toContain("- Agent: https://rita.example");
  });

  it("reports a widget request with its resolved URL and outcome", () => {
    // This is the point of the export: what was actually fetched on the
    // user's behalf, not just that something was.
    const md = chatToMarkdown(CONVO, [WIDGET_CALL], { exportedAt: AT });
    expect(md).toContain("## API calls made on your behalf");
    expect(md).toContain("**Historical Prices** — ok, 2 rows, 132 ms");
    expect(md).toContain("GET https://api.example/api/v1/equity/price/historical?symbol=AAPL");
  });

  it("reports a failed request as failed, with the error", () => {
    const md = chatToMarkdown(CONVO, [
      { ...WIDGET_CALL, ok: false, rows: undefined, error: "HTTP 503" },
    ], { exportedAt: AT });
    expect(md).toContain("— failed");
    expect(md).toContain("error: HTTP 503");
  });

  it("separates agent tools from widget requests and shows their input", () => {
    const md = chatToMarkdown(CONVO, [WIDGET_CALL, TOOL_CALL], { exportedAt: AT });
    expect(md).toContain("### Widget data requested by the agent");
    expect(md).toContain("### Agent tools");
    expect(md).toContain("**create_table_from_text** — agent tool");
    expect(md).toContain('"name": "fruit_prices"');
  });

  it("always states what the call list cannot cover", () => {
    // Without this the file reads as a complete audit trail, which it is not:
    // agent tools run server-side and only appear if the agent narrates them.
    const md = chatToMarkdown(CONVO, [], { exportedAt: AT });
    expect(md).toMatch(/only what the agent reported/i);
  });

  it("says so when no calls were made", () => {
    expect(chatToMarkdown(CONVO, [], { exportedAt: AT })).toContain("_(none)_");
  });

  it("renders a table artifact as a markdown table", () => {
    const md = chatToMarkdown(
      [
        { role: "human", content: "table please" },
        {
          role: "ai",
          content: [
            {
              type: "table", uuid: "a1", name: "fruit_prices", description: "Prices",
              content: [{ item: "Apple", price: 1.29 }],
            },
          ],
        } as ChatMessage,
      ],
      [],
      { exportedAt: AT }
    );
    expect(md).toContain("**fruit_prices**");
    expect(md).toContain("| item | price |");
    expect(md).toContain("| Apple | 1.29 |");
  });

  it("emits a chart artifact as JSON, since markdown cannot plot", () => {
    const md = chatToMarkdown(
      [
        { role: "human", content: "chart" },
        {
          role: "ai",
          content: [
            {
              type: "chart", uuid: "c1", name: "Price", description: "",
              content: { data: [{ x: [1], y: [2] }] },
            },
          ],
        } as ChatMessage,
      ],
      [],
      { exportedAt: AT }
    );
    expect(md).toContain("**Price** (chart)");
    expect(md).toContain("```json");
    expect(md).toContain('"x": [');
  });

  it("omits protocol messages from the conversation body", () => {
    const md = chatToMarkdown(
      [
        { role: "human", content: "hi" },
        { role: "ai", content: { function: "get_widget_data", input_arguments: {} } },
        {
          role: "tool", function: "get_widget_data", input_arguments: {},
          data: [], extra_state: {},
        },
        { role: "ai", content: "done" },
      ] as ChatMessage[],
      [],
      { exportedAt: AT }
    );
    expect(md).not.toContain("get_widget_data\n");
    expect(md).toContain("done");
    // Exactly one Rita heading: the text answer.
    expect(md.match(/### Rita/g)).toHaveLength(1);
  });

  it("says so when there is nothing to export", () => {
    expect(chatToMarkdown([], [], { exportedAt: AT })).toContain("_(no messages)_");
  });
});

describe("exportFilename", () => {
  it("derives a sortable, filesystem-safe name from the timestamp", () => {
    expect(exportFilename(AT)).toBe("rita-chat-20260801-1432.md");
  });
});

describe("recordsToMarkdownTable hostile input", () => {
  it("escapes pipes in column names", () => {
    // An unescaped pipe in a header splits the row into more cells than the
    // rule line declares, and every row below renders misaligned.
    const md = recordsToMarkdownTable([{ "a|b": 1, c: 2 }]);
    const [head, rule] = md.split("\n");
    expect(head).toContain("a\\|b");
    // Count only unescaped pipes — those are the cell delimiters a markdown
    // renderer acts on.
    const cells = (t: string) => t.split(/(?<!\\)\|/).length;
    expect(cells(head)).toBe(cells(rule));
  });

  it("does not throw on a null row", () => {
    // Artifact rows come from the agent; Object.keys(null) would take the whole
    // export down with it.
    const md = recordsToMarkdownTable([{ a: 1 }, null as never, { a: 3 }]);
    expect(md.split("\n")).toHaveLength(5);
    expect(() => recordsToMarkdownTable([null as never])).not.toThrow();
  });

  it("derives columns from the first row that is an object", () => {
    expect(recordsToMarkdownTable([null as never, { a: 1 }])).toContain("| a |");
  });
});
