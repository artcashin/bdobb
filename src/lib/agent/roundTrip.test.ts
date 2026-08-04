import { describe, expect, it, vi } from "vitest";

// getWidgetData routes through plugin-http like every other non-streaming
// request, so stubbing globalThis.fetch no longer intercepts it. Delegating to
// real fetch keeps the stubs in these tests working while preserving the
// assertion that the app uses the plugin.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
import { runAgentQuery, buildWidgetRefs, makeWidgetDataFetcher } from "./agentClient";
import type { AgentEvent } from "./types";
import type { BackendConfig, DashboardCard, WidgetDef } from "../types";

/** Builds an SSE body from event/data pairs, framed the way Rita frames them. */
function sseBody(events: [string, unknown][]): ReadableStream<Uint8Array> {
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

const CALL = {
  function: "get_widget_data",
  input_arguments: {
    data_sources: [
      { widget_uuid: "card-1", origin: "nas", id: "w1", input_args: { symbol: "AAPL" } },
    ],
  },
  extra_state: { trace: "xyz" },
};

describe("runAgentQuery get_widget_data round trip", () => {
  it("answers a function call and re-queries with the tool result", async () => {
    const bodies = [
      // Round 1: the agent asks for data.
      sseBody([["copilotFunctionCall", CALL]]),
      // Round 2: with the data in history, it answers.
      sseBody([["copilotMessageChunk", { delta: "AAPL closed at 294." }]]),
    ];
    const sent: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(bodies.shift()!, { status: 200 });
    });

    const fetchWidgetData = vi.fn(async () => JSON.stringify([{ close: 294 }]));
    const events: AgentEvent[] = [];

    const appended = await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "what did AAPL close at?" }],
      onEvent: (e) => events.push(e),
      fetchWidgetData,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Two POSTs: the question, then the same conversation plus the tool result.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchWidgetData).toHaveBeenCalledWith(CALL.input_arguments.data_sources[0]);

    // The second request carries the function-call echo and the tool result.
    const secondTurn = sent[1].messages;
    expect(secondTurn).toHaveLength(3);
    expect(secondTurn[1]).toEqual({
      role: "ai",
      content: { function: "get_widget_data", input_arguments: CALL.input_arguments },
    });
    expect(secondTurn[2].role).toBe("tool");
    expect(secondTurn[2].data[0].items[0].content).toBe(JSON.stringify([{ close: 294 }]));

    // extra_state must round-trip verbatim so the agent can resume its trace.
    expect(secondTurn[2].extra_state).toEqual({ trace: "xyz" });

    // Caller gets the protocol messages plus the final text.
    expect(appended.map((m) => m.role)).toEqual(["ai", "tool", "ai"]);
    expect(appended[2]).toEqual({ role: "ai", content: "AAPL closed at 294." });
    expect(events.filter((e) => e.kind === "chunk")).toHaveLength(1);
  });

  it("reports a failed fetch as a tool error instead of aborting the turn", async () => {
    const bodies = [
      sseBody([["copilotFunctionCall", CALL]]),
      sseBody([["copilotMessageChunk", { delta: "I could not read that widget." }]]),
    ];
    const sent: any[] = [];
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(bodies.shift()!, { status: 200 });
    });

    const appended = await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: () => {},
      fetchWidgetData: async () => {
        throw new Error("backend offline");
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const toolMsg = sent[1].messages[2];
    expect(toolMsg.data[0].error_type).toBe("fetch_failed");
    expect(toolMsg.data[0].content).toContain("backend offline");
    // The turn still completes with an answer.
    expect(appended[appended.length - 1]).toEqual({
      role: "ai",
      content: "I could not read that widget.",
    });
  });

  it("rejects a function it does not implement without failing the turn", async () => {
    const bodies = [
      sseBody([["copilotFunctionCall", { function: "launch_missiles", input_arguments: {} }]]),
      sseBody([["copilotMessageChunk", { delta: "ok" }]]),
    ];
    const sent: any[] = [];
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(bodies.shift()!, { status: 200 });
    });

    await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: () => {},
      fetchWidgetData: async () => "unused",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(sent[1].messages[2].data[0].error_type).toBe("unsupported");
  });

  it("returns immediately when the agent asks for nothing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(sseBody([["copilotMessageChunk", { delta: "hello" }]]), { status: 200 })
    );
    const appended = await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: () => {},
      fetchWidgetData: async () => "unused",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(appended).toEqual([{ role: "ai", content: "hello" }]);
  });

  it("stops after maxFunctionRounds rather than looping forever", async () => {
    // An agent that always asks again would otherwise spin indefinitely.
    const fetchImpl = vi.fn(
      async () => new Response(sseBody([["copilotFunctionCall", CALL]]), { status: 200 })
    );
    await expect(
      runAgentQuery({
        queryUrl: "https://rita.test/v1/query",
        messages: [{ role: "human", content: "hi" }],
        onEvent: () => {},
        fetchWidgetData: async () => "{}",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxFunctionRounds: 2,
      })
    ).rejects.toThrow(/exceeded 2 function rounds/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // rounds 0,1,2
  });

  it("surfaces the server's error body on a rejected request", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad tools array", { status: 400 }));
    await expect(
      runAgentQuery({
        queryUrl: "https://rita.test/v1/query",
        messages: [{ role: "human", content: "hi" }],
        onEvent: () => {},
        fetchWidgetData: async () => "{}",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/bad tools array/);
  });
});

