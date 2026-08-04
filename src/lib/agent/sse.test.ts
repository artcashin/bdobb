import { beforeEach, describe, expect, it, vi } from "vitest";
import { sseEvents, toAgentEvent } from "./sse";
import type { SseEvent, SseEventType } from "./types";
import {
  functionCallSse, roundtripAnswerSse, simpleTextSse, streamOf as fixtureStreamOf,
} from "../../test/fixtures/rita-stream.fixture";

const logOnce = vi.fn();
const logError = vi.fn();
vi.mock("../logger", () => ({
  logOnce: (...a: [string, string]) => logOnce(...a),
  logError: (...a: [string]) => logError(...a),
}));

beforeEach(() => {
  logOnce.mockClear();
  logError.mockClear();
});

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const ev of sseEvents(stream)) {
    events.push(ev);
  }
  return events;
}

function streamFromText(text: string, chunkSize?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (!chunkSize) {
        controller.enqueue(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
      }
      controller.close();
    },
  });
}

async function collectText(text: string, chunkSize?: number): Promise<SseEvent[]> {
  return collectEvents(streamFromText(text, chunkSize));
}

/** Like `collectText`, but feeds a real captured fixture through `rita-stream.fixture.ts`'s own byte-slicing `streamOf` (default 7-byte reads) rather than `streamFromText`. */
async function collectFixtureText(text: string, chunkSize = 7): Promise<SseEvent[]> {
  return collectEvents(fixtureStreamOf(text, chunkSize));
}

/** Builds a raw-byte stream from literal Uint8Array chunks (can split a multi-byte UTF-8 sequence). */
function bytesStreamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/**
 * Like `streamFromText`, but enqueues chunks one at a time via `pull()`
 * (rather than queueing them all up-front in `start()`) so the stream stays
 * in the "readable" state -- with data genuinely still pending -- for as
 * long as possible. That's what makes `reader.cancel()` observable: per the
 * Streams spec, cancelling a reader whose stream has already fully drained
 * into "closed" is a silent no-op that never reaches the underlying
 * source's `cancel()` callback.
 */
function streamOfWithCancel(
  text: string,
  chunkSize: number,
  onCancel: (reason: unknown) => void
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
}

