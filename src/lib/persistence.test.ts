import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as memfs from "../test/memfs";
import { files, dirs, resetFs } from "../test/memfs";

vi.mock("@tauri-apps/plugin-fs", () => import("../test/memfs"));

import { LOG_FILE, flush as flushLog } from "./logger";
import * as persistence from "./persistence";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => resetFs());

describe("persistence", () => {
  it("init creates directory", async () => {
    await persistence.init();
    expect(dirs.has("dashboards")).toBe(true);
    expect(dirs.has("logs")).toBe(true);
  });
});

describe("settings", () => {
  it("getSettings returns default when file missing", async () => {
    const settings = await persistence.getSettings();
    // Assert against the exported constant rather than a copy of it, so
    // changing a default does not require editing the test.
    expect(settings).toEqual(persistence.DEFAULT_SETTINGS);
  });

  it("seeds silently (no log, no quarantine) when settings.json is genuinely absent", async () => {
    await persistence.getSettings();
    expect(files.has("settings.json.corrupt")).toBe(false);
    expect(files.has(LOG_FILE)).toBe(false);
  });

  it("setSettings writes file", async () => {
    const settings = {
      ritaUrl: "http://localhost:8000",
      theme: "dark" as const,
      contextSharing: true,
      mcpServers: [] as any[],
      symphonyPodUrl: "",
      symphonyPartnerId: "",
      symphonyBridgeUrl: "",
    };
    await persistence.setSettings(settings);
    const content = files.get("settings.json");
    expect(JSON.parse(content!)).toEqual(settings);
  });

  it("getSettings reads file", async () => {
    const settings = {
      ritaUrl: "http://localhost:8000",
      theme: "dark" as const,
      contextSharing: true,
      mcpServers: [{ id: "1", url: "http://localhost:3000", enabled: true } as any],
      symphonyPodUrl: "",
      symphonyPartnerId: "",
      symphonyBridgeUrl: "",
    };
    files.set("settings.json", JSON.stringify(settings, null, 2));
    const result = await persistence.getSettings();
    expect(result).toEqual(settings);
  });

  it("round-trips saved settings and fills missing keys from defaults", async () => {
    await persistence.setSettings({ ...persistence.DEFAULT_SETTINGS, contextSharing: false });
    expect((await persistence.getSettings()).contextSharing).toBe(false);
    files.set("settings.json", JSON.stringify({ ritaUrl: "http://other:9" }));
    const merged = await persistence.getSettings();
    expect(merged.ritaUrl).toBe("http://other:9");
    expect(merged.mcpServers).toEqual(persistence.DEFAULT_SETTINGS.mcpServers); // filled from defaults
  });

  it("invalid JSON returns default", async () => {
    files.set("settings.json", "invalid json");
    const settings = await persistence.getSettings();
    expect(settings).toEqual(persistence.DEFAULT_SETTINGS);
  });

  it("quarantines an unparseable settings.json instead of silently overwriting it", async () => {
    files.set("settings.json", "{not json");
    const s = await persistence.getSettings();
    expect(s).toEqual(persistence.DEFAULT_SETTINGS);
    expect(files.has("settings.json")).toBe(true);
    expect(files.get("settings.json.corrupt")).toBe("{not json");
    expect(files.get("settings.json")).not.toBe("{not json");
  });

  it("quarantines valid JSON that is the wrong shape instead of silently overwriting it", async () => {
    // Literal JSON null parses fine but is indistinguishable from "absent"
    // unless the shape is checked — it must NOT be silently reseeded.
    files.set("settings.json", "null");
    const s = await persistence.getSettings();
    expect(s).toEqual(persistence.DEFAULT_SETTINGS);
    expect(files.get("settings.json.corrupt")).toBe("null");
    await flushLog();
    expect(files.get(LOG_FILE)).toMatch(/settings\.json.*unexpected shape/);
  });

  it("quarantines settings.json when mcpServers is present but not an array " +
    "(desk finding 4 path b: isSettingsShape used to be container-level only -- " +
    '{"mcpServers":"hello"} survived the merge, and SettingsDialog\'s ' +
    "settings.mcpServers.map(...) then threw)", async () => {
    files.set("settings.json", JSON.stringify({ mcpServers: "hello" }));
    const s = await persistence.getSettings();
    expect(s).toEqual(persistence.DEFAULT_SETTINGS);
    expect(files.get("settings.json.corrupt")).toBe(JSON.stringify({ mcpServers: "hello" }));
  });

  it("quarantines settings.json when an mcpServers entry is missing required fields", async () => {
    const bad = JSON.stringify({ mcpServers: [{ id: "x" }] });
    files.set("settings.json", bad);
    const s = await persistence.getSettings();
    expect(s).toEqual(persistence.DEFAULT_SETTINGS);
    expect(files.get("settings.json.corrupt")).toBe(bad);
  });

  it("quarantines settings.json when contextSharing is present but not a boolean", async () => {
    const bad = JSON.stringify({ contextSharing: "yes" });
    files.set("settings.json", bad);
    const s = await persistence.getSettings();
    expect(s).toEqual(persistence.DEFAULT_SETTINGS);
    expect(files.get("settings.json.corrupt")).toBe(bad);
  });

  it("still accepts a settings.json that only sets some known fields (partial overrides stay valid)", async () => {
    files.set("settings.json", JSON.stringify({ ritaUrl: "http://other:9" }));
    const s = await persistence.getSettings();
    expect(s.ritaUrl).toBe("http://other:9");
    expect(files.has("settings.json.corrupt")).toBe(false);
  });

  it("does not clobber an existing .corrupt file on a second corruption", async () => {
    files.set("settings.json", "{first corrupt");
    await persistence.getSettings();
    expect(files.get("settings.json.corrupt")).toBe("{first corrupt");

    files.set("settings.json", "{second corrupt");
    await persistence.getSettings();
    expect(files.get("settings.json.corrupt")).toBe("{first corrupt");
    expect(files.get("settings.json.corrupt.1")).toBe("{second corrupt");
  });
});

