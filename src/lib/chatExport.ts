import type { AgentCall, ChatMessage, ClientArtifact } from "./agent/types";

export interface ExportOptions {
  /** ISO timestamp; passed in so the output is deterministic under test. */
  exportedAt: string;
  ritaUrl?: string;
  dashboardName?: string;
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Pipes would break the table; newlines would break the row.
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Rows of records as a GitHub-flavoured markdown table. */
export function recordsToMarkdownTable(rows: Record<string, unknown>[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return "_(empty table)_";
  // An artifact's rows come from the agent, so the first one is not guaranteed
  // to be an object; Object.keys(null) throws and takes the whole export with
  // it. Use the first row that is one.
  const first = rows.find((r) => r !== null && typeof r === "object");
  if (!first) return "_(empty table)_";
  const columns = Object.keys(first);
  if (columns.length === 0) return "_(empty table)_";

  // Column names need the same escaping as cells: an unescaped pipe in a
  // header splits the table into the wrong number of columns and the rest of
  // the rows render misaligned.
  const head = `| ${columns.map(escapeCell).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) =>
    r !== null && typeof r === "object"
      ? `| ${columns.map((c) => escapeCell(r[c])).join(" | ")} |`
      : `| ${columns.map(() => "").join(" | ")} |`
  );
  return [head, rule, ...body].join("\n");
}

function artifactToMarkdown(a: ClientArtifact): string {
  const heading = a.name ? `**${a.name}**` : "**Artifact**";
  const desc = a.description ? `\n\n_${a.description}_` : "";

  if (a.type === "table" && Array.isArray(a.content)) {
    return `${heading}${desc}\n\n${recordsToMarkdownTable(a.content as Record<string, unknown>[])}`;
  }

  if (a.type === "chart") {
    // Markdown cannot render a plot. Emitting the figure verbatim keeps the
    // file faithful and lets it be fed back into Plotly.
    return [
      `${heading} (chart)${desc}`,
      "",
      "```json",
      JSON.stringify({ content: a.content, chart_params: a.chart_params }, null, 2),
      "```",
    ].join("\n");
  }

  if (typeof a.content === "string") return `${heading}${desc}\n\n${a.content}`;

  return [`${heading}${desc}`, "", "```json", JSON.stringify(a.content, null, 2), "```"].join("\n");
}

function callToMarkdown(call: AgentCall): string {
  const when = call.at.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const lines: string[] = [];

  if (call.kind === "widget_data") {
    const outcome = call.ok
      ? `ok${call.rows !== undefined ? `, ${call.rows} rows` : ""}`
      : `failed`;
    lines.push(`- \`${when}\` **${call.label}** — ${outcome}${call.durationMs !== undefined ? `, ${call.durationMs} ms` : ""}`);
    if (call.url) lines.push(`  - \`GET ${call.url}\``);
    if (call.error) lines.push(`  - error: ${call.error}`);
  } else {
    lines.push(`- \`${when}\` **${call.label}** — agent tool`);
    if (call.input && Object.keys(call.input).length > 0) {
      lines.push("  - input:");
      lines.push("    ```json");
      for (const l of JSON.stringify(call.input, null, 2).split("\n")) lines.push(`    ${l}`);
      lines.push("    ```");
    }
  }
  return lines.join("\n");
}

/**
 * Renders a conversation as a self-contained markdown document.
 *
 * Protocol messages (function-call echoes, tool results) are omitted from the
 * conversation body — they are machinery, and the requests they represent are
 * reported in their own section with far more detail.
 */
export function chatToMarkdown(
  messages: ChatMessage[],
  calls: AgentCall[],
  opts: ExportOptions
): string {
  const out: string[] = ["# Rita conversation", ""];

  out.push(`- Exported: ${opts.exportedAt}`);
  if (opts.dashboardName) out.push(`- Dashboard: ${opts.dashboardName}`);
  if (opts.ritaUrl) out.push(`- Agent: ${opts.ritaUrl}`);
  out.push("");

  out.push("## Conversation", "");

  let rendered = 0;
  for (const m of messages) {
    if (m.role === "human") {
      out.push("### You", "", String(m.content), "");
      rendered++;
      continue;
    }
    // Tool results and function-call echoes are machinery, not conversation.
    if (m.role !== "ai") continue;

    const content = (m as { content: unknown }).content;
    if (typeof content === "string") {
      out.push("### Rita", "", content, "");
      rendered++;
    } else if (Array.isArray(content)) {
      out.push("### Rita", "");
      out.push(...(content as ClientArtifact[]).map(artifactToMarkdown), "");
      rendered++;
    }
  }

  if (rendered === 0) out.push("_(no messages)_", "");

  out.push("## API calls made on your behalf", "");

  const widgetCalls = calls.filter((c) => c.kind === "widget_data");
  const toolCalls = calls.filter((c) => c.kind === "agent_tool");

  if (calls.length === 0) {
    out.push("_(none)_", "");
  }

  if (widgetCalls.length > 0) {
    out.push("### Widget data requested by the agent", "");
    out.push(...widgetCalls.map(callToMarkdown), "");
  }

  if (toolCalls.length > 0) {
    out.push("### Agent tools", "");
    out.push(...toolCalls.map(callToMarkdown), "");
  }

  // State the limit rather than let the file imply a complete audit trail.
  out.push(
    "> Widget requests are made by BDOBB and recorded in full. Agent tools run",
    "> on the agent host, so only what the agent reported is listed here — a tool it",
    "> did not report is not shown.",
    ""
  );

  return out.join("\n");
}

/** `rita-chat-2026-08-01-1432.md` */
export function exportFilename(exportedAt: string): string {
  const stamp = exportedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  return `rita-chat-${stamp}.md`;
}