describe("sseEvents", () => {
  it("parses simple SSE events", async () => {
    const text = "event: copilotMessageChunk\ndata: {\"delta\":\"hello\"}\n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("copilotMessageChunk");
    expect(events[0].data).toEqual({ delta: "hello" });
  });

  it("handles multiple events", async () => {
    const text =
      "event: copilotMessageChunk\ndata: {\"delta\":\"a\"}\n\n" +
      "event: copilotMessageChunk\ndata: {\"delta\":\"b\"}\n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({ delta: "a" });
    expect(events[1].data).toEqual({ delta: "b" });
  });

  it("defaults event name to message", async () => {
    const text = "data: {\"foo\":\"bar\"}\n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message");
    expect(events[0].data).toEqual({ foo: "bar" });
  });

  it("parses an event: line with no space after the colon (Finding 7d)", async () => {
    const events = await collectText('event:copilotMessageChunk\ndata: {"delta":"x"}\n\n');
    expect(events).toEqual([{ event: "copilotMessageChunk", data: { delta: "x" } }]);
  });

  it("ignores comment lines", async () => {
    const text = ": keepalive\nevent: copilotMessageChunk\ndata: {\"delta\":\"x\"}\n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("copilotMessageChunk");
  });

  it("ignores comment and id lines", async () => {
    const events = await collectText(
      ': keepalive\nid: 4\nevent: copilotMessageChunk\ndata: {"delta":"x"}\n\n'
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "x" });
  });

  it("handles CRLF line endings", async () => {
    const text = "event: copilotMessageChunk\r\ndata: {\"delta\":\"crlf\"}\r\n\r\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "crlf" });
  });

  // A single CRLF event is rescued by the end-of-stream flush even when
  // framing is broken, so it must be more than one event to test framing.
  it("frames multiple CRLF-delimited events separately", async () => {
    const text =
      "event: copilotMessageChunk\r\ndata: {\"delta\":\"A\"}\r\n\r\n" +
      "event: copilotMessageChunk\r\ndata: {\"delta\":\"B\"}\r\n\r\n" +
      "event: copilotMessageChunk\r\ndata: {\"delta\":\"C\"}\r\n\r\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.data as { delta: string }).delta)).toEqual(["A", "B", "C"]);
  });

  it("frames CRLF events split across chunk boundaries", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        // The \r and its \n land in different chunks.
        controller.enqueue(enc.encode("event: copilotMessageChunk\r\ndata: {\"delta\":\"A\"}\r"));
        controller.enqueue(enc.encode("\n\r\nevent: copilotMessageChunk\r\ndata: {\"delta\":\"B\"}\r\n\r\n"));
        controller.close();
      },
    });
    const events = await collectEvents(stream);

    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.data as { delta: string }).delta)).toEqual(["A", "B"]);
  });

  it("decodes a multi-byte UTF-8 character even when a chunk boundary splits its bytes " +
    "(an em dash is a 3-byte UTF-8 sequence; a live socket can split it across reads)", async () => {
    const block = 'event: copilotMessageChunk\ndata: {"delta":" —"}\n\n';
    const events = await collectText(block, 1); // 1 byte per read splits the 3-byte UTF-8 sequence
    expect(events).toEqual([{ event: "copilotMessageChunk", data: { delta: " —" } }]);
  });

  it("parses non-JSON data as string and logs the parse failure (Finding 1)", async () => {
    const text = "data: plain text\n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("plain text");
    expect(logOnce).toHaveBeenCalledWith(
      "sse:parse-error:message",
      expect.stringContaining("message")
    );
  });

  it("handles empty data fields", async () => {
    const text = "event: copilotMessageChunk\ndata: \n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  it("joins multi-line data with a real newline (valid multi-line JSON parses)", async () => {
    const text = "data: {\"a\":\ndata: 1}\n\n";
    const events = await collectEvents(streamFromText(text));

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ a: 1 });
  });

  it("joins multi-line data fields with a real newline, not string concatenation " +
    "(Finding 7c: a join of \"\" would silently produce a different, still-parseable value)", async () => {
    // "\n" join => '{"a":1\n0}', which is invalid JSON (two bare values, no
    // comma) and is passed through as the raw string. A join of ""
    // would instead produce the valid-but-wrong '{"a":10}' => { a: 10 },
    // masking the join separator entirely.
    const events = await collectText('data: {"a":1\ndata: 0}\n\n');
    expect(events).toEqual([{ event: "message", data: '{"a":1\n0}' }]);
  });

  it("drops an unterminated trailing block instead of emitting it as a complete event " +
    "(a connection dropped mid-copilotFunctionCall must not surface as a well-typed " +
    "FunctionCallEvent), and logs the truncation", async () => {
    const truncated = 'event: copilotFunctionCall\ndata: {"function":"get_widget_data","input_ar';
    const events = await collectText(truncated);
    expect(events).toEqual([]);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("unterminated trailing block"));
  });

  it("drops a trailing block even when its data is syntactically valid JSON, because it's " +
    "still missing the SSE terminator (regression pin: going back to `parseBlock(buf); if (ev) " +
    "yield ev;` after the loop would resurrect this event, since JSON.parse alone can't tell " +
    "truncated-but-valid-looking apart)", async () => {
    const truncated = 'event: copilotFunctionCall\ndata: {"function":"get_widget_data"}';
    const events = await collectText(truncated);
    expect(events).toEqual([]);
  });

  it("flushes a multi-byte UTF-8 sequence left dangling in the decoder at stream end " +
    "instead of silently discarding it, and logs it as a dropped trailing block", async () => {
    // A complete event, followed by the first two of three bytes of an
    // em dash (0xE2 0x80 0x94) with nothing after -- simulating a
    // connection dropped mid-character. TextDecoder.decode({stream:true})
    // buffers incomplete sequences internally and only emits U+FFFD once
    // flushed with a final (non-streaming) decode() call.
    const good = new TextEncoder().encode('event: copilotMessageChunk\ndata: {"delta":"x"}\n\n');
    const danglingEmDashPrefix = new Uint8Array([0xe2, 0x80]);
    const events = await collectEvents(bytesStreamOf([good, danglingEmDashPrefix]));
    // The complete event still comes through...
    expect(events).toEqual([{ event: "copilotMessageChunk", data: { delta: "x" } }]);
    // ...and the dangling bytes were noticed (flushed into the buffer) and
    // logged, not silently dropped.
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("unterminated trailing block"));
  });

  it("cancels the underlying reader when the caller stops consuming early (Finding 5)", async () => {
    const cancelSpy = vi.fn();
    // Many small events at a small chunk size keep plenty of the stream
    // queued/pending -- i.e. still "readable" -- after the first event comes
    // through and we break.
    const many = Array.from(
      { length: 50 },
      (_, i) => `event: copilotMessageChunk\ndata: {"delta":"${i}"}\n\n`
    ).join("");
    const stream = streamOfWithCancel(many, 5, cancelSpy);
    for await (const _ev of sseEvents(stream)) {
      break; // simulate a caller abandoning the stream (e.g. future Stop button)
    }
    expect(cancelSpy).toHaveBeenCalled();
  });
});

