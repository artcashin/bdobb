// @vitest-environment node
import { describe, expect, it } from "vitest";
import { discoverMcpTools, assembleTools, clearMcpCache } from "../../lib/agent/mcp";

// Opt-in smoke test against a live deployment, for the spec's "Rita smoke
// test" step. Skipped by default: the spec requires that CI need no live
// backend, and these hosts are private to whoever runs them.
//
// Endpoints come from the environment — never hardcode real hostnames here.
// Copy .env.example to .env.local (gitignored) and run:
//
//   OPENBB_LIVE=1 pnpm test:run src/test/integration
//
// Assertions must be able to fail — a catch that swallows the failure turns a
// smoke test into a no-op that reports green while the backend is down.
const LIVE = process.env.OPENBB_LIVE === "1";

const nasBaseUrl = process.env.OPENBB_NAS_URL ?? "";
const agentRitaUrl = process.env.OPENBB_RITA_URL ?? "";

/** "id=url,id=url" → [[id, url], …] */
const mcpServers: [string, string][] = (process.env.OPENBB_MCP_URLS ?? "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean)
  .map((e) => {
    const i = e.indexOf("=");
    return [e.slice(0, i).trim(), e.slice(i + 1).trim()] as [string, string];
  })
  .filter(([id, url]) => id && url);

describe.skipIf(!LIVE)("real endpoints integration", () => {
  it("has endpoints configured", () => {
    // Fail loudly rather than silently passing an empty suite: a live run with
    // nothing configured proves nothing.
    expect(nasBaseUrl, "set OPENBB_NAS_URL in .env.local").not.toBe("");
    expect(agentRitaUrl, "set OPENBB_RITA_URL in .env.local").not.toBe("");
    expect(mcpServers.length, "set OPENBB_MCP_URLS in .env.local").toBeGreaterThan(0);
  });

  it("serves a well-formed widgets.json", async () => {
    const response = await fetch(`${nasBaseUrl}/widgets.json`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");

    const data = await response.json();
    expect(data).toBeTypeOf("object");
    const widgetIds = Object.keys(data);
    expect(widgetIds.length).toBeGreaterThan(0);
    const firstWidget = data[widgetIds[0]];
    expect(firstWidget).toHaveProperty("name");
    expect(firstWidget).toHaveProperty("type");
  }, 20000);

  it("serves agents.json from Agent Rita", async () => {
    const response = await fetch(`${agentRitaUrl}/agents.json`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data).toBeTypeOf("object");
    expect(Object.keys(data).length).toBeGreaterThan(0);
  }, 10000);

  it("discovers tools from each configured MCP server", async () => {
    // Exercises the real transport: dual Accept, session capture and replay,
    // notifications/initialized, and SSE-framed response parsing. A client
    // missing any of these gets a 406 or an unparseable body.
    for (const [id, url] of mcpServers) {
      clearMcpCache();
      const tools = await discoverMcpTools(id, url, fetch);
      expect(tools.length, `${id} returned no tools`).toBeGreaterThan(0);
      for (const t of tools) {
        expect(t.server_id).toBe(id);
        expect(t.url).toBe(url);
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.input_schema).toBeTypeOf("object");
      }
    }
  }, 60000);

  it("assembles tools from all servers under the spec's union rule", async () => {
    clearMcpCache();
    const result = await assembleTools(
      mcpServers.map(([id, url]) => ({ id, url, enabled: true })),
      [],
      fetch
    );
    expect(result.tools).not.toBeNull();
    expect(result.unreachable).toEqual([]);
    expect(new Set(result.tools!.map((t) => t.server_id))).toEqual(
      new Set(mcpServers.map(([id]) => id))
    );
  }, 60000);
});
