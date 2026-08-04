import { logError, logOnce } from "../logger";
import type { AgentEvent, Citation, SseEvent, SseEventType } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STATUS_EVENT_TYPES = new Set(["INFO", "WARNING", "ERROR"]);

/**
 * `isRecord` alone would let ANY object through as a `StatusUpdate` via a
 * blind cast -- a `copilotStatusUpdate` missing (or misspelling) `eventType`,
 * e.g. from a Rita version bump or any other OpenBB-compatible agent (the
 * spec explicitly invites other agents), would otherwise reach a downstream
 * consumer that assumes the shape and throws mid-render. Checked here, at the
 * boundary, instead of trusting the cast.
 */
function isStatusUpdate(v: Record<string, unknown>): boolean {
  return (
    typeof v.eventType === "string" &&
    STATUS_EVENT_TYPES.has(v.eventType) &&
    typeof v.message === "string"
  );
}

function parseBlock(block: string): SseEvent | null {
  let event: SseEventType = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() as SseEventType;
    } else if (line.startsWith("data:")) {
      // WHATWG SSE: a single space immediately after the colon is a separator
      // and is not part of the value. Keeping it corrupts every non-JSON
      // payload (JSON.parse tolerates leading whitespace, which masked this).
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // ignore comments (":") and other fields (id:, retry:)
  }

  if (dataLines.length === 0) {
    return null;
  }

  const raw = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Non-JSON payload isn't malformed input, it's a valid degenerate case
    // per the SSE spec -- pass the raw string through rather than dropping
    // it. But every real Rita `data:` payload is JSON, so in practice this
    // means the block is truncated or corrupt -- log it so a downstream
    // consumer casting `data` blind (or silently getting an empty string)
    // isn't debugging in the dark.
    logOnce(
      `sse:parse-error:${event}`,
      `sse: non-JSON data for event "${event}" (${raw.length} chars); passing through as a raw string`
    );
    data = raw;
  }

  return { event, data };
}

/**
 * Standard `event: <name>\ndata: <json>\n\n` framing. CRLF is accepted
 * defensively since it's spec-legal, even though the live Rita server only
 * emits LF.
 */
export async function* sseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF before scanning for the blank-line separator. SSE
      // permits \r\n, whose separator is \r\n\r\n and contains no "\n\n" — an
      // unnormalized stream never framed and arrived as one merged blob at EOF.
      // Normalizing the whole buffer (not just this chunk) also covers a \r\n
      // split across a chunk boundary: the lone \r waits for its \n.
      buffer = buffer.replace(/\r\n/g, "\n");

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const ev = parseBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);

        if (ev) {
          yield ev;
        }
      }
    }

    // Flush any partial multibyte character held by the decoder (e.g. a
    // UTF-8 sequence split by the stream ending mid-character) so it shows up
    // in `buffer` instead of silently vanishing.
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");

    if (buffer.length > 0) {
      // Every real Rita capture ends with a terminating blank line, so
      // reaching end-of-stream with unconsumed bytes means the connection
      // dropped mid-event. Emitting `parseBlock(buffer)` here would hand a
      // partial payload to a consumer as if it were a complete, well-typed
      // event (this is how a mid-call disconnect used to turn a truncated
      // JSON string into a well-formed `FunctionCallEvent`) -- instead, drop
      // it and log so the truncation is visible.
      const preview = buffer.slice(0, 120).replace(/\n/g, "\\n");
      logError(
        `sse: stream ended with an unterminated trailing block (${buffer.length} chars); ` +
        `dropped rather than emitted as a complete event: "${preview}${buffer.length > 120 ? "…" : ""}"`
      );
    }
  } finally {
    // A caller that stops consuming early (`break`/`return` out of a
    // `for await` loop, e.g. a future "Stop" button) causes the generator's
    // `finally` to run via `.return()`. Releasing the lock alone leaves the
    // underlying HTTP response body open; cancel it too so the connection
    // doesn't leak.
    try {
      await reader.cancel();
    } catch {
      // Best-effort: the stream may already be closed or errored.
    }
    reader.releaseLock();
  }
}

export function toAgentEvent(ev: SseEvent): AgentEvent | null {
  const data = isRecord(ev.data) ? ev.data : {};

  switch (ev.event) {
    case "copilotMessageChunk": {
      return { kind: "chunk", delta: String(data.delta ?? "") };
    }

    case "copilotStatusUpdate": {
      if (!isRecord(ev.data) || !isStatusUpdate(ev.data)) {
        logOnce(
          "sse:malformed:copilotStatusUpdate",
          `sse: copilotStatusUpdate payload was not a valid StatusUpdate (got ${JSON.stringify(ev.data)}); dropped`
        );
        return null;
      }

      // Spread first, then normalise. Rebuilding the object field-by-field
      // silently dropped everything not enumerated here — including
      // `tool_call` and the `artifacts` a completing step carries, which is
      // why reasoning steps reached the pane stripped of their content.
      return {
        kind: "status",
        status: {
          ...ev.data,
          eventType: data.eventType as "INFO" | "WARNING" | "ERROR",
          message: data.message as string,
          group: typeof data.group === "string" ? data.group : undefined,
          hidden: data.hidden === true,
        },
      };
    }

    case "copilotFunctionCall": {
      if (!isRecord(ev.data)) {
        logOnce(
          "sse:malformed:copilotFunctionCall",
          `sse: copilotFunctionCall payload was not an object (got ${typeof ev.data}); dropped`
        );
        return null;
      }

      return {
        kind: "functionCall",
        call: {
          function: String(data.function ?? ""),
          input_arguments: isRecord(data.input_arguments) ? data.input_arguments : {},
          extra_state: isRecord(data.extra_state) ? data.extra_state : undefined,
        },
      };
    }

    case "copilotMessageArtifact": {
      if (!isRecord(ev.data)) {
        logOnce(
          "sse:malformed:copilotMessageArtifact",
          `sse: copilotMessageArtifact payload was not an object (got ${typeof ev.data}); dropped`
        );
        return null;
      }

      return {
        kind: "artifact",
        artifact: {
          type: data.type as "text" | "table" | "chart" | "html",
          name: String(data.name ?? ""),
          description: String(data.description ?? ""),
          uuid: String(data.uuid ?? ""),
          content: typeof data.content === "string" ? data.content : (data.content as Record<string, unknown>[]),
          chart_params: data.chart_params as Record<string, unknown> | undefined,
        },
      };
    }

    case "copilotCitationCollection": {
      return {
        kind: "citations",
        citations: Array.isArray(data.citations) ? (data.citations as Citation[]) : [],
      };
    }

    case "copilotPromptSuggestions": {
      return {
        kind: "suggestions",
        suggestions: Array.isArray(data.suggestions)
          ? data.suggestions.map(String)
          : [],
      };
    }

    case "error": {
      // Declared in SseEventType and previously dropped by `default` (desk
      // lacks this case entirely), so an agent-reported failure resolved as
      // a successful, truncated turn.
      const message =
        typeof data.message === "string" ? data.message
        : typeof data.error === "string" ? data.error
        : typeof ev.data === "string" && ev.data ? ev.data
        : "The agent reported an error";
      return { kind: "error", message };
    }

    case "done":
      return { kind: "done" };

    default:
      // Unknown event names must degrade gracefully, never throw: log once
      // per event name (not once per occurrence) so a noisy unknown stream
      // can't spam the log file.
      logOnce(`sse:unknown-event:${ev.event}`, `sse: unknown event type "${ev.event}" ignored`);
      return null;
  }
}
