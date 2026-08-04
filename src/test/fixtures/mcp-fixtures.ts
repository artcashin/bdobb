// Loads the real byte-for-byte SSE captures from the live MCP "stores"
// server (src/test/fixtures/mcp/*.sse) so mcp.ts is exercised against actual
// wire traffic, not hand-written strings. Same pattern as
// rita-stream.fixture.ts (Task 13/14).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `initialize` response: one SSE `message` event, protocolVersion 2025-06-18. */
export const initializeSse = readFileSync(path.join(here, "mcp/initialize.sse"), "utf8");

/** `tools/list` response: one SSE `message` event, the 6 real "stores" MCP tools. */
export const toolsListSse = readFileSync(path.join(here, "mcp/tools-list.sse"), "utf8");

interface RawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Pulls the `data:` line out of a single-event SSE fixture and JSON.parses it. */
function dataOf(sse: string): { result: unknown } {
  const line = sse.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error("fixture has no data: line");
  return JSON.parse(line.slice(5).trim()) as { result: unknown };
}

/**
 * Ground truth for the initialize result, parsed directly out of the
 * fixture (not through mcp.ts) so test expectations come from the actual
 * captured payload rather than a hand-transcribed copy.
 */
export const initializeResult = dataOf(initializeSse).result;

/** Ground truth for the raw (pre-mapping) tools/list result, same reasoning. */
export const rawTools = (dataOf(toolsListSse).result as { tools: RawTool[] }).tools;
