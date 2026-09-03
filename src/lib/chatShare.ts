import { callMcpTool } from "./agent/mcp";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { ColumnDef } from "./types";
import { defaultRenderChartPng, markdownToMessageML, rowsToCsv } from "./symphonyPayload";

/**
 * A place a conversation can be sent — an MCP server exposing a
 * note/page-creating tool, or a plain HTTP endpoint.
 *
 * Deliberately app-agnostic: Tolaria's create_note and Notion's MCP both fit
 * without a line of app-specific code, because the argument shape is supplied
 * as a template rather than hardcoded.
 */
export interface ShareTarget {
  id: string;
  name: string;
  /**
   * `file` writes a markdown file into a directory. Markdown-vault apps —
   * Tolaria, Obsidian — are filesystem-backed, and their MCP servers are
   * commonly stdio-only, which a webview cannot speak. Writing the file is
   * both simpler and more reliable than bridging a transport.
   */
  kind: "mcp" | "http" | "file";
  /** MCP/HTTP endpoint, or the destination directory for `file`. */
  url: string;
  /** mcp: the tool to invoke, e.g. "create_note". */
  tool?: string;
  /**
   * JSON object literal describing the tool arguments (mcp) or request body
   * (http). String values may contain {{markdown}}, {{title}}, {{filename}}
   * and {{exportedAt}}.
   */
  template: string;
  /** http only. */
  headers?: Record<string, string>;
}

export interface ShareVars {
  markdown: string;
  title: string;
  filename: string;
  exportedAt: string;
}

const PLACEHOLDER = /\{\{(markdown|title|filename|exportedAt)\}\}/g;

function substitute(text: string, vars: ShareVars): string {
  return text.replace(PLACEHOLDER, (_m, key: keyof ShareVars) => vars[key]);
}

/**
 * Fills placeholders in every string leaf of an already-parsed structure.
 *
 * Substituting into the raw template text before parsing would be a bug: a
 * conversation containing a quote, backslash or newline would produce invalid
 * JSON. Parsing first means the markdown never has to be escaped.
 */
function fillNode(node: unknown, vars: ShareVars): unknown {
  if (typeof node === "string") return substitute(node, vars);
  if (Array.isArray(node)) return node.map((n) => fillNode(n, vars));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, fillNode(v, vars)])
    );
  }
  return node;
}

