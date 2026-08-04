import type {
  AgentTool,
  AssembleToolsResult,
  McpBudgetExceeded,
  McpServerConfig,
  McpUnreachable,
} from "./types";
import { logError } from "../logger";
import { sseEvents } from "./sse";

/**
 * MCP Streamable HTTP client.
 *
 * Verified against the two live servers behind svc:openbb-api (OpenBB MCP on
 * :8443, stores MCP on :8444), both reporting protocolVersion 2025-06-18.
 * Things a naive JSON-RPC-over-POST client gets wrong against them:
 *
 *   1. Accept must list BOTH application/json and text/event-stream. With
 *      application/json alone the server answers 406 and discovery returns
 *      nothing.
 *   2. Responses are framed as text/event-stream ("event: message" +
 *      "data: {...}"), so res.json() throws even on success. Parsed here via
 *      `sseEvents` (./sse.ts) rather than a second hand-rolled line-scanner —
 *      same chunk-boundary and truncation handling as the Rita client, for
 *      free, and one fewer parser to keep correct.
 *   3. initialize issues an Mcp-Session-Id header that every subsequent
 *      request must echo back.
 *   4. /mcp/ answers 307 to /mcp, so a client that does not follow redirects
 *      never reaches the endpoint (`redirect: "follow"` below, and the
 *      assembleTools dedup key normalizes away a trailing slash so a
 *      Settings entry and a widget mcpUrl differing only by "/" don't get
 *      discovered — and billed against the tool budget — twice).
 *
 * Additional hardening folded in on top of the above:
 *   - Every call carries its own abort-based timeout: a dead-but-connected
 *     server must never block a chat turn forever.
 *   - assembleTools discovers all configured servers concurrently (one
 *     timeout budget total, not one per server) and never lets a single
 *     failing/oversized server take down the others.
 *   - A failed discovery is surfaced structurally (`unreachable`), not just
 *     logged, so the caller can name which server is down instead of
 *     inferring it from an empty tool list.
 *   - HTTP error bodies are read and previewed rather than discarded down to
 *     a bare "HTTP 400" — MCP servers name the exact rejected field there.
 *   - The SSE-framed response is matched by JSON-RPC id (a server that emits
 *     a progress/ping event ahead of the real response used to be silently
 *     accepted as if it WERE the response).
 *   - tools/list pagination (`nextCursor`) is followed rather than assuming
 *     page 1 is everything.
 *   - The tool cache returns a copy, not the live array, and a failed
 *     discovery is never cached — a transient failure must stay retryable.
 */
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MCP_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_PREVIEW_CHARS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Streamable-http servers frame the single JSON-RPC response as one SSE
 * `message` event. Matches on `data.id === id`: a server that emits a
 * progress/ping event with an object payload ahead of the real response
 * would otherwise be taken as the response itself (`{result: null}`, then
 * cached as a valid empty tool list) — only a record whose `id` matches the
 * request is accepted, so a mismatched or missing response fails loudly via
 * the "unparseable" error below instead.
 */
async function readSseRpcData(body: ReadableStream<Uint8Array>, id: number): Promise<unknown | null> {
  for await (const ev of sseEvents(body)) {
    if (isRecord(ev.data) && ev.data.id === id) return ev.data;
  }
  return null;
}

/**
 * Default transport for every exported function below. MCP server URLs are
 * user-configured (Settings dialog, arbitrary hosts). The webview's own
 * fetch reaches them fine — the CSP's connect-src admits any http(s) host —
 * so there is no reason to hop through `@tauri-apps/plugin-http` here the
 * way `dataClient.ts` does.
 */
const defaultFetch: typeof fetch = (...args) => window.fetch(...args);

export async function mcpRpc(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number | null,
  sessionId: string | null = null,
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = DEFAULT_MCP_TIMEOUT_MS
): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Both types are required; application/json alone gets a 406.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  // Notifications carry no id and get no response.
  if (id !== null) body.id = id;

  // A dead-but-connected MCP server (accepts the TCP connection, never
  // replies) must never block a chat turn forever — every request gets its
  // own abort-based timeout budget.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`MCP ${method} timed out after ${timeoutMs}ms calling ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok && res.status !== 202) {
    // Read (and thereby drain) the body: MCP servers' 4xxs name the exact
    // rejected field ("Missing session ID", "Bad Request: invalid protocol
    // version") — discarding it down to a bare "HTTP 400" leaves nothing to
    // debug from.
    const bodyText = await res.text().catch(() => "");
    const preview = bodyText.length > RESPONSE_BODY_PREVIEW_CHARS
      ? `${bodyText.slice(0, RESPONSE_BODY_PREVIEW_CHARS)}…`
      : bodyText;
    throw new Error(
      `MCP ${method} failed: HTTP ${res.status} from ${url}` + (preview ? ` — ${preview}` : "")
    );
  }

  const nextSession = res.headers.get("Mcp-Session-Id") ?? sessionId;

  if (id === null) {
    // Notification: no JSON-RPC body to parse, but the response body (even
    // an empty 202) still holds a handle open until read or cancelled —
    // drain it.
    await res.text().catch(() => "");
    return { result: null, sessionId: nextSession };
  }

  const contentType = res.headers.get("content-type") ?? "";
  const data = contentType.includes("text/event-stream")
    ? res.body
      ? await readSseRpcData(res.body, id)
      : null
    : await (async () => {
        try {
          return JSON.parse(await res.text()) as unknown;
        } catch {
          return null;
        }
      })();

  if (!isRecord(data)) throw new Error(`MCP ${method}: unparseable response from ${url}`);
  const parsed = data as JsonRpcResponse;
  if (parsed.error) {
    throw new Error(`MCP ${method} failed: ${parsed.error.code ?? "?"} ${parsed.error.message ?? "unknown error"}`);
  }
  return { result: parsed.result ?? null, sessionId: nextSession };
}

