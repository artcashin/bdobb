// Transport-level tests are driven from real MCP wire captures
// (src/test/fixtures/mcp/*.sse, taken from the live "stores" server) rather
// than hand-written strings, so mcp.ts is exercised against actual bytes. A
// handful of edge cases (JSON-RPC error, unparseable body, timeouts,
// pagination, the tool-payload budget) have no live capture to draw from —
// those are synthetic and labeled as such below.
import { beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.fn();
const logOnce = vi.fn();
vi.mock("../logger", () => ({
  logError: (...a: [string]) => logError(...a),
  logOnce: (...a: [string, string]) => logOnce(...a),
}));

import {
  assembleTools,
  callMcpTool,
  clearMcpCache,
  discoverMcpTools,
  mcpRpc,
  TOOL_PAYLOAD_BUDGET_CHARS,
} from "./mcp";
import { initializeResult, initializeSse, rawTools, toolsListSse } from "../../test/fixtures/mcp-fixtures";

interface MockBody { body: string; contentType: string; session?: string; status?: number }

function mkFetch(bodies: MockBody[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = bodies.shift();
    if (!next) throw new Error("mkFetch: no more mock responses queued");
    return new Response(next.body, {
      status: next.status ?? 200,
      headers: {
        "content-type": next.contentType,
        ...(next.session ? { "mcp-session-id": next.session } : {}),
      },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A fetchImpl that never resolves unless its request's AbortSignal fires. */
function neverResolvingFetch() {
  const calls: { url: string }[] = [];
  const impl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url) });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Dispatches to a different fetchImpl per exact request URL. */
function routedFetch(routes: Record<string, typeof fetch>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const route = routes[String(url)];
    if (!route) throw new Error(`routedFetch: no route registered for ${String(url)}`);
    return route(url, init);
  }) as unknown as typeof fetch;
}

const STORES_URL = "https://openbb.example.ts.net:8444/mcp";

/**
 * Legacy hand-written mock server (pre-fixture era, qwen). Kept alongside the
 * fixture-driven tests below because it exercises something the fixtures
 * don't: a 406 when the client fails to accept text/event-stream, and
 * tools/call / tool-level isError handling for callMcpTool.
 */
const SESSION = "abc123session";

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function mockServer(opts: { tools?: unknown[]; rpcError?: { code: number; message: string }; toolIsError?: boolean } = {}) {
  const calls: { body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ body, headers });

    // The real servers reject a client that will not take an event stream.
    if (!String(headers.Accept ?? "").includes("text/event-stream")) {
      return new Response("Not Acceptable", { status: 406 });
    }

    if (body.method === "initialize") {
      return new Response(
        sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
        }),
        { status: 200, headers: { "mcp-session-id": SESSION, "content-type": "text/event-stream" } }
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/call") {
      if (opts.rpcError) {
        return new Response(sse({ jsonrpc: "2.0", id: body.id, error: opts.rpcError }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (opts.toolIsError) {
        return new Response(
          sse({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "vault is read-only" }] } }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      return new Response(
        sse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Created note" }] } }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (body.method === "tools/list") {
      if (opts.rpcError) {
        return new Response(sse({ jsonrpc: "2.0", id: body.id, error: opts.rpcError }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { tools: opts.tools ?? [] } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
  return { fetchImpl, calls };
}

const TOOL = {
  name: "get_price",
  description: "Get a price",
  inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
};

beforeEach(() => {
  clearMcpCache();
  logError.mockClear();
  logOnce.mockClear();
});

describe("mcpRpc", () => {
  it("parses the real initialize.sse capture (SSE-framed, not plain JSON) and captures the session id", async () => {
    const { impl } = mkFetch([{ body: initializeSse, contentType: "text/event-stream", session: "sess-1" }]);
    const out = await mcpRpc(STORES_URL, "initialize", { a: 1 }, 1, null, impl);
    expect(out.result).toEqual(initializeResult);
    expect(out.sessionId).toBe("sess-1");
  });

  it("sends MCP-Protocol-Version on every call, and echoes Mcp-Session-Id once one is known", async () => {
    const { impl, calls } = mkFetch([{ body: initializeSse, contentType: "text/event-stream", session: "sess-1" }]);
    await mcpRpc(STORES_URL, "initialize", {}, 1, "prior-session", impl);
    const h = new Headers(calls[0].init.headers);
    expect(h.get("MCP-Protocol-Version")).toBe("2025-06-18");
    expect(h.get("Mcp-Session-Id")).toBe("prior-session");
  });

  it("accepts both application/json and text/event-stream on every request", async () => {
    // application/json alone gets a 406 from the real servers, which is what
    // made discovery silently return nothing.
    const { fetchImpl, calls } = mockServer({ tools: [TOOL] });
    const tools = await discoverMcpTools("openbb", "https://mcp.test/mcp", fetchImpl as any);

    expect(tools).toHaveLength(1);
    for (const c of calls) {
      expect(c.headers.Accept).toContain("application/json");
      expect(c.headers.Accept).toContain("text/event-stream");
    }
  });

  it("negotiates protocol version 2025-06-18 in both the request body and header", async () => {
    const { fetchImpl, calls } = mockServer({ tools: [TOOL] });
    await discoverMcpTools("openbb", "https://mcp.test/mcp", fetchImpl as any);

    expect(calls[0].body.params.protocolVersion).toBe("2025-06-18");
    expect(calls[0].headers["MCP-Protocol-Version"]).toBe("2025-06-18");
  });

  it("raises on JSON-RPC errors (synthetic — never observed live; the captured servers never errored)", async () => {
    const { impl } = mkFetch([{
      body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}',
      contentType: "application/json",
    }]);
    await expect(mcpRpc(STORES_URL, "tools/call", {}, 1, null, impl))
      .rejects.toThrow(/nope/);
  });

  it("throws 'unparseable' for a 200 response whose body is neither JSON nor SSE " +
    "(synthetic — this is the failure path assembleTools relies on to skip a broken server)", async () => {
    const { impl } = mkFetch([{ body: "boom", contentType: "text/plain" }]);
    await expect(mcpRpc(STORES_URL, "tools/list", {}, 1, null, impl))
      .rejects.toThrow(/unparseable/);
  });

  it("aborts and throws a clear timeout error when fetchImpl never resolves", async () => {
    const { impl } = neverResolvingFetch();
    await expect(mcpRpc(STORES_URL, "initialize", {}, 1, null, impl, 20))
      .rejects.toThrow(/timed out after 20ms calling/);
  });

  it("includes a preview of the response body in the thrown error on a non-OK, non-202 response", async () => {
    const { impl } = mkFetch([{ body: "Missing session ID", contentType: "text/plain", status: 400 }]);
    await expect(mcpRpc(STORES_URL, "tools/list", {}, 2, "sess", impl))
      .rejects.toThrow(/HTTP 400.*Missing session ID/s);
  });

  it("truncates an overly long error body preview instead of inlining it whole", async () => {
    const longBody = "x".repeat(600);
    const { impl } = mkFetch([{ body: longBody, contentType: "text/plain", status: 400 }]);
    let caught: Error | undefined;
    try {
      await mcpRpc(STORES_URL, "tools/list", {}, 2, null, impl);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("…");
    expect(caught!.message.length).toBeLessThan(700);
  });

  it("drains the response body on the notification path so no fetch handle is left open", async () => {
    let capturedRes: Response | undefined;
    const impl = vi.fn(async () => {
      const res = new Response("", { status: 202, headers: { "content-type": "application/json" } });
      capturedRes = res;
      return res;
    }) as unknown as typeof fetch;
    await mcpRpc(STORES_URL, "notifications/initialized", undefined, null, null, impl);
    expect(capturedRes?.bodyUsed).toBe(true);
  });

  it("matches the SSE response event by request id, skipping an earlier progress/ping event", async () => {
    const sseBody =
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n' +
      'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\r\n\r\n';
    const { impl } = mkFetch([{ body: sseBody, contentType: "text/event-stream" }]);
    const out = await mcpRpc(STORES_URL, "tools/list", {}, 2, null, impl);
    expect(out.result).toEqual({ tools: [] });
  });

  it("fails loudly instead of silently returning {result:null} when no SSE event matches the request id", async () => {
    const sseBody = 'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n';
    const { impl } = mkFetch([{ body: sseBody, contentType: "text/event-stream" }]);
    await expect(mcpRpc(STORES_URL, "tools/list", {}, 2, null, impl))
      .rejects.toThrow(/unparseable/);
  });

  it("does not accept a record-shaped SSE event carrying a different id than the request", async () => {
    const sseBody = 'event: message\r\ndata: {"jsonrpc":"2.0","id":999,"result":{"tools":[]}}\r\n\r\n';
    const { impl } = mkFetch([{ body: sseBody, contentType: "text/event-stream" }]);
    await expect(mcpRpc(STORES_URL, "tools/list", {}, 2, null, impl))
      .rejects.toThrow(/unparseable/);
  });
});

describe("discoverMcpTools", () => {
  it("runs initialize -> notifications/initialized -> tools/list against the real fixture bytes, " +
    "mapping camelCase inputSchema to snake_case input_schema for all 6 real tools", async () => {
    const { impl, calls } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream", session: "sess-9" },
      { body: "", contentType: "application/json", status: 202 }, // notifications/initialized
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const tools = await discoverMcpTools("stores-mcp", STORES_URL, impl);

    expect(tools).toEqual(rawTools.map((t) => ({
      server_id: "stores-mcp",
      name: t.name,
      url: STORES_URL,
      endpoint: "",
      description: t.description,
      input_schema: t.inputSchema,
    })));
    expect(tools.map((t) => t.name)).toEqual([
      "arctic_list_libraries", "arctic_list_symbols", "arctic_read",
      "kdb_tables", "kdb_table_schema", "kdb_select",
    ]);

    const init = JSON.parse(String(calls[0].init.body));
    expect(init).toEqual({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bdobb", version: "0.1.0" },
      },
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      jsonrpc: "2.0", method: "notifications/initialized",
    });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });

    // the session id captured off `initialize`'s response header must be
    // echoed on both later calls
    const h1 = new Headers(calls[0].init.headers);
    const h2 = new Headers(calls[1].init.headers);
    const h3 = new Headers(calls[2].init.headers);
    expect(h1.get("Mcp-Session-Id")).toBeNull();
    expect(h2.get("Mcp-Session-Id")).toBe("sess-9");
    expect(h3.get("Mcp-Session-Id")).toBe("sess-9");
  });

  it("surfaces a JSON-RPC error rather than returning an empty tool list", async () => {
    const { fetchImpl } = mockServer({ rpcError: { code: -32602, message: "unsupported" } });
    await expect(
      discoverMcpTools("openbb", "https://mcp.test/mcp", fetchImpl as any)
    ).rejects.toThrow(/-32602 unsupported/);
  });

  it("caches per url within the app session: a second call makes no further HTTP requests", async () => {
    const { impl } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const first = await discoverMcpTools("s1", STORES_URL, impl);
    const again = await discoverMcpTools("s1", STORES_URL, impl);
    expect(again).toEqual(first);
    expect(again).toHaveLength(6);
    expect(impl).toHaveBeenCalledTimes(3); // no extra calls on the cached lookup
  });

  it("clearMcpCache() forces re-discovery", async () => {
    const { impl } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    await discoverMcpTools("s1", STORES_URL, impl);
    clearMcpCache();
    await discoverMcpTools("s1", STORES_URL, impl);
    expect(impl).toHaveBeenCalledTimes(6);
  });

  it("follows nextCursor across multiple tools/list pages instead of returning only page 1", async () => {
    const page1 = {
      jsonrpc: "2.0", id: 2,
      result: { tools: [{ name: "a", description: "d", inputSchema: {} }], nextCursor: "p2" },
    };
    const page2 = {
      jsonrpc: "2.0", id: 3,
      result: { tools: [{ name: "b", description: "d", inputSchema: {} }] },
    };
    const { impl, calls } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: JSON.stringify(page1), contentType: "application/json" },
      { body: JSON.stringify(page2), contentType: "application/json" },
    ]);
    const tools = await discoverMcpTools("s", STORES_URL, impl);
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({
      jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "p2" },
    });
  });

  it("returns a copy of the tool array, not a live reference to the cache", async () => {
    const { impl } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const first = await discoverMcpTools("s1", STORES_URL, impl);
    first.push({
      server_id: "mutated", name: "injected", url: "x", endpoint: "", description: "", input_schema: {},
    });
    expect(first).toHaveLength(7);
    const second = await discoverMcpTools("s1", STORES_URL, impl); // cache hit
    expect(second).toHaveLength(6); // the mutation of `first` must not reach the cache
  });

  it("caches by url, not serverId: a second call for the same url with a different serverId still hits the cache", async () => {
    const { impl } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const first = await discoverMcpTools("server-a", STORES_URL, impl);
    const second = await discoverMcpTools("server-b", STORES_URL, impl);
    expect(impl).toHaveBeenCalledTimes(3); // no second discovery round trip
    expect(second).toEqual(first); // cache hit returns the (server-a-labeled) cached entry
  });

  it("does not negatively cache a failed discovery: a later call for the same url retries instead of returning []", async () => {
    const bodies: MockBody[] = [{ body: "boom", contentType: "text/plain" }];
    const { impl } = mkFetch(bodies);
    await expect(discoverMcpTools("s1", STORES_URL, impl)).rejects.toThrow(/unparseable/);

    // queue a successful round trip and retry the same url
    bodies.push(
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" }
    );
    const retried = await discoverMcpTools("s1", STORES_URL, impl);
    expect(retried).toHaveLength(6);
    expect(impl).toHaveBeenCalledTimes(4); // 1 failed + 3 for the successful retry
  });
});

