import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// config.ts reads import.meta.env once at module load, so each scenario needs a
// fresh module graph rather than a mutated global.
async function withEnv(env: Record<string, string>) {
  vi.resetModules();
  vi.doMock("./config", () => ({
    DEFAULT_API_URL: env.api ?? "",
  }));
  return import("./httpScope");
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock("./config"));

describe("configuredHosts", () => {
  it("collects the configured host", async () => {
    const m = await withEnv({ api: "https://api.example.ts.net" });
    expect(m.configuredHosts()).toEqual(["api.example.ts.net"]);
  });

  it("skips a malformed value, as the generator does", async () => {
    const m = await withEnv({ api: "not a url" });
    expect(m.configuredHosts()).toEqual([]);
  });
});

describe("isHostAllowed", () => {
  it("accepts a configured host and rejects anything else", async () => {
    const m = await withEnv({ api: "https://api.example.ts.net" });
    expect(m.isHostAllowed("https://api.example.ts.net/widgets.json")).toBe(true);
    expect(m.isHostAllowed("https://other.example.ts.net/widgets.json")).toBe(false);
  });

  it("mirrors the *.ts.net fallback when nothing is configured", async () => {
    // A fresh clone genuinely can reach any tailnet host, so warning about
    // them would be wrong.
    const m = await withEnv({});
    expect(m.isHostAllowed("https://anything.ts.net/x")).toBe(true);
    expect(m.isHostAllowed("https://example.com/x")).toBe(false);
  });

  it("rejects an unparseable url rather than throwing", async () => {
    const m = await withEnv({ api: "https://api.example.ts.net" });
    expect(m.isHostAllowed("nonsense")).toBe(false);
  });

  // Ported from desk's capabilityScope.ts (Task 8 merge): it matched the
  // actual compiled capability globs, which carry the scheme (e.g.
  // "https://host/*"), not just the host. Desk shipped no dedicated test file
  // for this module, so these cases are new -- derived from that scheme-aware
  // glob matching rather than migrated verbatim.
  it("rejects a scheme mismatch on an otherwise-configured host", async () => {
    const m = await withEnv({ api: "https://api.example.ts.net" });
    expect(m.isHostAllowed("http://api.example.ts.net/widgets.json")).toBe(false);
  });

  it("restricts the ts.net fallback to https, matching the generator's fallback pattern", async () => {
    const m = await withEnv({});
    expect(m.isHostAllowed("http://anything.ts.net/x")).toBe(false);
  });
});

describe("scope errors", () => {
  it("recognises plugin-http's refusal", async () => {
    const m = await withEnv({});
    expect(
      m.isScopeError(new Error("url not allowed on the configured scope: https://x/y"))
    ).toBe(true);
    expect(m.isScopeError(new Error("Connection refused"))).toBe(false);
  });

  it("explains where the allowlist comes from and how to change it", async () => {
    // The original message names the URL and stops, leaving the reader to
    // discover that the list is compiled in and needs a rebuild.
    const m = await withEnv({ api: "https://api.example.ts.net" });
    const msg = m.scopeErrorMessage("https://nope.example.com/widgets.json");
    expect(msg).toContain("nope.example.com");
    expect(msg).toContain("api.example.ts.net");
    expect(msg).toContain(".env.local");
    expect(msg).toMatch(/rebuild/i);
  });

  it("passes a non-scope error through untouched", async () => {
    const m = await withEnv({});
    const original = new Error("Connection refused");
    expect(() => m.rethrowWithScopeHelp(original, "https://x/y")).toThrow(original);
  });

  it("replaces a scope error with the actionable one", async () => {
    const m = await withEnv({ api: "https://api.example.ts.net" });
    expect(() =>
      m.rethrowWithScopeHelp(
        new Error("url not allowed on the configured scope: https://nope.example.com/w"),
        "https://nope.example.com/w"
      )
    ).toThrow(/not in this build's HTTP allowlist/);
  });
});