// Deferred from Task 5's merge (see docs/MERGE-NOTES.md): these five load
// real byte-for-byte SSE captures from a live Agent Rita instance via
// src/test/fixtures/rita-stream.fixture.ts, which is scoped to Task 10's file
// list, not Task 5's. The sixth "real captures" test from desk (the
// mid-stream multi-byte-UTF-8-split case, self-contained with no fixture
// dependency) was already ported directly into the `sseEvents` describe above.
describe("sseEvents — real Rita captures", () => {
  it("parses simple-text.sse across tiny chunk boundaries: 32 copilotMessageChunk events", async () => {
    const events = await collectFixtureText(simpleTextSse, 3);
    expect(events).toHaveLength(32);
    expect(events.every((e) => e.event === "copilotMessageChunk")).toBe(true);
    expect(events[0].data).toEqual({ delta: "A" });
  });

  it("chunk boundary placement doesn't change the parse result (3-byte reads vs one whole read)", async () => {
    const tiny = await collectFixtureText(simpleTextSse, 3);
    const whole = await collectFixtureText(simpleTextSse, simpleTextSse.length);
    expect(tiny).toEqual(whole);
  });

  it("parses function-call.sse: one status update, one function call, then the stream ends " +
    "(confirmed live: copilotFunctionCall terminates the stream, nothing follows it)", async () => {
    const events = await collectFixtureText(functionCallSse, 5);
    expect(events.map((e) => e.event)).toEqual([
      "copilotStatusUpdate",
      "copilotFunctionCall",
    ]);
  });

  it("round-trips extra_state verbatim from the real copilotFunctionCall payload", async () => {
    const events = await collectFixtureText(functionCallSse);
    const call = events[1].data as { extra_state: unknown };
    expect(call.extra_state).toEqual({
      copilot_function_call_arguments: {
        widget_queries: [{ widget_uuid: "11111111-2222-3333-4444-555555555555" }],
      },
    });
  });

  it("parses roundtrip-answer.sse: status update (carrying artifacts), 105 message chunks, " +
    "and one citation collection", async () => {
    const events = await collectFixtureText(roundtripAnswerSse, 11);
    expect(events.filter((e) => e.event === "copilotMessageChunk")).toHaveLength(105);
    expect(events.filter((e) => e.event === "copilotStatusUpdate")).toHaveLength(1);
    expect(events.filter((e) => e.event === "copilotCitationCollection")).toHaveLength(1);
    const status = events[0].data as { artifacts?: unknown[] };
    expect(status.artifacts).toHaveLength(1);
  });
});

// The remaining desk "real Rita captures" toAgentEvent case (the unknown-event
// logOnce-dedup test, desk sse.test.ts:261-270) has no fixture dependency and
// was already ported into the general `toAgentEvent` describe below ("maps an
// unknown event to null and calls logOnce with a stable per-event-name key").
describe("toAgentEvent — real Rita captures", () => {
  it("maps a chunk from simple-text.sse", async () => {
    const [chunk] = (await collectFixtureText(simpleTextSse)).map(toAgentEvent);
    expect(chunk).toEqual({ kind: "chunk", delta: "A" });
  });

  it("maps a status update carrying inline artifacts from roundtrip-answer.sse", async () => {
    const [status] = (await collectFixtureText(roundtripAnswerSse)).map(toAgentEvent);
    expect(status).toMatchObject({
      kind: "status",
      status: {
        eventType: "INFO",
        message: 'Loaded "Historical" data.',
        artifacts: [expect.objectContaining({ type: "table", name: "Historical" })],
      },
    });
  });

  it("maps the function call from function-call.sse with extra_state intact; " +
    "the mapped stream has exactly 2 events (status, functionCall)", async () => {
    const events = (await collectFixtureText(functionCallSse)).map(toAgentEvent);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: "functionCall",
      call: {
        function: "get_widget_data",
        extra_state: {
          copilot_function_call_arguments: {
            widget_queries: [{ widget_uuid: "11111111-2222-3333-4444-555555555555" }],
          },
        },
      },
    });
  });

  it("maps citations from roundtrip-answer.sse with the real source_info shape", async () => {
    const events = (await collectFixtureText(roundtripAnswerSse)).map(toAgentEvent);
    const citationsEvent = events.find((e) => e?.kind === "citations");
    expect(citationsEvent).toMatchObject({
      kind: "citations",
      citations: [
        {
          id: "476e27d8-770a-5e1b-b282-541a9dfabd0e",
          source_info: {
            type: "widget",
            origin: "OpenBB NAS",
            widget_id: "equity_price_historical_eodhd_obb",
            citable: true,
          },
        },
      ],
    });
  });
});