describe("backends", () => {
  it("getBackends/setBackends work", async () => {
    const backends: persistence.BackendConfig[] = [
      { id: "1", name: "Backend 1", baseUrl: "http://localhost:8000" },
      { id: "2", name: "Backend 2", baseUrl: "http://localhost:8001" },
    ];
    await persistence.setBackends(backends);
    const result = await persistence.getBackends();
    expect(result).toEqual(backends);
  });

  it("seeds silently (no log, no quarantine) when backends.json is genuinely absent", async () => {
    await persistence.getBackends();
    expect(files.has("backends.json.corrupt")).toBe(false);
    expect(files.has(LOG_FILE)).toBe(false);
  });

  it("quarantines an unparseable backends.json instead of silently overwriting it", async () => {
    files.set("backends.json", "{not json");
    const b = await persistence.getBackends();
    expect(b).toEqual(persistence.DEFAULT_BACKENDS);
    expect(files.get("backends.json.corrupt")).toBe("{not json");
  });

  it("quarantines valid JSON that is the wrong shape and preserves the secret instead of losing it", async () => {
    const wrongShape = JSON.stringify({
      backends: [{ id: "nas", name: "OpenBB NAS", baseUrl: "https://x", headerValue: "SECRET" }],
    });
    files.set("backends.json", wrongShape);
    const b = await persistence.getBackends();
    expect(b).toEqual(persistence.DEFAULT_BACKENDS);
    expect(files.get("backends.json.corrupt")).toBe(wrongShape);
    await flushLog();
    expect(files.get(LOG_FILE)).toMatch(/backends\.json.*unexpected shape/);
  });

  it("quarantines backends.json when an array entry is missing required fields " +
    "(desk finding 4 path b: isBackendsShape used to be container-level only -- " +
    "Array.isArray(v) alone let [null] or [{}] through, and BackendsDialog's " +
    "b.id/b.name/b.baseUrl access then broke)", async () => {
    const bad = JSON.stringify([{ id: "nas" }]);
    files.set("backends.json", bad);
    const b = await persistence.getBackends();
    expect(b).toEqual(persistence.DEFAULT_BACKENDS);
    expect(files.get("backends.json.corrupt")).toBe(bad);
  });

  it("quarantines backends.json when an array entry is null", async () => {
    const bad = JSON.stringify([null]);
    files.set("backends.json", bad);
    const b = await persistence.getBackends();
    expect(b).toEqual(persistence.DEFAULT_BACKENDS);
    expect(files.get("backends.json.corrupt")).toBe(bad);
  });

  it("still accepts a well-formed backends.json with the optional auth header fields", async () => {
    const good = JSON.stringify([
      { id: "nas", name: "OpenBB NAS", baseUrl: "https://x", headerName: "X-Key", headerValue: "secret" },
    ]);
    files.set("backends.json", good);
    const b = await persistence.getBackends();
    expect(b).toEqual([
      { id: "nas", name: "OpenBB NAS", baseUrl: "https://x", headerName: "X-Key", headerValue: "secret" },
    ]);
    expect(files.has("backends.json.corrupt")).toBe(false);
  });
});