describe("origin round trip", () => {
  // parseWidgetsJson normalizes a missing endpoint to "", so a real registry
  // entry always has one; the fixture has to as well or it exercises a state
  // the app cannot reach.
  const widget = {
    id: "w1", name: "Hist", description: "d", params: [], endpoint: "/hist", type: "table",
  } as unknown as WidgetDef;
  const card = {
    uuid: "card-1",
    widgetId: "w1",
    backendId: "nas",
    params: {},
  } as unknown as DashboardCard;
  const backend = { id: "nas", name: "OpenBB API", baseUrl: "https://api.test" } as BackendConfig;

  it("sends the backend id as origin so the fetcher can resolve it", async () => {
    // Sending the display name here silently broke every round trip: the
    // fetcher resolves origin against backend ids.
    const refs = buildWidgetRefs(
      [card],
      () => widget,
      (id) => (id === "nas" ? "OpenBB API" : id)
    );
    expect(refs[0].origin).toBe("nas");
    expect(refs[0].metadata).toEqual({ backend_name: "OpenBB API" });

    const fetcher = makeWidgetDataFetcher({
      getCards: () => [card],
      lookupWidget: (backendId, widgetId) =>
        backendId === "nas" && widgetId === "w1" ? widget : undefined,
      getBackend: (id) => (id === backend.id ? backend : undefined),
    });

    // The echoed origin must resolve without throwing "Backend not found".
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ close: 1 }]))));
    await expect(
      fetcher({ widget_uuid: "card-1", origin: refs[0].origin, id: "w1", input_args: {} })
    ).resolves.toContain("close");
    vi.unstubAllGlobals();
  });

  it("refuses to fetch a widget that is not on the active dashboard", async () => {
    const fetcher = makeWidgetDataFetcher({
      getCards: () => [card],
      lookupWidget: () => widget,
      getBackend: () => backend,
    });
    await expect(
      fetcher({ widget_uuid: "not-on-dashboard", origin: "nas", id: "w1", input_args: {} })
    ).rejects.toThrow(/not on the active dashboard/);
  });

  it("fails the turn when the agent reports an error mid-stream", async () => {
    // The stream carries a failure with a 200 status. Treating it as a normal
    // end produced a successful-looking, truncated answer with nothing logged.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sseBody([
            ["copilotMessageChunk", { delta: "Working on it" }],
            ["error", { message: "model backend returned 500" }],
          ]),
          { status: 200 }
        )
    );

    const events: AgentEvent[] = [];
    await expect(
      runAgentQuery({
        queryUrl: "https://rita.test/v1/query",
        messages: [{ role: "human", content: "hi" }],
        onEvent: (e) => events.push(e),
        fetchWidgetData: async () => "{}",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/model backend returned 500/);

    // The error still reaches the UI as an event, so a partial answer is not
    // silently replaced by nothing.
    expect(events.map((e) => e.kind)).toEqual(["chunk", "error"]);
  });

  it("carries a done event through without failing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sseBody([["copilotMessageChunk", { delta: "ok" }], ["done", {}]]),
          { status: 200 }
        )
    );
    const events: AgentEvent[] = [];
    const appended = await runAgentQuery({
      queryUrl: "https://rita.test/v1/query",
      messages: [{ role: "human", content: "hi" }],
      onEvent: (e) => events.push(e),
      fetchWidgetData: async () => "{}",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(events.map((e) => e.kind)).toContain("done");
    expect(appended).toEqual([{ role: "ai", content: "ok" }]);
  });

  it("records each widget request for the exported transcript", async () => {
    // The onCall hook existed and was never passed, so the export's audit
    // section was permanently empty while claiming completeness.
    const calls: unknown[] = [];
    const fetcher = makeWidgetDataFetcher({
      getCards: () => [card],
      lookupWidget: () => widget,
      getBackend: () => backend,
      onCall: (c) => calls.push(c),
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ close: 1 }]))));
    await fetcher({ widget_uuid: "card-1", origin: "nas", id: "w1", input_args: { symbol: "AAPL" } });
    vi.unstubAllGlobals();

    expect(calls).toHaveLength(1);
    const [c] = calls as { kind: string; url: string; ok: boolean; rows?: number; params: unknown }[];
    expect(c.kind).toBe("widget_data");
    expect(c.ok).toBe(true);
    expect(c.rows).toBe(1);
    expect(c.url).toContain("symbol=AAPL");
    expect(c.params).toEqual({ symbol: "AAPL" });
  });

  it("records a failed request too, so a gap in the log is not silent", async () => {
    const calls: { ok?: boolean; error?: string }[] = [];
    const fetcher = makeWidgetDataFetcher({
      getCards: () => [card],
      lookupWidget: () => widget,
      getBackend: () => backend,
      onCall: (c) => calls.push(c),
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(
      fetcher({ widget_uuid: "card-1", origin: "nas", id: "w1", input_args: {} })
    ).rejects.toThrow();
    vi.unstubAllGlobals();

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].error).toBeTruthy();
  });
});
