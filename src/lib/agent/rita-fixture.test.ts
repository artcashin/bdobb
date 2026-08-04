import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { queryAgent } from "./agentClient";
import { sseEvents, toAgentEvent } from "./sse";

/**
 * Replay of a real Agent Rita response, captured from the live agent at
 * a live Agent Rita /v1/query endpoint. The spec asks for SSE parsing
 * to be tested against recorded fixtures rather than hand-written strings,
 * because a hand-written string only encodes what we believe the wire format
 * is. This one is the wire format.
 */
// Path is relative to the vitest root (the project directory).
const FIXTURE = readFileSync("src/test/fixtures/rita-stream.sse", "utf8");

function streamOf(text: string, chunkSize = 64): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

describe("recorded Rita stream", () => {
  it("parses every event in the captured response", async () => {
    const events = [];
    for await (const ev of sseEvents(streamOf(FIXTURE))) events.push(ev);

    // The capture is a plain text answer streamed as deltas.
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => e.event === "copilotMessageChunk")).toBe(true);
    expect(events.every((e) => typeof (e.data as any).delta === "string")).toBe(true);
  });

  it("reassembles the deltas into the agent's answer", async () => {
    let text = "";
    for await (const ev of sseEvents(streamOf(FIXTURE))) {
      const agentEv = toAgentEvent(ev);
      if (agentEv?.kind === "chunk") text += agentEv.delta ?? "";
    }
    expect(text.length).toBeGreaterThan(20);
    expect(text).toMatch(/stock/i);
  });

  it("parses identically when chunk boundaries fall mid-event", async () => {
    // 7 bytes splits `data: {...}` lines apart and lands inside multi-byte
    // sequences, which is what a real socket does.
    const collect = async (size: number) => {
      let text = "";
      for await (const ev of sseEvents(streamOf(FIXTURE, size))) {
        const a = toAgentEvent(ev);
        if (a?.kind === "chunk") text += a.delta ?? "";
      }
      return text;
    };
    expect(await collect(7)).toBe(await collect(4096));
  });
});

describe("queryAgent request shape", () => {
  it("sends urls and tools as arrays, never null", async () => {
    // Rita rejects nulls here with HTTP 400 and the request never reaches the
    // model: {"expected":"array","code":"invalid_type","path":["urls"]}.
    let sent: any = null;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(streamOf(FIXTURE), { status: 200 });
    });

    await queryAgent(
      "https://rita.example",
      [{ role: "human", content: "hi" }],
      () => {},
      [],
      fetchMock as unknown as typeof fetch
    );

    expect(Array.isArray(sent.urls)).toBe(true);
    expect(Array.isArray(sent.tools)).toBe(true);
    expect(sent.urls).not.toBeNull();
    expect(sent.tools).not.toBeNull();
  });

  it("asks for an event stream", async () => {
    let headers: any = null;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      headers = init.headers;
      return new Response(streamOf(FIXTURE), { status: 200 });
    });

    await queryAgent(
      "https://rita.example",
      [{ role: "human", content: "hi" }],
      () => {},
      [],
      fetchMock as unknown as typeof fetch
    );

    expect(headers.Accept).toBe("text/event-stream");
  });

  it("surfaces the server's validation detail on a rejected request", async () => {
    const detail = JSON.stringify({
      error: "Invalid request",
      details: [{ path: ["urls"], message: "expected array, received null" }],
    });
    const fetchMock = vi.fn(async () => new Response(detail, { status: 400 }));

    await expect(
      queryAgent(
        "https://rita.example",
        [{ role: "human", content: "hi" }],
        () => {},
        [],
        fetchMock as unknown as typeof fetch
      )
    ).rejects.toThrow(/expected array, received null/);
  });
});
