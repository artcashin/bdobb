import { describe, expect, it, vi, beforeEach } from "vitest";
import { useChatStore } from "./chatStore";
import * as agentClient from "../lib/agent/agentClient";
import type { ChatMessage } from "../lib/agent/types";

vi.mock("../lib/logger", () => ({ logError: vi.fn() }));

const saved: unknown[] = [];
vi.mock("../lib/persistence", () => ({
  loadChat: async () => ({ messages: [{ role: "human", content: "from disk" }], calls: [] }),
  saveChat: async (c: unknown) => { saved.push(c); },
  clearChat: async () => {},
}));

const DEPS = {
  queryUrl: "https://rita.test/v1/query",
  widgets: [],
  tools: [],
  fetchWidgetData: async () => "{}",
};

beforeEach(() => {
  useChatStore.getState().clear();
  useChatStore.setState({ paneOpen: false });
  vi.restoreAllMocks();
});

describe("chatStore", () => {
  it("records the user message and the streamed answer", async () => {
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "hel" });
      o.onEvent({ kind: "chunk", delta: "lo" });
      return [];
    });

    await useChatStore.getState().send("hi", DEPS);

    expect(useChatStore.getState().messages).toEqual([
      { role: "human", content: "hi" },
      { role: "ai", content: "hello" },
    ]);
    expect(useChatStore.getState().isSending).toBe(false);
  });

  it("flags unread when the answer lands with the pane closed", async () => {
    // The whole point of moving the turn here: the pane may fold away while
    // the agent is still working.
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "answer" });
      return [];
    });

    await useChatStore.getState().send("hi", DEPS);
    expect(useChatStore.getState().hasUnread).toBe(true);
  });

  it("does not flag unread while the pane is open", async () => {
    useChatStore.getState().setPaneOpen(true);
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "answer" });
      return [];
    });

    await useChatStore.getState().send("hi", DEPS);
    expect(useChatStore.getState().hasUnread).toBe(false);
  });

  it("clears unread when the pane opens", async () => {
    useChatStore.setState({ hasUnread: true });
    useChatStore.getState().setPaneOpen(true);
    expect(useChatStore.getState().hasUnread).toBe(false);
  });

  it("keeps the transcript across a pane close and reopen", async () => {
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "first answer" });
      return [];
    });

    useChatStore.getState().setPaneOpen(true);
    await useChatStore.getState().send("one", DEPS);
    // Pane folds away and comes back — previously this destroyed everything,
    // because the conversation lived in the unmounted component.
    useChatStore.getState().setPaneOpen(false);
    useChatStore.getState().setPaneOpen(true);

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it("accumulates reasoning steps and resets them each turn", async () => {
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "status", status: { eventType: "INFO", message: "step one" } });
      return [];
    });

    await useChatStore.getState().send("one", DEPS);
    expect(useChatStore.getState().statuses).toHaveLength(1);

    await useChatStore.getState().send("two", DEPS);
    expect(useChatStore.getState().statuses).toHaveLength(1);
  });

  it("does not add the same artifact twice", async () => {
    const artifact = { type: "table", uuid: "a1", name: "t", description: "", content: [] };
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      // Once carried on a completing status step, once as its own event —
      // both happen in a real turn.
      o.onEvent({ kind: "status", status: { eventType: "INFO", message: "done", artifacts: [artifact] } });
      o.onEvent({ kind: "artifact", artifact });
      return [];
    });

    await useChatStore.getState().send("hi", DEPS);

    const artifactMsgs = useChatStore
      .getState()
      .messages.filter((m) => m.role === "ai" && Array.isArray(m.content));
    expect(artifactMsgs).toHaveLength(1);
  });

  it("records an error but leaves the transcript intact", async () => {
    vi.spyOn(agentClient, "runAgentQuery").mockRejectedValue(new Error("Rita offline"));

    await useChatStore.getState().send("hi", DEPS);

    expect(useChatStore.getState().error).toBe("Rita offline");
    expect(useChatStore.getState().messages[0]).toEqual({ role: "human", content: "hi" });
    expect(useChatStore.getState().isSending).toBe(false);
  });

  it("treats an aborted turn as neither an error nor unread", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    vi.spyOn(agentClient, "runAgentQuery").mockRejectedValue(abort);

    await useChatStore.getState().send("hi", DEPS);

    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().hasUnread).toBe(false);
    expect(useChatStore.getState().isSending).toBe(false);
  });

  it("ignores a send while one is already in flight", async () => {
    const spy = vi.spyOn(agentClient, "runAgentQuery").mockImplementation(
      () => new Promise(() => {})
    );

    void useChatStore.getState().send("one", DEPS);
    void useChatStore.getState().send("two", DEPS);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it("appends protocol messages so the next turn has full history", async () => {
    const toolMsg: ChatMessage = {
      role: "tool", function: "get_widget_data", input_arguments: {}, data: [], extra_state: {},
    };
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "done" });
      return [toolMsg];
    });

    await useChatStore.getState().send("hi", DEPS);

    expect(useChatStore.getState().messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("flags an unreachable agent distinctly from one that errored", async () => {
    // The spec asks these apart: a host that never answered is a different
    // problem from one that answered 500.
    vi.spyOn(agentClient, "runAgentQuery").mockRejectedValue(new Error("Failed to fetch"));
    await useChatStore.getState().send("hi", DEPS);
    expect(useChatStore.getState().agentOffline).toBe(true);
    expect(useChatStore.getState().error).toMatch(/unreachable at https:\/\/rita.test/);
  });

  it("treats an HTTP status as reachable-but-failing", async () => {
    vi.spyOn(agentClient, "runAgentQuery").mockRejectedValue(
      new Error("runAgentQuery: HTTP 500 from https://rita.test/v1/query: model exploded")
    );
    await useChatStore.getState().send("hi", DEPS);
    expect(useChatStore.getState().agentOffline).toBe(false);
    expect(useChatStore.getState().error).toMatch(/model exploded/);
  });

  it("clears the offline flag on the next turn", async () => {
    vi.spyOn(agentClient, "runAgentQuery").mockRejectedValue(new Error("Failed to fetch"));
    await useChatStore.getState().send("one", DEPS);
    expect(useChatStore.getState().agentOffline).toBe(true);

    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "back" });
      return [];
    });
    await useChatStore.getState().send("two", DEPS);
    expect(useChatStore.getState().agentOffline).toBe(false);
    expect(useChatStore.getState().error).toBeNull();
  });

  it("restores a transcript written by a previous run", async () => {
    // Survives the process, not just the pane collapsing.
    await useChatStore.getState().load();
    expect(useChatStore.getState().messages).toEqual([{ role: "human", content: "from disk" }]);
  });

  // Reviewer follow-up (Task 17): desk threads the discovered agents.json
  // `model` feature into every query; chatStore.send previously dropped
  // `deps.workspaceOptions` on the floor entirely, so ChatPane's "Model: X"
  // note misrepresented what was actually queried.
  it("forwards workspaceOptions to runAgentQuery when provided", async () => {
    const spy = vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "hi" });
      return [];
    });

    await useChatStore.getState().send("hi", { ...DEPS, workspaceOptions: { model: "openai:qwen3-coder" } });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceOptions: { model: "openai:qwen3-coder" } })
    );
  });

  it("passes undefined workspaceOptions through unchanged when the caller omits it", async () => {
    const spy = vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "hi" });
      return [];
    });

    await useChatStore.getState().send("hi", DEPS);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ workspaceOptions: undefined }));
  });

  it("persists once per turn, not per streamed delta", async () => {
    saved.length = 0;
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "a" });
      o.onEvent({ kind: "chunk", delta: "b" });
      o.onEvent({ kind: "chunk", delta: "c" });
      return [];
    });

    await useChatStore.getState().send("hi", DEPS);
    // Three deltas, one write — otherwise a long answer rewrites the file
    // on every token.
    expect(saved).toHaveLength(1);
    expect((saved[0] as any).messages).toHaveLength(2);
  });
});
