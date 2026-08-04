import { describe, expect, it, vi } from "vitest";

// getWidgetData routes through plugin-http like every other non-streaming
// request, so stubbing globalThis.fetch no longer intercepts it. Delegating to
// real fetch keeps the stubs in these tests working while preserving the
// assertion that the app uses the plugin.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
import {
  fetchAgentsJson, queryAgent, getWidgetData, buildWidgetRefs, makeWidgetDataFetcher, runAgentQuery,
  type AgentsJson, ChatMessage, AgentEvent, WidgetRef, DashboardCard, WidgetDef,
} from "./agentClient";



const mockAgents: AgentsJson = {
  rita: {
    name: "Rita",
    description: "AI assistant",
    endpoints: { query: "http://localhost:8002/v1/query" },
    features: {},
  },
};

describe("fetchAgentsJson", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches agents.json from backend URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify(mockAgents), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await fetchAgentsJson("http://localhost:8002");

      expect(fetchMock).toHaveBeenCalledWith("http://localhost:8002/agents.json");
      expect(result).toEqual(mockAgents);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("handles trailing slashes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify(mockAgents), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchAgentsJson("http://localhost:8002/");

      expect(fetchMock).toHaveBeenCalledWith("http://localhost:8002/agents.json");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("throws on HTTP error", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchAgentsJson("http://localhost:8002")).rejects
        .toThrow("HTTP 404");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("throws with the status code AND the response body on a non-OK response " +
    "(this was the only network call in the client still discarding the body — desk commit " +
    "03c132a)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("Bad Gateway: upstream Rita unreachable", { status: 502 }));

    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchAgentsJson("http://localhost:8002")).rejects.toThrow(/HTTP 502/);
      await expect(fetchAgentsJson("http://localhost:8002")).rejects
        .toThrow(/upstream Rita unreachable/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Desk's normalizeAgentsJson/normalizeFeatures (ported here, Task 17):
  // agents.json's `features` map is heterogeneous, and a shape neither
  // parent tree has seen yet must be dropped, not thrown on or blindly cast.
  it("normalizes a select-type feature and drops an unrecognized feature shape", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        openbb_agent_rita: {
          name: "Rita",
          description: "",
          endpoints: { query: "/v1/query" },
          features: {
            streaming: true,
            model: {
              label: "Model", type: "select", default: "openai:qwen3-coder",
              options: [{ label: "OpenAI", value: "openai:qwen3-coder" }],
            },
            mystery: { totally: "unrecognized shape" },
          },
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await fetchAgentsJson("http://localhost:8002");
      expect(result.openbb_agent_rita.features.streaming).toBe(true);
      expect(result.openbb_agent_rita.features.model).toEqual({
        label: "Model", type: "select", default: "openai:qwen3-coder",
        options: [{ label: "OpenAI", value: "openai:qwen3-coder" }],
      });
      expect(result.openbb_agent_rita.features.mystery).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("skips an agent entry that isn't an object instead of throwing", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ rita: { name: "Rita", endpoints: { query: "/q" }, features: {} }, broken: "not an object" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await fetchAgentsJson("http://localhost:8002");
      expect(Object.keys(result)).toEqual(["rita"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("falls back to an empty query endpoint when endpoints.query is missing", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ rita: { name: "Rita", features: {} } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await fetchAgentsJson("http://localhost:8002");
      expect(result.rita.endpoints).toEqual({ query: "" });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("queryAgent", () => {
  it("sends query to agent and processes SSE events", async () => {
    const sseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "event: copilotMessageChunk\ndata: {\"delta\":\"hello\"}\n\n" +
          "event: copilotMessageChunk\ndata: {\"delta\":\" world\"}\n\n"
        ));
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const events: AgentEvent[] = [];
    const messages: ChatMessage[] = [{ role: "human", content: "Hello" }];

    await queryAgent("http://localhost:8002", messages, (e) => events.push(e), [], fetchMock as any);

    expect(fetchMock).toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: "chunk", delta: "hello" });
    expect(events[1]).toEqual({ kind: "chunk", delta: " world" });
  });

  it("appends widget refs to request", async () => {
    const sseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: copilotMessageChunk\ndata: {}\n\n"));
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const widgets: WidgetRef[] = [{
      uuid: "abc",
      origin: "NAS",
      widget_id: "widget1",
      name: "Widget",
      description: "A widget",
      params: [],
      metadata: {},
    }];

    await queryAgent("http://localhost:8002", [], () => {}, widgets, fetchMock as any);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    const body = JSON.parse(fetchCallArgs[1]?.body as string);
    expect(body.widgets.primary).toHaveLength(1);
  });
});

describe("getWidgetData", () => {
  const backend = {
    id: "nas",
    name: "OpenBB NAS",
    baseUrl: "https://openbb.example.test",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const widget: WidgetDef = {
    id: "widget1",
    name: "Widget",
    description: "",
    category: "Test",
    subCategory: null,
    type: "table",
    endpoint: "/api/test",
    gridData: { w: 20, h: 12 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: null,
    columnsDefs: null,
    mcpUrl: null,
      backendId: "test",
  };

  it("builds correct URL with params", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ data: [1, 2, 3] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await getWidgetData(backend, widget, { symbol: "AAPL", limit: 10 }, undefined);

    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("symbol=AAPL");
    expect(url).toContain("limit=10");
    expect(result).toEqual({ data: [1, 2, 3] });
  });

  it("handles array params", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    await getWidgetData(backend, widget, { symbols: ["AAPL", "MSFT"] }, undefined);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("symbols=AAPL%2CMSFT");
  });

  it("handles boolean params", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    await getWidgetData(backend, widget, { raw: true, chart: false }, undefined);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("raw=true");
    expect(url).toContain("chart=false");
  });

  it("throws on error", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(null, { status: 500 });
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(getWidgetData(backend, widget, {}, undefined)).rejects
      .toThrow("HTTP 500");
  });

  it("forwards an abort signal through to the underlying HTTP fetch (the dangling `_signal` " +
    "param this used to ignore is now wired to dataClient's fetchWidgetData, Task 6)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    await getWidgetData(backend, widget, {}, controller.signal);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});

describe("buildWidgetRefs", () => {
  it("builds widget refs from dashboard cards", () => {
    const cards: DashboardCard[] = [{
      uuid: "abc-123",
      widgetId: "widget1",
      backendId: "nas",
      layout: { x: 0, y: 0, w: 20, h: 12 },
      params: { symbol: "AAPL" },
      view: "default",
    }];

    const widget: WidgetDef = {
      id: "widget1",
      name: "Widget",
      description: "A widget",
      category: "Test",
      subCategory: null,
      type: "table",
      endpoint: "/api/test",
      gridData: { w: 20, h: 12 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [{
        paramName: "symbol",
        type: "text",
        value: null,
        label: "Symbol",
        description: "Symbol to get",
        show: true,
        multiSelect: false,
        options: null,
        optionsEndpoint: null,
        optionsParams: null,
      }],
      dataKey: null,
      columnsDefs: null,
      mcpUrl: null,
      backendId: "test",
    };

    const refs = buildWidgetRefs(cards, () => widget, () => "OpenBB NAS");
    // origin carries the backend id so the get_widget_data echo resolves;
    // the human-readable name travels in metadata.

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      uuid: "abc-123",
      widget_id: "widget1",
      origin: "nas",
    });
    expect(refs[0].params).toHaveLength(1);
    expect(refs[0].params[0].current_value).toBe("AAPL");
  });

  it("skips unknown widgets", () => {
    const cards: DashboardCard[] = [{
      uuid: "abc-123",
      widgetId: "unknown",
      backendId: "nas",
      layout: { x: 0, y: 0, w: 20, h: 12 },
      params: {},
      view: "default",
    }];

    const refs = buildWidgetRefs(cards, () => undefined, () => "NAS");

    expect(refs).toHaveLength(0);
  });
});

describe("makeWidgetDataFetcher", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("creates a fetcher that calls getWidgetData", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify([{ date: "2026-07-01" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    vi.stubGlobal("fetch", fetchMock);

    const deps = {
      getCards: () => [{
        uuid: "abc-123",
        widgetId: "widget1",
        backendId: "nas",
        layout: { x: 0, y: 0, w: 20, h: 12 },
        params: { symbol: "MSFT" },
        view: "default" as const satisfies import("../../lib/types").CardView,
      }],
      lookupWidget: (_backendId: string, widgetId: string) => {
        if (widgetId === "widget1") {
          return {
            id: "widget1",
            name: "Widget",
            description: "",
            category: "Test",
            subCategory: null,
            type: "table",
            endpoint: "/api/test",
            gridData: { w: 20, h: 12 },
            source: [],
            runButton: false,
            raw: false,
            refetchInterval: null,
            params: [{
              paramName: "symbol",
              type: "text" as const,
              value: null,
              label: "Symbol",
              description: "Symbol to get",
              show: true,
              multiSelect: false,
              options: null,
              optionsEndpoint: null,
              optionsParams: null,
            }],
            dataKey: null,
            columnsDefs: null,
            mcpUrl: null,
      backendId: "test",
          };
        }
        return undefined;
      },
      getBackend: (backendId: string) => {
        if (backendId === "nas") {
          return { id: "nas", name: "NAS", baseUrl: "http://localhost:8000" };
        }
        return undefined;
      },
    };

    const fetcher = makeWidgetDataFetcher(deps);
    const source = {
      widget_uuid: "abc-123",
      origin: "nas",
      id: "widget1",
      input_args: { symbol: "AAPL" },
    };

    const result = await fetcher(source);

    expect(fetchMock).toHaveBeenCalled();
    expect(JSON.parse(result as string)).toHaveLength(1);
  });

  it("forwards an abort signal through to the underlying HTTP fetch (Stop must cancel an " +
    "in-flight widget fetch, not let it run to completion — desk commit 03c132a)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify([{ close: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const widget: WidgetDef = {
      id: "widget1", name: "Widget", description: "", category: "Test", subCategory: null,
      type: "table", endpoint: "/api/test", gridData: { w: 20, h: 12 }, source: [],
      runButton: false, raw: false, refetchInterval: null, params: [], dataKey: null,
      columnsDefs: null, mcpUrl: null, backendId: "test",
    };
    const deps = {
      getCards: () => [{
        uuid: "abc-123", widgetId: "widget1", backendId: "nas",
        layout: { x: 0, y: 0, w: 20, h: 12 }, params: {},
        view: "default" as const satisfies import("../../lib/types").CardView,
      }],
      lookupWidget: () => widget,
      getBackend: () => ({ id: "nas", name: "NAS", baseUrl: "http://localhost:8000" }),
    };

    const fetcher = makeWidgetDataFetcher(deps);
    const controller = new AbortController();
    await fetcher(
      { widget_uuid: "abc-123", origin: "nas", id: "widget1", input_args: {} },
      controller.signal
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("throws if backend not found", async () => {
    const deps = {
      // The card must be on the dashboard, or the scoping check fails first
      // and this stops testing backend resolution.
      getCards: () => [{ uuid: "abc-123" }] as any,
      lookupWidget: () => undefined,
      getBackend: () => undefined,
    };

    const fetcher = makeWidgetDataFetcher(deps);

    await expect(fetcher({ widget_uuid: "abc-123", origin: "unknown", id: "widget", input_args: {} }))
      .rejects
      .toThrow("Backend not found: unknown");
  });
});

describe("execute_agent_tool dispatch", () => {
  const call = {
    function: "execute_agent_tool",
    input_arguments: { server_id: "bdobb-local", tool_name: "create_dashboard", parameters: { name: "Macro" } },
  };

  function sseBodyFor(events: [string, unknown][]) {
    return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  }

  it("routes a declared tool to the runner and returns its output", async () => {
    // Rita wraps every tool in QueryRequest.tools — MCP and local alike — in
    // execute_agent_tool. Before this the client answered "unsupported" to all
    // of them, so MCP tools were discovered, advertised, called and refused.
    const runAgentTool = vi.fn(async () => ({ content: "Created dashboard \"Macro\"." }));
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const first = bodies.length === 1;
      return new Response(
        first
          ? sseBodyFor([["copilotFunctionCall", call]])
          : sseBodyFor([["copilotMessageChunk", { delta: "done" }]]),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "make a dashboard" }],
      fetchWidgetData: async () => "",
      onEvent: () => {},
      runAgentTool,
      fetchImpl: fetchImpl as any,
    });

    expect(runAgentTool).toHaveBeenCalledWith("bdobb-local", "create_dashboard", { name: "Macro" });
    // The result is fed back as a tool message on the next round.
    const toolMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.function).toBe("execute_agent_tool");
    expect(JSON.stringify(toolMsg.data)).toContain("Created dashboard");
  });

  it("reports a tool failure as an error result rather than aborting the turn", async () => {
    const runAgentTool = vi.fn(async () => ({ content: "boom", isError: true }));
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        bodies.length === 1
          ? sseBodyFor([["copilotFunctionCall", call]])
          : sseBodyFor([["copilotMessageChunk", { delta: "ok" }]]),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "x" }],
      fetchWidgetData: async () => "",
      onEvent: () => {},
      runAgentTool,
      fetchImpl: fetchImpl as any,
    });

    const toolMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    expect(JSON.stringify(toolMsg.data)).toContain("tool_failed");
  });

  it("says no handler when the runner does not recognise the server", async () => {
    const runAgentTool = vi.fn(async () => null);
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        bodies.length === 1
          ? sseBodyFor([["copilotFunctionCall", call]])
          : sseBodyFor([["copilotMessageChunk", { delta: "ok" }]]),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "x" }],
      fetchWidgetData: async () => "",
      onEvent: () => {},
      runAgentTool,
      fetchImpl: fetchImpl as any,
    });

    const toolMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    expect(JSON.stringify(toolMsg.data)).toContain("unsupported");
  });
});

