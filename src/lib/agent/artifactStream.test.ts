import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sseEvents, toAgentEvent } from "./sse";
import type { AgentEvent, ClientArtifact, StatusUpdate } from "./types";

/**
 * A real turn in which Rita produced a table artifact, captured from the live
 * agent. Hand-written events would only encode our beliefs about the wire
 * format — this is what it actually sends, including the status steps the chat
 * pane used to discard.
 */
const FIXTURE = readFileSync("src/test/fixtures/rita-artifact-stream.sse", "utf8");

function streamOf(text: string, chunkSize = 128): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

async function collect(): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const raw of sseEvents(streamOf(FIXTURE))) {
    const ev = toAgentEvent(raw);
    if (ev) out.push(ev);
  }
  return out;
}

describe("recorded artifact turn", () => {
  it("surfaces status, artifact and chunk events", async () => {
    const events = await collect();
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("status")).toBe(true);
    expect(kinds.has("artifact")).toBe(true);
    expect(kinds.has("chunk")).toBe(true);
  });

  it("parses reasoning steps including the tool that ran", async () => {
    const statuses = (await collect())
      .filter((e) => e.kind === "status")
      .map((e) => e.status as StatusUpdate);

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0].group).toBe("reasoning");
    expect(statuses[0].message).toMatch(/Extracting table/i);
    expect(statuses[0].tool_call?.tool_name).toBe("create_table_from_text");
  });

  it("parses the table artifact with its rows intact", async () => {
    const artifacts = (await collect())
      .filter((e) => e.kind === "artifact")
      .map((e) => e.artifact as ClientArtifact);

    expect(artifacts).toHaveLength(1);
    const [a] = artifacts;
    expect(a.type).toBe("table");
    expect(a.name).toBe("fruit_prices");
    expect(a.uuid).toBeTruthy();
    expect(Array.isArray(a.content)).toBe(true);
    expect(a.content as Record<string, unknown>[]).toHaveLength(3);
    expect((a.content as Record<string, unknown>[])[0]).toEqual({
      item: "Apple",
      price: 1.29,
    });
  });

  it("carries the same artifact on the completing status step", async () => {
    // A status step can report the artifacts it produced, so a client that
    // only watched copilotMessageArtifact would still be correct — but one
    // that watched only status steps would be too. Both paths must dedupe.
    const statuses = (await collect())
      .filter((e) => e.kind === "status")
      .map((e) => e.status as StatusUpdate);
    const withArtifacts = statuses.filter((s) => Array.isArray(s.artifacts) && s.artifacts.length);

    expect(withArtifacts).toHaveLength(1);
    expect(withArtifacts[0].artifacts![0].uuid).toBeTruthy();
  });
});
