import { callMcpTool } from "./agent/mcp";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

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