/** Tools discovered per server URL, cached for the app session. */
const toolCache = new Map<string, AgentTool[]>();

export function clearMcpCache(): void {
  toolCache.clear();
}

export async function discoverMcpTools(
  serverId: string,
  url: string,
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = DEFAULT_MCP_TIMEOUT_MS
): Promise<AgentTool[]> {
  const cached = toolCache.get(url);
  // Return a copy, not the live cached array: the cache is shared across
  // every caller for the app session, so handing out the stored reference
  // would let one caller's mutation reach every other caller (and every
  // future cache hit).
  if (cached) return [...cached];

  const init = await mcpRpc(
    url,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bdobb", version: "0.1.0" },
    },
    1,
    null,
    fetchImpl,
    timeoutMs
  );

  // Required by the spec before regular requests; servers may reject
  // tools/list without it.
  await mcpRpc(url, "notifications/initialized", undefined, null, init.sessionId, fetchImpl, timeoutMs);

  // Spec-compliant servers may paginate tools/list via `nextCursor`. Neither
  // live server (stores, OpenBB) does, but an unpaginated read would
  // silently expose only page 1 of a third-party server that does.
  const rawTools: unknown[] = [];
  let cursor: string | undefined;
  let nextId = 2;
  do {
    const list = await mcpRpc(
      url,
      "tools/list",
      cursor ? { cursor } : undefined,
      nextId++,
      init.sessionId,
      fetchImpl,
      timeoutMs
    );
    const result = isRecord(list.result) ? list.result : {};
    const pageTools = Array.isArray(result.tools) ? result.tools : [];
    rawTools.push(...pageTools);
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
  } while (cursor);

  const mapped: AgentTool[] = rawTools
    .filter(isRecord)
    .map((t) => ({
      server_id: serverId,
      name: String(t.name ?? ""),
      url,
      endpoint: "",
      description: String(t.description ?? ""),
      input_schema: (isRecord(t.inputSchema) ? t.inputSchema : {}) as Record<string, unknown>,
    }));

  // Cache only on success — a failed discovery must never be memoized as an
  // empty result, or a transient failure (server still booting, a network
  // blip) would become permanent for the rest of the app session with no way
  // to retry short of a full restart.
  toolCache.set(url, mapped);
  return [...mapped];
}

/**
 * Ceiling on the serialized size of the tool descriptors we hand Rita, in
 * characters. Rita's llama.cpp backend runs -c 131072 --parallel 2, so each
 * request gets a 65,536-token slot shared by the system prompt, the widget
 * context, the conversation and the answer. Descriptors overflowing that slot
 * are not a soft degradation — Rita rejects the request outright and chat stops
 * working. 64,000 characters is roughly 16k tokens: a quarter of the slot,
 * which leaves room for everything else.
 *
 * The OpenBB MCP server exposes 219 tools (~150k tokens) unless it is launched
 * with --tool-discovery, which cuts it to 10 discovery tools the agent uses to
 * activate categories on demand. That flag lives on the server, so it can
 * disappear on a restart without any change here; this budget is what keeps
 * that from taking chat down with it.
 *
 * The budget is enforced against the RUNNING TOTAL across all servers, not
 * per server: Rita's context slot is shared by every tool sent in one
 * request, so two individually-small servers can still blow it out combined.
 * Servers are admitted whole and in the order they were configured until the
 * budget is spent; one that does not fit is dropped ENTIRELY (never
 * truncated mid-list — a partial tool set is exactly the "silently invisible
 * tool" failure this budget exists to avoid), and later, smaller ones are
 * still considered.
 */
export const TOOL_PAYLOAD_BUDGET_CHARS = 64_000;

function payloadSize(tools: AgentTool[]): number {
  return JSON.stringify(tools).length;
}

function normalizeMcpUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Tool assembly rule from the spec: the union of enabled Settings MCP servers
 * and the storage.mcpUrl of widgets on the ACTIVE dashboard, deduplicated by
 * NORMALIZED url (trimmed, trailing slash(es) stripped — `/mcp/` 307-redirects
 * to `/mcp` on both live servers, so without normalizing, a Settings entry and
 * a widget mcpUrl differing only by a trailing slash would be discovered, and
 * billed against the budget, twice). Settings wins the server_id label on a
 * url collision since it's populated first.
 *
 * Each target discovers concurrently and settles internally (try/catch inside
 * the mapper, never lets the promise reject), so a hanging or failing server
 * can't block discovery of the others — N servers cost one timeout budget
 * total, not N. A failing discovery is surfaced in `unreachable`, naming the
 * server and url, rather than silently disappearing from the tool list.
 */
export async function assembleTools(
  mcpServers: McpServerConfig[],
  dashboardMcp: { widgetId: string; url: string }[] = [],
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = DEFAULT_MCP_TIMEOUT_MS
): Promise<AssembleToolsResult> {
  const targets = new Map<string, string>(); // normalized url -> server_id
  for (const s of mcpServers) if (s.enabled) targets.set(normalizeMcpUrl(s.url), s.id);
  for (const d of dashboardMcp) {
    const key = normalizeMcpUrl(d.url);
    if (!targets.has(key)) targets.set(key, d.widgetId);
  }

  const results = await Promise.all(
    Array.from(targets, async ([url, serverId]) => {
      try {
        const tools = await discoverMcpTools(serverId, url, fetchImpl, timeoutMs);
        return { ok: true as const, url, serverId, tools };
      } catch (e) {
        // A dead/misbehaving MCP server must never block chat: log and skip.
        logError(`MCP discovery failed for ${url}: ${String(e)}`);
        return {
          ok: false as const,
          url,
          serverId,
          message: `MCP server ${url} is unreachable: ${String(e)}`,
        };
      }
    })
  );

  const out: AgentTool[] = [];
  const budgetExceeded: McpBudgetExceeded[] = [];
  const unreachable: McpUnreachable[] = [];
  let used = 0;
  for (const result of results) {
    if (!result.ok) {
      unreachable.push({ serverId: result.serverId, url: result.url, message: result.message });
      continue;
    }

    const { url, serverId, tools } = result;
    const size = payloadSize(tools);
    if (used + size > TOOL_PAYLOAD_BUDGET_CHARS) {
      const message =
        `MCP server ${serverId} (${url}) skipped: its ${tools.length} tools ` +
        `add ${size} chars (${used} already used), exceeding the request budget of ` +
        `${TOOL_PAYLOAD_BUDGET_CHARS} chars. Chat continues without them — if this is ` +
        `the OpenBB MCP server, restart it with --tool-discovery.`;
      logError(message);
      // `size` (and therefore `payloadChars`) is a CHARACTER count
      // (JSON.stringify(tools).length, matching TOOL_PAYLOAD_BUDGET_CHARS's
      // own unit), not bytes — and it's measured against `used`, the running
      // total spent by every server admitted so far, not this server alone.
      budgetExceeded.push({ serverId, url, toolCount: tools.length, payloadChars: size, message });
      continue;
    }
    used += size;
    out.push(...tools);
  }

  return { tools: out.length > 0 ? out : null, budgetExceeded, unreachable };
}

/** What a tool returned. MCP wraps results in a content array. */
export interface McpCallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/**
 * Invokes a tool on an MCP server.
 *
 * Performs its own handshake rather than reusing the discovery cache: the
 * session id issued at initialize belongs to that exchange, and discovery may
 * have happened long enough ago that the server has dropped it.
 */
export async function callMcpTool(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = DEFAULT_MCP_TIMEOUT_MS
): Promise<McpCallResult> {
  const init = await mcpRpc(
    url,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bdobb", version: "0.1.0" },
    },
    1,
    null,
    fetchImpl,
    timeoutMs
  );
  await mcpRpc(url, "notifications/initialized", undefined, null, init.sessionId, fetchImpl, timeoutMs);

  const res = await mcpRpc(
    url,
    "tools/call",
    { name: toolName, arguments: args },
    2,
    init.sessionId,
    fetchImpl,
    timeoutMs
  );

  const result = (isRecord(res.result) ? res.result : {}) as unknown as McpCallResult;
  // A tool can fail without a JSON-RPC error: the protocol reports that as
  // isError on an otherwise successful response.
  if (result.isError) {
    const detail = (result.content ?? [])
      .map((c) => c.text ?? "")
      .filter(Boolean)
      .join(" ");
    throw new Error(`MCP tool ${toolName} failed${detail ? `: ${detail}` : ""}`);
  }
  return { content: result.content ?? [], isError: false };
}