/** Parses a target's template and fills it. Throws if the template is not JSON. */
export function buildPayload(template: string, vars: ShareVars): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template || "{}");
  } catch (e) {
    throw new Error(`Template is not valid JSON: ${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Template must be a JSON object");
  }
  return fillNode(parsed, vars) as Record<string, unknown>;
}

/** Human-readable confirmation of what a target did, for the UI. */
export interface ShareResult {
  target: string;
  detail: string;
}

export async function shareChat(
  target: ShareTarget,
  vars: ShareVars,
  deps: {
    callTool?: typeof callMcpTool;
    fetchImpl?: typeof fetch;
    writeFile?: (path: string, contents: string) => Promise<void>;
    mkdir?: (path: string) => Promise<void>;
  } = {}
): Promise<ShareResult> {
  if (target.kind === "file") {
    if (!target.url) throw new Error(`${target.name}: no destination folder configured`);
    const dir = target.url.replace(/\/+$/, "");
    // The template's `path` names the file, so a target can organise into
    // subfolders; fall back to the generated filename.
    const payload = buildPayload(target.template || "{}", vars);
    const rel = typeof payload.path === "string" && payload.path ? payload.path : vars.filename;
    const full = `${dir}/${rel}`;
    const parent = full.slice(0, full.lastIndexOf("/"));

    if (!deps.writeFile) throw new Error("file target requires a filesystem writer");
    if (parent && parent !== dir) await deps.mkdir?.(parent);
    await deps.writeFile(full, vars.markdown);
    return { target: target.name, detail: full };
  }

  const payload = buildPayload(target.template, vars);

  if (target.kind === "mcp") {
    if (!target.tool) throw new Error(`${target.name}: no tool configured`);
    const call = deps.callTool ?? callMcpTool;
    const res = await call(target.url, target.tool, payload);
    const text = res.content
      .map((c) => c.text ?? "")
      .filter(Boolean)
      .join(" ")
      .slice(0, 200);
    return { target: target.name, detail: text || `${target.tool} succeeded` };
  }

  // Goes through plugin-http like every other non-streaming call in the app.
  const doFetch = deps.fetchImpl ?? (tauriFetch as unknown as typeof fetch);
  const res = await doFetch(target.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(target.headers ?? {}) },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${target.name}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
    );
  }
  return { target: target.name, detail: `HTTP ${res.status}` };
}

// ---- widget-content sharing (Task 6): a card's content pushed into a
// Symphony conversation via the bot bridge, as distinct from shareChat's
// whole-conversation export above. ----

export type SymphonyShareKind = "note" | "table" | "chart";

export interface SymphonyShareInput {
  kind: SymphonyShareKind;
  /** settings.symphonyBridgeUrl -- the bot-bridge HTTP service, no trailing slash required. */
  bridgeUrl: string;
  /** The Symphony stream (room or IM) id to post into. */
  streamId: string;
  /** The widget/card name, used for the CSV/PNG attachment filename. */
  title: string;
  /** note: markdown text. table: row records. chart: whatever the card fetched. */
  data: unknown;
  /** table only: the widget's declared columns, for header labels/order. */
  columns?: ColumnDef[] | null;
  /**
   * Display name stamped on the message as "📤 {sender} via BDOBB" by the
   * bridge. A self-asserted courtesy label, not an identity claim -- the
   * bridge does not and cannot authenticate it. Omitted from the request
   * entirely when blank; see the send site below.
   */
  sender?: string;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "widget";
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A short MessageML message, used as the caption on an attachment share. */
function captionMessageML(title: string): string {
  return markdownToMessageML(title);
}

/**
 * Pushes a widget card's content into a Symphony conversation via the bot
 * bridge. Three widget kinds, three payload shapes:
 *  - note: markdown converted to MessageML, sent as the message body.
 *  - table: rows converted to CSV, sent as a base64 attachment.
 *  - chart: rendered to PNG (see symphonyPayload.ts), sent as a base64
 *    attachment.
 *
 * Both `bridgeUrl` and `streamId` are required -- the caller (WidgetCard)
 * is expected to have already gated the button's visibility on a configured
 * bridge URL, but this function still validates both itself rather than
 * trusting that, since a missing/empty streamId would otherwise post to a
 * meaningless `/messages` destination.
 */
export async function shareWidgetToSymphony(
  input: SymphonyShareInput,
  deps: {
    fetchImpl?: typeof fetch;
    renderChartPng?: (data: unknown) => Promise<{ base64: string; mimeType: string }>;
  } = {}
): Promise<ShareResult> {
  if (!input.bridgeUrl) throw new Error("Symphony: no bridge URL configured");
  if (!input.streamId) throw new Error("Symphony: no stream ID given");

  let body: Record<string, unknown>;

  if (input.kind === "note") {
    // Guarded the same way `table`/`chart` are below: silently coercing a
    // non-string or empty `data` to "" produced `<messageML><br/></messageML>`
    // -- a real POST to a live room that still reports `Symphony: HTTP 200`
    // as if it succeeded. Two ordinary paths reach this with non-string or
    // empty data: a registry `markdown` widget in raw view (WidgetCard.tsx
    // switches to fetchWidgetData there, so `data` is a parsed object, not a
    // string) and a built-in Note with empty text.
    if (typeof input.data !== "string") throw new Error("Symphony: note data is not text");
    if (!input.data.trim()) throw new Error("Symphony: no note text to send");
    body = { streamId: input.streamId, messageML: markdownToMessageML(input.data) };
  } else if (input.kind === "table") {
    if (!Array.isArray(input.data) || input.data.length === 0)
      throw new Error("Symphony: no table data to send");
    const csv = rowsToCsv(input.data as Record<string, unknown>[], input.columns ?? null);
    body = {
      streamId: input.streamId,
      messageML: captionMessageML(input.title),
      attachment: {
        filename: `${slugify(input.title)}.csv`,
        contentType: "text/csv",
        data: toBase64Utf8(csv),
      },
    };
  } else {
    const render = deps.renderChartPng ?? defaultRenderChartPng;
    const { base64, mimeType } = await render(input.data);
    body = {
      streamId: input.streamId,
      messageML: captionMessageML(input.title),
      attachment: {
        filename: `${slugify(input.title)}.png`,
        contentType: mimeType,
        data: base64,
      },
    };
  }

  // Blank/whitespace-only names are dropped rather than sent as "" -- the
  // bridge degrades to an unattributed stamp only when the key is absent.
  if (input.sender && input.sender.trim()) body.sender = input.sender;

  const doFetch = deps.fetchImpl ?? (tauriFetch as unknown as typeof fetch);
  const res = await doFetch(`${input.bridgeUrl.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Symphony: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  return { target: "Symphony", detail: `HTTP ${res.status}` };
}

/** Sensible starting template for a new target of each kind. */
export function defaultTemplate(kind: ShareTarget["kind"]): string {
  if (kind === "mcp") {
    return JSON.stringify(
      { title: "{{title}}", path: "chats/{{filename}}", content: "{{markdown}}" },
      null,
      2
    );
  }
  if (kind === "file") {
    // Only `path` is read for a file target; the markdown is the file body.
    return JSON.stringify({ path: "{{filename}}" }, null, 2);
  }
  return JSON.stringify({ title: "{{title}}", markdown: "{{markdown}}" }, null, 2);
}