describe("toAgentEvent", () => {
  it("maps chunk events", () => {
    const ev = toAgentEvent({
      event: "copilotMessageChunk",
      data: { delta: "hello" },
    });

    expect(ev).toEqual({ kind: "chunk", delta: "hello" });
  });

  it("maps status events, preserving fields not enumerated here (e.g. tool_call, artifacts)", () => {
    const ev = toAgentEvent({
      event: "copilotStatusUpdate",
      data: {
        eventType: "INFO",
        message: "Thinking...",
        group: "reasoning",
        tool_call: { tool_name: "get_widget_data" },
      },
    });

    expect(ev).toEqual({
      kind: "status",
      status: {
        eventType: "INFO",
        message: "Thinking...",
        group: "reasoning",
        hidden: false,
        tool_call: { tool_name: "get_widget_data" },
      },
    });
  });

  it("maps functionCall events", () => {
    const ev = toAgentEvent({
      event: "copilotFunctionCall",
      data: {
        function: "get_widget_data",
        input_arguments: { widget_uuid: "abc" },
        extra_state: { trace: "xyz" },
      },
    });

    expect(ev).toEqual({
      kind: "functionCall",
      call: {
        function: "get_widget_data",
        input_arguments: { widget_uuid: "abc" },
        extra_state: { trace: "xyz" },
      },
    });
  });

  it("maps artifact events", () => {
    const ev = toAgentEvent({
      event: "copilotMessageArtifact",
      data: {
        type: "table",
        name: "AAPL data",
        description: "Historical prices",
        uuid: "123",
        content: [{ date: "2026-07-01" }],
      },
    });

    expect(ev).toEqual({
      kind: "artifact",
      artifact: {
        type: "table",
        name: "AAPL data",
        description: "Historical prices",
        uuid: "123",
        content: [{ date: "2026-07-01" }],
        chart_params: undefined,
      },
    });
  });

  it("maps citations events", () => {
    const ev = toAgentEvent({
      event: "copilotCitationCollection",
      data: { citations: [{ source: "widget1" }] },
    });

    expect(ev).toEqual({
      kind: "citations",
      citations: [{ source: "widget1" }],
    });
  });

  it("maps suggestions events", () => {
    const ev = toAgentEvent({
      event: "copilotPromptSuggestions",
      data: { suggestions: ["Chart it", "Show table"] },
    });

    expect(ev).toEqual({
      kind: "suggestions",
      suggestions: ["Chart it", "Show table"],
    });
  });

  it("maps error events to kind: error (desk has no error handling at all; a dropped " +
    "connection or an agent-reported failure would otherwise resolve as a successful, " +
    "truncated turn)", () => {
    expect(
      toAgentEvent({ event: "error", data: { message: "model backend returned 500" } })
    ).toEqual({ kind: "error", message: "model backend returned 500" });

    expect(toAgentEvent({ event: "error", data: { error: "boom" } })).toEqual({
      kind: "error",
      message: "boom",
    });

    expect(toAgentEvent({ event: "error", data: "raw failure text" })).toEqual({
      kind: "error",
      message: "raw failure text",
    });

    expect(toAgentEvent({ event: "error", data: {} })).toEqual({
      kind: "error",
      message: "The agent reported an error",
    });
  });

  it("maps done events to kind: done", () => {
    expect(toAgentEvent({ event: "done", data: {} })).toEqual({ kind: "done" });
  });

  it("returns null for unknown events", () => {
    const ev = toAgentEvent({
      event: "unknownEvent" as SseEventType,
      data: {},
    });

    expect(ev).toBeNull();
  });

  it("maps an unknown event to null and calls logOnce with a stable per-event-name key, never " +
    "throws (dedup itself is logOnce's own contract, covered by logger.test.ts)", () => {
    expect(toAgentEvent({ event: "somethingNew" as SseEventType, data: {} })).toBeNull();
    expect(toAgentEvent({ event: "somethingNew" as SseEventType, data: {} })).toBeNull();
    expect(toAgentEvent({ event: "somethingElseNew" as SseEventType, data: {} })).toBeNull();
    expect(logOnce).toHaveBeenCalledTimes(3);
    expect(logOnce).toHaveBeenNthCalledWith(1, "sse:unknown-event:somethingNew", expect.any(String));
    expect(logOnce).toHaveBeenNthCalledWith(2, "sse:unknown-event:somethingNew", expect.any(String));
    expect(logOnce).toHaveBeenNthCalledWith(3, "sse:unknown-event:somethingElseNew", expect.any(String));
  });

  it("handles missing delta in chunk", () => {
    const ev = toAgentEvent({
      event: "copilotMessageChunk",
      data: {},
    });

    expect(ev).toEqual({ kind: "chunk", delta: "" });
  });

  it("defaults citations to [] when the payload's `citations` field isn't an array " +
    "(Finding 7b: removing the Array.isArray guard would pass the non-array value straight through)", () => {
    expect(
      toAgentEvent({ event: "copilotCitationCollection", data: { citations: "not-an-array" } })
    ).toEqual({ kind: "citations", citations: [] });
  });
});