describe("assembleTools", () => {
  it("unions enabled Settings servers with dashboard widgets' storage.mcpUrl, deduplicated by url, " +
    "ignoring disabled servers and skipping (not throwing on) a server that fails", async () => {
    // Each target discovers concurrently, so a single shared mock queue can't
    // assume server A's calls land before server B's — route by exact url
    // instead so ordering doesn't matter.
    const { impl: aImpl, calls: aCalls } = mkFetch([
      // server A (Settings, enabled) succeeds: initialize, notifications/initialized, tools/list
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const { impl: bImpl, calls: bCalls } = mkFetch([
      // server B (widget storage.mcpUrl) fails on initialize (synthetic: unparseable body)
      { body: "boom", contentType: "text/plain" },
    ]);
    const fetchImpl = routedFetch({ "http://mcp/a": aImpl, "http://mcp/b": bImpl });

    const result = await assembleTools(
      [
        { id: "stores-mcp", url: "http://mcp/a", enabled: true },
        { id: "disabled", url: "http://mcp/off", enabled: false },
      ],
      [{ widgetId: "portfolio_iframe", url: "http://mcp/b" }],
      fetchImpl
    );
    expect(result.tools).toHaveLength(6);
    expect(result.tools!.every((t) => t.server_id === "stores-mcp")).toBe(true);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("http://mcp/b"));

    // A disabled Settings server must never be contacted at all.
    expect(aCalls).toHaveLength(3);
    expect(bCalls).toHaveLength(1);
    expect(logError).not.toHaveBeenCalledWith(expect.stringContaining("http://mcp/off"));
  });

  it("a settings server and a widget mcpUrl pointing at the same url are deduplicated into one discovery call", async () => {
    const { impl, calls } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const result = await assembleTools(
      [{ id: "stores-mcp", url: "http://mcp/shared", enabled: true }],
      [{ widgetId: "some_widget", url: "http://mcp/shared" }],
      impl
    );
    expect(result.tools).toHaveLength(6);
    expect(calls).toHaveLength(3); // one discovery round trip, not two
  });

  it("dedupes a Settings url and a widget mcpUrl differing only by a trailing slash into one discovery call", async () => {
    const { impl, calls } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const result = await assembleTools(
      [{ id: "stores-mcp", url: "https://host:8444/mcp", enabled: true }],
      [{ widgetId: "w", url: "https://host:8444/mcp/" }],
      impl
    );
    expect(result.tools).toHaveLength(6);
    expect(calls).toHaveLength(3); // one discovery round trip, not two
  });

  it("returns null tools when nothing resolves because the only server is unreachable", async () => {
    const { impl } = mkFetch([{ body: "boom", contentType: "text/plain" }]);
    const result = await assembleTools([{ id: "a", url: "http://mcp/a", enabled: true }], [], impl);
    expect(result.tools).toBeNull();
    expect(result.budgetExceeded).toEqual([]);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("http://mcp/a"));
  });

  it("returns null tools (not an empty array) when discovery succeeds but the server advertises zero tools", async () => {
    // A server can be perfectly healthy and simply have nothing to offer —
    // distinct from the unreachable/timeout/budget-exceeded failure paths
    // above, and from `unreachable/budgetExceeded` (both stay empty here).
    const { fetchImpl } = mockServer({ tools: [] });
    const result = await assembleTools(
      [{ id: "openbb", url: "https://a.test/mcp", enabled: true }],
      [],
      fetchImpl as any
    );
    expect(result.tools).toBeNull();
    expect(result.unreachable).toEqual([]);
    expect(result.budgetExceeded).toEqual([]);
  });

  // A rejected discovery must be surfaced structurally, not just logged, so
  // the UI can mark the specific offending server instead of rendering a
  // plain "N tool(s) available" as if nothing were wrong.
  describe("unreachable servers", () => {
    it("surfaces a failed discovery in `unreachable`, naming the server and url", async () => {
      const { impl } = mkFetch([{ body: "boom", contentType: "text/plain" }]);
      const result = await assembleTools(
        [{ id: "dead", url: "http://mcp/dead", enabled: true }],
        [],
        impl
      );
      expect(result.tools).toBeNull();
      expect(result.unreachable).toHaveLength(1);
      expect(result.unreachable[0].serverId).toBe("dead");
      expect(result.unreachable[0].url).toBe("http://mcp/dead");
      expect(result.unreachable[0].message).toContain("http://mcp/dead");
    });

    it("one server down and one healthy: the healthy server's tools ship and only the dead one is reported", async () => {
      const { impl: deadImpl } = mkFetch([{ body: "boom", contentType: "text/plain" }]);
      const { impl: okImpl } = mkFetch([
        { body: initializeSse, contentType: "text/event-stream" },
        { body: "", contentType: "application/json", status: 202 },
        { body: toolsListSse, contentType: "text/event-stream" },
      ]);
      const fetchImpl = routedFetch({ "http://mcp/dead": deadImpl, "http://mcp/ok": okImpl });

      const result = await assembleTools(
        [
          { id: "dead", url: "http://mcp/dead", enabled: true },
          { id: "ok", url: "http://mcp/ok", enabled: true },
        ],
        [],
        fetchImpl
      );
      expect(result.tools).toHaveLength(6);
      expect(result.tools!.every((t) => t.server_id === "ok")).toBe(true);
      expect(result.unreachable).toHaveLength(1);
      expect(result.unreachable[0].serverId).toBe("dead");
      expect(result.budgetExceeded).toEqual([]);
    });

    it("a healthy server yields an empty `unreachable` array", async () => {
      const { impl } = mkFetch([
        { body: initializeSse, contentType: "text/event-stream" },
        { body: "", contentType: "application/json", status: 202 },
        { body: toolsListSse, contentType: "text/event-stream" },
      ]);
      const result = await assembleTools([{ id: "stores-mcp", url: STORES_URL, enabled: true }], [], impl);
      expect(result.unreachable).toEqual([]);
    });
  });

  it("a hanging MCP server times out without blocking discovery of the other servers", async () => {
    const { impl: hangImpl } = neverResolvingFetch();
    const { impl: okImpl } = mkFetch([
      { body: initializeSse, contentType: "text/event-stream" },
      { body: "", contentType: "application/json", status: 202 },
      { body: toolsListSse, contentType: "text/event-stream" },
    ]);
    const fetchImpl = routedFetch({ "http://mcp/ok": okImpl, "http://mcp/hang": hangImpl });

    const result = await assembleTools(
      [
        { id: "ok", url: "http://mcp/ok", enabled: true },
        { id: "hang", url: "http://mcp/hang", enabled: true },
      ],
      [],
      fetchImpl,
      20 // small timeout so the test doesn't wait the real 10s default
    );
    expect(result.tools).toHaveLength(6);
    expect(result.tools!.every((t) => t.server_id === "ok")).toBe(true);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("timed out after 20ms"));
  });

  it("two hanging servers time out concurrently, not sequentially", async () => {
    const { impl: hang1 } = neverResolvingFetch();
    const { impl: hang2 } = neverResolvingFetch();
    const fetchImpl = routedFetch({ "http://mcp/hang1": hang1, "http://mcp/hang2": hang2 });

    const start = Date.now();
    const result = await assembleTools(
      [
        { id: "h1", url: "http://mcp/hang1", enabled: true },
        { id: "h2", url: "http://mcp/hang2", enabled: true },
      ],
      [],
      fetchImpl,
      30
    );
    const elapsed = Date.now() - start;
    expect(result.tools).toBeNull();
    // A sequential loop would wait out h1's full timeout, then h2's (~60ms+).
    // Concurrent discovery waits both at once. Generous slack for CI jitter,
    // but well under the ~2x a sequential loop would take.
    expect(elapsed).toBeLessThan(90);
  });

  describe("tool payload budget", () => {
    it("skips a server whose tools blow the payload budget, keeping the rest that still fits " +
      "(the running total is shared across all servers, not per server — Rita's context slot is one " +
      "shared pool, so a fat server queued first must not starve a lean one queued behind it)", async () => {
      // Measured against the live OpenBB MCP server: without --tool-discovery it
      // exposes 219 tools, ~150k tokens of descriptors, against Rita's 65,536-token
      // slot. Rita rejects that request outright, so sending it does not degrade
      // chat, it stops it.
      const fat = Array.from({ length: 400 }, (_, i) => ({
        name: `fat_tool_${i}`,
        description: "x".repeat(400),
        inputSchema: { type: "object" },
      }));
      const lean = [{ name: "arctic_read", description: "read a symbol", inputSchema: {} }];

      const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "initialize") {
          return new Response(sse({ jsonrpc: "2.0", id: body.id, result: {} }), {
            status: 200,
            headers: { "mcp-session-id": SESSION, "content-type": "text/event-stream" },
          });
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const tools = String(url).includes("fat.test") ? fat : lean;
        return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { tools } }), { status: 200, headers: { "content-type": "text/event-stream" } });
      });

      const result = await assembleTools(
        [
          { id: "openbb", url: "https://fat.test/mcp", enabled: true },
          { id: "stores", url: "https://lean.test/mcp", enabled: true },
        ],
        [],
        fetchImpl as any
      );

      expect(result.tools!.map((t) => t.name)).toEqual(["arctic_read"]);
      expect(JSON.stringify(result.tools).length).toBeLessThanOrEqual(TOOL_PAYLOAD_BUDGET_CHARS);
      expect(result.budgetExceeded).toHaveLength(1);
      expect(result.budgetExceeded[0].serverId).toBe("openbb");
      const logged = logError.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("openbb");
      expect(logged).toContain("--tool-discovery");
    });

    it("drops a server's tools entirely (never truncates) when its serialized size exceeds the budget, " +
      "and surfaces a budgetExceeded entry with a user-facing message naming the server and size " +
      "(synthetic: the real OpenBB MCP server was probed live and returns 219 tools over 570KB — too " +
      "large to fetch in the automated suite, so this pins the policy with a fabricated 300-tool response)", async () => {
      const manyTools = Array.from({ length: 300 }, (_, i) => ({
        name: `tool_${i}`, description: "x".repeat(300), inputSchema: { type: "object" },
      }));
      const { impl } = mkFetch([
        { body: '{"jsonrpc":"2.0","id":1,"result":{}}', contentType: "application/json" },
        { body: "", contentType: "application/json", status: 202 },
        {
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: manyTools } }),
          contentType: "application/json",
        },
      ]);
      const result = await assembleTools([{ id: "big", url: "http://mcp/big", enabled: true }], [], impl);

      expect(result.tools).toBeNull(); // the only server's tools were dropped entirely, not truncated
      expect(result.budgetExceeded).toHaveLength(1);
      const entry = result.budgetExceeded[0];
      expect(entry.serverId).toBe("big");
      expect(entry.url).toBe("http://mcp/big");
      expect(entry.toolCount).toBe(300);
      expect(entry.payloadChars).toBeGreaterThan(TOOL_PAYLOAD_BUDGET_CHARS);
      expect(entry.message).toContain("http://mcp/big");
      expect(entry.message).toContain("300 tools");
      expect(entry.message).toContain("exceeding the request budget");
      // also logged, so it shows up in the log file even before a chat-pane
      // banner renders it.
      expect(logError).toHaveBeenCalledWith(entry.message);
    });

    it("a server under budget is unaffected: its tools ship and budgetExceeded is empty", async () => {
      const { impl } = mkFetch([
        { body: initializeSse, contentType: "text/event-stream" },
        { body: "", contentType: "application/json", status: 202 },
        { body: toolsListSse, contentType: "text/event-stream" },
      ]);
      const result = await assembleTools([{ id: "stores-mcp", url: STORES_URL, enabled: true }], [], impl);
      expect(result.tools).toHaveLength(6);
      expect(result.budgetExceeded).toEqual([]);
    });

    it("one server over budget and one under: the compliant server's tools ship, the offending one is dropped and reported", async () => {
      const manyTools = Array.from({ length: 300 }, (_, i) => ({
        name: `tool_${i}`, description: "x".repeat(300), inputSchema: { type: "object" },
      }));
      const { impl: bigImpl } = mkFetch([
        { body: '{"jsonrpc":"2.0","id":1,"result":{}}', contentType: "application/json" },
        { body: "", contentType: "application/json", status: 202 },
        {
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: manyTools } }),
          contentType: "application/json",
        },
      ]);
      const { impl: okImpl } = mkFetch([
        { body: initializeSse, contentType: "text/event-stream" },
        { body: "", contentType: "application/json", status: 202 },
        { body: toolsListSse, contentType: "text/event-stream" },
      ]);
      const fetchImpl = routedFetch({ "http://mcp/big": bigImpl, "http://mcp/ok": okImpl });

      const result = await assembleTools(
        [
          { id: "big", url: "http://mcp/big", enabled: true },
          { id: "ok", url: "http://mcp/ok", enabled: true },
        ],
        [],
        fetchImpl
      );
      expect(result.tools).toHaveLength(6);
      expect(result.tools!.every((t) => t.server_id === "ok")).toBe(true);
      expect(result.budgetExceeded).toHaveLength(1);
      expect(result.budgetExceeded[0].url).toBe("http://mcp/big");
    });
  });
});

