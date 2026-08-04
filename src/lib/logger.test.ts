import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, dirs, resetFs } from "../test/memfs";
import * as fsMock from "@tauri-apps/plugin-fs";

vi.mock("@tauri-apps/plugin-fs", () => import("../test/memfs"));

import {
  init,
  log,
  debug,
  info,
  warn,
  error,
  logError,
  logOnce,
  readLogTail,
  close,
  flush,
  LOG_FILE,
} from "./logger";

beforeEach(() => resetFs());

describe("logger", () => {
  it("init creates directory and opens file", async () => {
    await init();
    expect(dirs.has("logs")).toBe(true);
    expect(files.has(LOG_FILE)).toBe(false);
  });

  it("log writes to file", async () => {
    await init();
    log("info", "test message");
    await queueDrain();
    const text = files.get(LOG_FILE)?.trimEnd();
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T.*\| INFO \| test message$/);
  });

  it("format string with %s placeholder", async () => {
    await init();
    log("info", "hello %s", "world");
    await queueDrain();
    const text = files.get(LOG_FILE)?.trimEnd();
    expect(text).toMatch(/\| INFO \| hello world$/);
  });

  it("format string with %d placeholder", async () => {
    await init();
    log("debug", "count: %d", 42);
    await queueDrain();
    const text = files.get(LOG_FILE)?.trimEnd();
    expect(text).toMatch(/\| DEBUG \| count: 42$/);
  });

  it("format string with %j placeholder", async () => {
    await init();
    log("warn", "object: %j", { a: 1, b: "test" });
    await queueDrain();
    const text = files.get(LOG_FILE)?.trimEnd();
    expect(text).toMatch(/\| WARN \| object: {"a":1,"b":"test"}$/);
  });

  it("all log levels write correctly", async () => {
    await init();
    debug("debug message");
    info("info message");
    warn("warn message");
    error("error message");
    await queueDrain();
    const text = files.get(LOG_FILE);
    expect(text).toContain("DEBUG");
    expect(text).toContain("INFO");
    expect(text).toContain("WARN");
    expect(text).toContain("ERROR");
  });

  it("rotation when file exceeds 10 MB (mocked)", async () => {
    await init();
    const largeContent = "x".repeat(10 * 1024 * 1024 + 1);
    files.set(LOG_FILE, largeContent);
    log("info", "after rotation");
    await queueDrain();
    expect(files.get(`${LOG_FILE}.1`)).toBe(largeContent);
    expect(files.get(LOG_FILE)).toMatch(/after rotation/);
  });

  it("replaces an existing .1 on the next rotation", async () => {
    await init();
    files.set(`${LOG_FILE}.1`, "old");
    const largeContent = "y".repeat(10 * 1024 * 1024 + 1);
    files.set(LOG_FILE, largeContent);
    log("info", "again");
    await queueDrain();
    // Asserts content, not just presence: the old .1 must actually be
    // overwritten by the newly-rotated file, not merely still exist.
    expect(files.get(`${LOG_FILE}.1`)).toBe(largeContent);
  });

  it("rotates by UTF-8 byte size, not character length, for multibyte content", async () => {
    // "é" is 1 UTF-16 char but 2 UTF-8 bytes: 6M chars is under the 10MB
    // threshold by char count but over it (12MB) by encoded byte size.
    await init();
    const multibyte = "é".repeat(6 * 1024 * 1024);
    expect(multibyte.length).toBeLessThan(10 * 1024 * 1024);
    files.set(LOG_FILE, multibyte);
    log("info", "after rotation");
    await queueDrain();
    expect(files.get(`${LOG_FILE}.1`)).toBe(multibyte);
    expect(files.get(LOG_FILE)).toMatch(/after rotation/);
  });

  it("keeps up to 5 rotated files", async () => {
    await init();
    for (let i = 1; i <= 6; i++) {
      const largeContent = "x".repeat(10 * 1024 * 1024 + 1);
      files.set(LOG_FILE, largeContent);
      log("info", `log ${i}`);
      await queueDrain();
    }
    expect(files.has(`${LOG_FILE}.1`)).toBe(true);
    expect(files.has(`${LOG_FILE}.2`)).toBe(true);
    expect(files.has(`${LOG_FILE}.3`)).toBe(true);
    expect(files.has(`${LOG_FILE}.4`)).toBe(true);
    expect(files.has(`${LOG_FILE}.5`)).toBe(true);
    expect(files.has(`${LOG_FILE}.6`)).toBe(false);
  });

  it("close flushes and closes file", async () => {
    await init();
    log("info", "before close");
    await close();
    const text = files.get(LOG_FILE)?.trimEnd();
    expect(text).toMatch(/before close/);
  });

  it("handles errors gracefully", async () => {
    await init();
    log("info", "this should not crash");
    await queueDrain();
    expect(files.get(LOG_FILE)).toBeDefined();
  });
});

function queueDrain(): Promise<void> {
  // Drain the module's own write queue rather than guessing with a timer;
  // setTimeout(0) only worked because the memfs ops resolve synchronously.
  return flush();
}

describe("logger resilience", () => {
  it("keeps logging after a rotation failure", async () => {
    // One failed rename used to disable logging permanently: the line was
    // lost, the file stayed oversized, so every later line failed too — with
    // console.error as the only remaining channel, on the platform the log
    // file exists for.
    await init();
    files.set(LOG_FILE, "x".repeat(11 * 1024 * 1024));
    const spy = vi
      .spyOn(fsMock, "rename")
      .mockRejectedValueOnce(new Error("EPERM: file in use"));

    log("error", "after a failed rotation");
    await queueDrain();

    expect(files.get(LOG_FILE) ?? "").toContain("after a failed rotation");
    spy.mockRestore();
  });

  it("collapses a multi-line message into a single entry", async () => {
    await init();
    log("error", "boom\n  at frame1\n  at frame2");
    await queueDrain();
    const lines = (files.get(LOG_FILE) ?? "").trimEnd().split("\n");
    // A stack trace must not read as three malformed entries.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\\n  at frame1");
  });
});

describe("logError", () => {
  it("echoes to console.error in addition to writing the file", async () => {
    await init();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("boom");
    await queueDrain();
    expect(spy).toHaveBeenCalledWith("boom");
    expect(files.get(LOG_FILE) ?? "").toMatch(/boom/);
    spy.mockRestore();
  });
});

describe("logOnce", () => {
  it("writes once per key; logError still writes on every call", async () => {
    await init();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logOnce("k1", "only once");
    logOnce("k1", "only once");
    logError("boom");
    await queueDrain();
    const text = files.get(LOG_FILE) ?? "";
    expect(text.match(/only once/g)).toHaveLength(1);
    expect(text).toMatch(/boom/);
    spy.mockRestore();
  });

  it("different keys are tracked independently", async () => {
    await init();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logOnce("k2", "first");
    logOnce("k3", "second");
    await queueDrain();
    const text = files.get(LOG_FILE) ?? "";
    expect(text).toMatch(/first/);
    expect(text).toMatch(/second/);
    spy.mockRestore();
  });
});

describe("readLogTail", () => {
  it("returns the last N non-empty lines", async () => {
    await init();
    for (let i = 0; i < 10; i++) {
      log("info", `line ${i}`);
    }
    await queueDrain();
    const tail = await readLogTail(3);
    expect(tail).toHaveLength(3);
    expect(tail[2]).toMatch(/line 9$/);
  });

  it("returns an empty array when the log file doesn't exist", async () => {
    const tail = await readLogTail(5);
    expect(tail).toEqual([]);
  });
});