describe("toAgentEvent — malformed/degenerate payloads (boundary validation, dropped with a log)", () => {
  it("rejects a copilotStatusUpdate payload that isn't an object instead of casting it " +
    "(Finding 3: {event:\"copilotStatusUpdate\", data:[]} used to become {kind:\"status\", status:[]})", () => {
    expect(toAgentEvent({ event: "copilotStatusUpdate", data: [] })).toBeNull();
    expect(logOnce).toHaveBeenCalledWith(
      "sse:malformed:copilotStatusUpdate",
      expect.stringContaining("copilotStatusUpdate")
    );
  });

  it("rejects a copilotStatusUpdate object payload with a missing/invalid eventType or " +
    "non-string message instead of casting it (a Rita version bump, or any other " +
    "OpenBB-compatible agent, sending a copilotStatusUpdate without eventType used to reach " +
    "ChatMessages, whose item.status.eventType.toLowerCase() then throws mid-render and takes " +
    "the whole window down)", () => {
    expect(
      toAgentEvent({ event: "copilotStatusUpdate", data: { message: "hi" } })
    ).toBeNull();
    expect(
      toAgentEvent({ event: "copilotStatusUpdate", data: { eventType: "DEBUG", message: "hi" } })
    ).toBeNull();
    expect(
      toAgentEvent({ event: "copilotStatusUpdate", data: { eventType: "INFO", message: 42 } })
    ).toBeNull();
    expect(logOnce).toHaveBeenCalledWith(
      "sse:malformed:copilotStatusUpdate",
      expect.stringContaining("copilotStatusUpdate")
    );
  });

  it("accepts a well-formed copilotStatusUpdate payload", () => {
    expect(
      toAgentEvent({
        event: "copilotStatusUpdate",
        data: { eventType: "WARNING", message: "careful" },
      })
    ).toEqual({
      kind: "status",
      status: { eventType: "WARNING", message: "careful", hidden: false },
    });
  });

  it("rejects a copilotFunctionCall payload that isn't an object instead of casting it " +
    "(a truncated call that degraded to a raw string used to be cast straight into " +
    "FunctionCallEvent, so call.input_arguments.x would throw downstream)", () => {
    expect(
      toAgentEvent({ event: "copilotFunctionCall", data: '{"function":"get_widget_data","input_ar' })
    ).toBeNull();
    expect(logOnce).toHaveBeenCalledWith(
      "sse:malformed:copilotFunctionCall",
      expect.stringContaining("copilotFunctionCall")
    );
  });

  it("rejects a copilotMessageArtifact payload that isn't an object instead of casting it", () => {
    expect(toAgentEvent({ event: "copilotMessageArtifact", data: null })).toBeNull();
    expect(logOnce).toHaveBeenCalledWith(
      "sse:malformed:copilotMessageArtifact",
      expect.stringContaining("copilotMessageArtifact")
    );
  });
});