describe("callMcpTool", () => {
  it("handshakes, then calls the tool with its arguments", async () => {
    const { fetchImpl, calls } = mockServer();
    const res = await callMcpTool(
      "https://mcp.test/mcp",
      "create_note",
      { path: "chats/x.md", content: "# hi" },
      fetchImpl as any
    );

    expect(calls.map((c) => c.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    const call = calls[2].body;
    expect(call.params).toEqual({
      name: "create_note",
      arguments: { path: "chats/x.md", content: "# hi" },
    });
    // Every post-handshake request must carry the session.
    expect(calls[2].headers["Mcp-Session-Id"]).toBe(SESSION);
    expect(res.content[0].text).toBe("Created note");
  });

  it("throws on a tool-level failure reported via isError", async () => {
    // MCP reports a failing tool as isError on an otherwise 200 response, not
    // as a JSON-RPC error — treating that as success would silently lose data.
    const { fetchImpl } = mockServer({ toolIsError: true });
    await expect(
      callMcpTool("https://mcp.test/mcp", "create_note", {}, fetchImpl as any)
    ).rejects.toThrow(/vault is read-only/);
  });

  it("throws on a JSON-RPC error", async () => {
    const { fetchImpl } = mockServer({ rpcError: { code: -32602, message: "unknown tool" } });
    await expect(
      callMcpTool("https://mcp.test/mcp", "nope", {}, fetchImpl as any)
    ).rejects.toThrow(/unknown tool/);
  });
});