describe("write-path failures are logged and rethrown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs and rethrows when settings.json fails to write", async () => {
    vi.spyOn(memfs, "writeTextFile").mockRejectedValueOnce(new Error("disk full"));
    await expect(persistence.setSettings(persistence.DEFAULT_SETTINGS)).rejects.toThrow("disk full");
    await flushLog();
    expect(files.get(LOG_FILE)).toMatch(/failed to write settings\.json/);
  });

  it("logs and rethrows when the app-data directories fail to be created", async () => {
    vi.spyOn(memfs, "mkdir").mockRejectedValueOnce(new Error("EACCES"));
    await expect(persistence.getSettings()).rejects.toThrow("EACCES");
    await flushLog();
    expect(files.get(LOG_FILE)).toMatch(/failed to create app-data directories/);
  });
});

describe("chat", () => {
  it("returns an empty chat when no transcript has been written", async () => {
    expect(await persistence.loadChat()).toEqual({ messages: [], calls: [] });
  });

  it("round-trips a chat transcript", async () => {
    const chat = {
      messages: [{ role: "human", content: "hi" }],
      calls: [{ kind: "widget_data", at: "2026-08-01T00:00:00Z", label: "w" }],
    };
    await persistence.saveChat(chat);
    expect(await persistence.loadChat()).toEqual(chat);
  });

  it("quarantines a corrupt transcript instead of losing settings with it", async () => {
    // The transcript lives in its own file precisely so a bad one cannot take
    // the app's configuration down with it.
    files.set("settings.json", JSON.stringify({ ritaUrl: "https://keep.me" }));
    files.set("chat.json", "not json");

    expect(await persistence.loadChat()).toEqual({ messages: [], calls: [] });
    expect(files.has("chat.json.corrupt")).toBe(true);
    expect((await persistence.getSettings()).ritaUrl).toBe("https://keep.me");
  });

  it("clearChat removes the file", async () => {
    await persistence.saveChat({ messages: [{ role: "human", content: "x" }], calls: [] });
    expect(files.has("chat.json")).toBe(true);
    await persistence.clearChat();
    expect(files.has("chat.json")).toBe(false);
  });
});

