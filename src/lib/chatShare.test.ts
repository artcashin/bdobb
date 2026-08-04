import { describe, expect, it, vi } from "vitest";
import { buildPayload, shareChat, defaultTemplate, type ShareTarget } from "./chatShare";

const VARS = {
  markdown: "# Chat\n\nHe said \"hi\" — 50% off\\done",
  title: "What did AAPL close at?",
  filename: "rita-chat-20260801-1432.md",
  exportedAt: "2026-08-01T14:32:05.000Z",
};

describe("buildPayload", () => {
  it("substitutes placeholders into string values", () => {
    const out = buildPayload(
      '{"title":"{{title}}","path":"chats/{{filename}}","content":"{{markdown}}"}',
      VARS
    );
    expect(out).toEqual({
      title: VARS.title,
      path: `chats/${VARS.filename}`,
      content: VARS.markdown,
    });
  });

  it("survives markdown containing quotes, backslashes and newlines", () => {
    // The reason substitution happens after parsing: doing it on the raw
    // template text would produce invalid JSON for any real conversation.
    const out = buildPayload('{"content":"{{markdown}}"}', VARS);
    expect(out.content).toBe(VARS.markdown);
    expect(String(out.content)).toContain('"hi"');
    expect(String(out.content)).toContain("\\done");
  });

  it("fills nested objects and arrays", () => {
    const out = buildPayload(
      '{"page":{"title":"{{title}}"},"blocks":["{{markdown}}","static"]}',
      VARS
    );
    expect(out).toEqual({
      page: { title: VARS.title },
      blocks: [VARS.markdown, "static"],
    });
  });

  it("leaves non-string leaves alone", () => {
    const out = buildPayload('{"n":1,"b":true,"nil":null}', VARS);
    expect(out).toEqual({ n: 1, b: true, nil: null });
  });

  it("rejects a template that is not valid JSON", () => {
    expect(() => buildPayload("{not json}", VARS)).toThrow(/not valid JSON/i);
  });

  it("rejects a template that is not an object", () => {
    expect(() => buildPayload('["a"]', VARS)).toThrow(/must be a JSON object/i);
  });

  it("treats an empty template as an empty object", () => {
    expect(buildPayload("", VARS)).toEqual({});
  });
});

describe("shareChat via MCP", () => {
  const target: ShareTarget = {
    id: "t1",
    name: "Tolaria",
    kind: "mcp",
    url: "https://tolaria.test/mcp",
    tool: "create_note",
    template: '{"path":"chats/{{filename}}","content":"{{markdown}}"}',
  };

  it("calls the configured tool with the filled arguments", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "Created note" }] }));
    const res = await shareChat(target, VARS, { callTool: callTool as never });

    expect(callTool).toHaveBeenCalledWith("https://tolaria.test/mcp", "create_note", {
      path: `chats/${VARS.filename}`,
      content: VARS.markdown,
    });
    expect(res).toEqual({ target: "Tolaria", detail: "Created note" });
  });

  it("falls back to a generic confirmation when the tool returns no text", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const res = await shareChat(target, VARS, { callTool: callTool as never });
    expect(res.detail).toBe("create_note succeeded");
  });

  it("fails clearly when no tool is configured", async () => {
    await expect(
      shareChat({ ...target, tool: "" }, VARS, { callTool: vi.fn() as never })
    ).rejects.toThrow(/no tool configured/i);
  });

  it("propagates a tool failure", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("MCP tool create_note failed: vault is read-only");
    });
    await expect(shareChat(target, VARS, { callTool: callTool as never })).rejects.toThrow(
      /vault is read-only/
    );
  });
});

describe("shareChat via HTTP", () => {
  const target: ShareTarget = {
    id: "t2",
    name: "Webhook",
    kind: "http",
    url: "https://hooks.test/chat",
    template: '{"title":"{{title}}","markdown":"{{markdown}}"}',
    headers: { Authorization: "Bearer abc" },
  };

  it("posts the filled body with the configured headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const res = await shareChat(target, VARS, { fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.test/chat");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc");
    expect(JSON.parse(String(init.body))).toEqual({
      title: VARS.title,
      markdown: VARS.markdown,
    });
    expect(res.detail).toBe("HTTP 200");
  });

  it("surfaces the response body on a rejected post", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad token", { status: 401 }));
    await expect(shareChat(target, VARS, { fetchImpl: fetchImpl as never })).rejects.toThrow(
      /401.*bad token/s
    );
  });
});

describe("defaultTemplate", () => {
  it("produces a valid, placeholder-bearing starting point for each kind", () => {
    for (const kind of ["mcp", "http"] as const) {
      const tpl = defaultTemplate(kind);
      expect(() => buildPayload(tpl, VARS)).not.toThrow();
      expect(tpl).toContain("{{markdown}}");
    }
  });
});

describe("shareChat to a folder", () => {
  const target: ShareTarget = {
    id: "t3",
    name: "Tolaria — OpenBB-Rita",
    kind: "file",
    url: "/vault/OpenBB-Rita",
    template: '{"path":"{{filename}}"}',
  };

  it("writes the markdown as the file body, not a JSON payload", async () => {
    // A markdown vault wants a markdown file. Wrapping it in JSON, as the
    // mcp/http targets do, would produce an unreadable note.
    const writeFile = vi.fn(async () => {});
    const res = await shareChat(target, VARS, { writeFile });

    expect(writeFile).toHaveBeenCalledWith(
      `/vault/OpenBB-Rita/${VARS.filename}`,
      VARS.markdown
    );
    expect(res.detail).toBe(`/vault/OpenBB-Rita/${VARS.filename}`);
  });

  it("creates intermediate folders when the template nests the file", async () => {
    const writeFile = vi.fn(async () => {});
    const mkdir = vi.fn(async () => {});
    await shareChat(
      { ...target, template: '{"path":"2026/{{filename}}"}' },
      VARS,
      { writeFile, mkdir }
    );
    expect(mkdir).toHaveBeenCalledWith("/vault/OpenBB-Rita/2026");
    expect(writeFile).toHaveBeenCalledWith(
      `/vault/OpenBB-Rita/2026/${VARS.filename}`,
      VARS.markdown
    );
  });

  it("tolerates a trailing slash on the folder", async () => {
    const writeFile = vi.fn(async (_p: string, _c: string) => {});
    await shareChat({ ...target, url: "/vault/OpenBB-Rita/" }, VARS, { writeFile });
    expect(writeFile.mock.calls[0][0]).toBe(`/vault/OpenBB-Rita/${VARS.filename}`);
  });

  it("falls back to the generated filename when the template has no path", async () => {
    const writeFile = vi.fn(async (_p: string, _c: string) => {});
    await shareChat({ ...target, template: "{}" }, VARS, { writeFile });
    expect(writeFile.mock.calls[0][0]).toBe(`/vault/OpenBB-Rita/${VARS.filename}`);
  });

  it("fails clearly with no folder configured", async () => {
    await expect(
      shareChat({ ...target, url: "" }, VARS, { writeFile: vi.fn() })
    ).rejects.toThrow(/no destination folder/i);
  });
});