describe("get_widget_data round trip — abort propagation", () => {
  function sseBodyFor(events: [string, unknown][]) {
    return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  }

  const call = {
    function: "get_widget_data",
    input_arguments: {
      data_sources: [
        { widget_uuid: "card-1", origin: "nas", id: "w1", input_args: { symbol: "AAPL" } },
      ],
    },
    extra_state: {},
  };

  it("forwards runAgentQuery's caller signal to the widget-data fetcher (desk commit " +
    "03c132a, Finding 1: Stop must cancel an in-flight get_widget_data fetch)", async () => {
    const controller = new AbortController();
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        bodies.length === 1
          ? sseBodyFor([["copilotFunctionCall", call]])
          : sseBodyFor([["copilotMessageChunk", { delta: "done" }]]),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const fetchWidgetData = vi.fn(async () => JSON.stringify([{ close: 1 }]));

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "what did AAPL close at?" }],
      signal: controller.signal,
      fetchWidgetData,
      onEvent: () => {},
      fetchImpl: fetchImpl as any,
    });

    expect(fetchWidgetData).toHaveBeenCalledWith(
      call.input_arguments.data_sources[0],
      controller.signal
    );
  });

  it("does not pass a signal at all when the caller omitted one, preserving the exact " +
    "single-argument call shape existing WidgetDataFetcher test doubles assert on", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        bodies.length === 1
          ? sseBodyFor([["copilotFunctionCall", call]])
          : sseBodyFor([["copilotMessageChunk", { delta: "done" }]]),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const fetchWidgetData = vi.fn(async () => JSON.stringify([{ close: 1 }]));

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "what did AAPL close at?" }],
      fetchWidgetData,
      onEvent: () => {},
      fetchImpl: fetchImpl as any,
    });

    expect(fetchWidgetData).toHaveBeenCalledWith(call.input_arguments.data_sources[0]);
  });
});