describe("concurrent and failed writes", () => {
  it("serializes concurrent writes to the same file instead of colliding", async () => {
    // Four writers in one tick previously shared a Date.now() temp name: the
    // first rename won and the rest rejected with ENOENT, dropping content.
    const results = await Promise.allSettled([
      persistence.saveSettings({ ...persistence.DEFAULT_SETTINGS, ritaUrl: "https://a" }),
      persistence.saveSettings({ ...persistence.DEFAULT_SETTINGS, ritaUrl: "https://b" }),
      persistence.saveSettings({ ...persistence.DEFAULT_SETTINGS, ritaUrl: "https://c" }),
      persistence.saveSettings({ ...persistence.DEFAULT_SETTINGS, ritaUrl: "https://d" }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // Last writer wins, and the file is whole rather than a lost update.
    expect((await persistence.getSettings()).ritaUrl).toBe("https://d");
    // No temp files left behind.
    expect([...files.keys()].filter((k) => k.includes(".tmp."))).toEqual([]);
  });

  it("leaves no temp file behind when a write fails", async () => {
    await persistence.saveSettings(persistence.DEFAULT_SETTINGS);
    const before = [...files.keys()].filter((k) => k.includes(".tmp."));
    expect(before).toEqual([]);
  });
});

describe("dashboards", () => {
  it("seeds one empty Main dashboard on first run", async () => {
    const ds = await persistence.getDashboards();
    expect(ds).toHaveLength(1);
    expect(ds[0].name).toBe("Main");
    expect(ds[0].cards).toEqual([]);
    expect(files.has(`dashboards/${ds[0].id}.json`)).toBe(true);
  });

  it("getDashboards/saveDashboard/deleteDashboard work", async () => {
    const dashboard: persistence.Dashboard = {
      id: "test-1",
      name: "Test Dashboard",
      cards: [],
    };
    await persistence.saveDashboard(dashboard);
    const dashboards = await persistence.getDashboards();
    expect(dashboards).toEqual([dashboard]);
    const fetched = await persistence.getDashboard("test-1");
    expect(fetched).toEqual(dashboard);
    await persistence.deleteDashboard("test-1");
    const afterDelete = await persistence.getDashboard("test-1");
    expect(afterDelete).toBeNull();
  });

  it("round-trips one file per dashboard with a fully-populated card", async () => {
    const d: persistence.Dashboard = {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Equities",
      cards: [{
        uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        widgetId: "equity_price_historical_eodhd_obb",
        backendId: "nas",
        layout: { x: 0, y: 0, w: 40, h: 15 },
        params: { symbol: "AAPL" },
        view: "default",
      }],
    };
    await persistence.saveDashboard(d);
    const loaded = await persistence.getDashboards();
    expect(loaded.find((x) => x.id === d.id)).toEqual(d);
    await persistence.deleteDashboard(d.id);
    expect(files.has(`dashboards/${d.id}.json`)).toBe(false);
  });

  it("skips a corrupt dashboard file, keeps the good ones, and quarantines the bad file", async () => {
    const good: persistence.Dashboard = { id: "11111111-2222-4333-8444-555555555555", name: "Good", cards: [] };
    await persistence.saveDashboard(good);
    files.set("dashboards/bad.json", "{not json");

    const ds = await persistence.getDashboards();

    expect(ds).toHaveLength(1);
    expect(ds.map((d) => d.id)).toEqual([good.id]);
    expect(files.has("dashboards/bad.json")).toBe(false);
    expect(files.get("dashboards/bad.json.corrupt")).toBe("{not json");
  });

  it("skips, logs, and quarantines a dashboard file that is valid JSON but the wrong shape", async () => {
    const good: persistence.Dashboard = { id: "11111111-2222-4333-8444-555555555555", name: "Good", cards: [] };
    await persistence.saveDashboard(good);
    const wrongShape = JSON.stringify({ name: "NoIdOrCards" });
    files.set("dashboards/wrong-shape.json", wrongShape);

    const ds = await persistence.getDashboards();

    expect(ds.map((d) => d.id)).toEqual([good.id]);
    expect(files.has("dashboards/wrong-shape.json")).toBe(false);
    expect(files.get("dashboards/wrong-shape.json.corrupt")).toBe(wrongShape);
    await flushLog();
    expect(files.get(LOG_FILE)).toMatch(/wrong-shape\.json.*unexpected shape/);
  });

  it("deletes an already-deleted dashboard without throwing", async () => {
    const d: persistence.Dashboard = { id: "22222222-3333-4444-8555-666666666666", name: "Gone", cards: [] };
    await persistence.saveDashboard(d);
    await persistence.deleteDashboard(d.id);
    await expect(persistence.deleteDashboard(d.id)).resolves.toBeUndefined();
  });

  it("does not fabricate or persist a new Main dashboard when the directory listing itself fails", async () => {
    const existing: persistence.Dashboard = {
      id: "33333333-4444-4444-8555-666666666666", name: "Existing", cards: [],
    };
    await persistence.saveDashboard(existing);

    vi.spyOn(memfs, "readDir").mockRejectedValueOnce(new Error("EPERM"));
    const ds = await persistence.getDashboards();

    expect(ds).toEqual([]);
    // No new dashboard file was written — only the pre-existing one remains.
    const dashboardFiles = [...files.keys()].filter((k) => k.startsWith("dashboards/"));
    expect(dashboardFiles).toEqual(["dashboards/33333333-4444-4444-8555-666666666666.json"]);

    await flushLog();
    expect(files.get(LOG_FILE)).toMatch(/failed to read dashboards directory/);
    vi.restoreAllMocks();
  });

  it("deleteAllDashboards", async () => {
    const dashboards: persistence.Dashboard[] = [
      { id: "d1", name: "Dashboard 1", cards: [] },
      { id: "d2", name: "Dashboard 2", cards: [] },
    ];
    for (const d of dashboards) {
      await persistence.saveDashboard(d);
    }
    await persistence.deleteAllDashboards();
    const result = await persistence.getDashboards();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Main");
  });
});

describe("newId() fallback (crypto unavailable)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to a getRandomValues-derived UUID when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const ds = await persistence.getDashboards();
    expect(ds).toHaveLength(1);
    expect(ds[0].id).toMatch(UUID_V4_RE);
  });

  it("falls back to a Math.random-derived UUID when neither randomUUID nor getRandomValues is available", async () => {
    vi.stubGlobal("crypto", {});
    const ds = await persistence.getDashboards();
    expect(ds).toHaveLength(1);
    expect(ds[0].id).toMatch(UUID_V4_RE);
  });
});