// Reviewer follow-up (Task 17): desk threads the discovered agents.json
// `model` feature into every query (ChatPane.tsx:252,324 -> workspace_options
// on the wire); `runAgentQuery` already accepted `workspaceOptions` and
// serialized it (see `body.workspace_options` above), but nothing asserted
// it actually lands in the request body, and chatStore never forwarded it
// from ChatPane at all (fixed in chatStore.ts/ChatPane.tsx, this same task).
describe("runAgentQuery — workspace_options", () => {
  function sseBodyFor(events: [string, unknown][]) {
    return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  }

  it("serializes workspaceOptions into the request body's workspace_options", async () => {
    const sent: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(sseBodyFor([["copilotMessageChunk", { delta: "hi" }]]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: () => {},
      fetchWidgetData: async () => "[]",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workspaceOptions: { model: "openai:qwen3-coder" },
    });

    expect(sent[0].workspace_options).toEqual({ model: "openai:qwen3-coder" });
  });

  it("defaults workspace_options to {} when workspaceOptions is not provided", async () => {
    const sent: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(sseBodyFor([["copilotMessageChunk", { delta: "hi" }]]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: () => {},
      fetchWidgetData: async () => "[]",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(sent[0].workspace_options).toEqual({});
  });
});

describe("runAgentQuery — per-round timeout", () => {
  function sseBodyFor(events: [string, unknown][]) {
    return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  }

  it("does not time out mid-round when timeoutMs is 0 (disabled)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(sseBodyFor([["copilotMessageChunk", { delta: "hi" }]]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));

    const appended = await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: () => {},
      fetchWidgetData: async () => "[]",
      fetchImpl: fetchImpl as any,
      timeoutMs: 0,
    });

    expect(appended[appended.length - 1]).toEqual({ role: "ai", content: "hi" });
  });

  it("aborts and throws a clear error when a round produces nothing within timeoutMs " +
    "(desk commit 03c132a, Finding 7: the exact same request body once hung with zero " +
    "bytes for 120s, then completed in 12s on retry — without this the only escape was " +
    "the user pressing Stop)", async () => {
    vi.useFakeTimers();
    try {
      const impl = vi.fn((_u: any, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

      const promise = runAgentQuery({
        queryUrl: "https://rita.test/v1/query",
        messages: [{ role: "human", content: "hi" }],
        onEvent: () => {},
        fetchWidgetData: async () => "[]",
        fetchImpl: impl,
        timeoutMs: 1000,
      });

      const assertion = expect(promise).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still aborts the underlying fetch when the caller's own signal aborts, independent " +
    "of the timeout (Stop must keep working exactly as before)", async () => {
    const ctrl = new AbortController();
    const impl = vi.fn(async (_u: any, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      ctrl.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response("nope", { status: 500 });
    });

    await expect(
      runAgentQuery({
        queryUrl: "https://rita.test/v1/query",
        messages: [{ role: "human", content: "hi" }],
        signal: ctrl.signal,
        onEvent: () => {},
        fetchWidgetData: async () => "[]",
        fetchImpl: impl as any,
      })
    ).rejects.toThrow(/HTTP 500/);
  });
});

