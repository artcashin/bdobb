import { create } from "zustand";
import type { AgentCall, AgentTool, ChatMessage, ClientArtifact, StatusUpdate, WidgetRef } from "../lib/agent/types";
import type { WidgetDataFetcher } from "../lib/agent/types";
import { runAgentQuery } from "../lib/agent/agentClient";
import type { AgentToolRunner } from "../lib/agent/agentClient";
import { logError } from "../lib/logger";
import { loadChat, saveChat, clearChat } from "../lib/persistence";

/**
 * The conversation lives here rather than in ChatPane because RitaPane
 * unmounts its children when it collapses. With the turn owned by a component,
 * folding the pane aborted the in-flight stream and discarded the transcript —
 * which is why the pane previously had to stay pinned open while streaming.
 * Owning it here lets the pane collapse freely: the turn continues, and an
 * unread dot tells the user an answer arrived.
 */
export interface SendDeps {
  queryUrl: string;
  widgets: WidgetRef[];
  tools: AgentTool[];
  fetchWidgetData: WidgetDataFetcher;
  /** Executes a tool the agent invoked, local or MCP. */
  runAgentTool?: AgentToolRunner;
  /**
   * Forwarded to `runAgentQuery`'s `workspace_options` request field verbatim
   * (e.g. `{model: "openai:qwen3-coder"}` from agents.json's discovered
   * `model` feature — see `ChatPane.tsx`). Omitted entirely means "no
   * preference", not an empty object sent on the wire; `runAgentQuery`
   * itself defaults to `{}` when this is undefined.
   */
  workspaceOptions?: Record<string, unknown>;
}

export interface SymphonyConfirmation {
  toolName: string;
  input: Record<string, unknown>;
  confirmed: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  statuses: StatusUpdate[];
  citations: unknown[];
  suggestions: string[];
  isSending: boolean;
  error: string | null;
  /**
   * Requests made while answering, for the exported transcript. Complete for
   * calls this app makes; for Rita's own tools it holds only what Rita
   * narrates, since those run server-side.
   */
  calls: AgentCall[];
  /** The agent host did not answer at all, as opposed to answering with an error. */
  agentOffline: boolean;
  /** An answer arrived while the pane was closed. */
  hasUnread: boolean;
  /** Whether the pane is currently showing the transcript. */
  paneOpen: boolean;
  /** Confirmation state for Rita's Symphony tool calls */
  symphonyConfirmation?: SymphonyConfirmation;

  setPaneOpen(open: boolean): void;
  recordCall(call: AgentCall): void;
  load(): Promise<void>;
  send(text: string, deps: SendDeps): Promise<void>;
  cancel(): void;
  clear(): void;
  setSymphonyConfirmation(confirmation: SymphonyConfirmation | undefined): void;
}

let controller: AbortController | null = null;

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  statuses: [],
  citations: [],
  suggestions: [],
  calls: [],
  isSending: false,
  error: null,
  agentOffline: false,
  hasUnread: false,
  paneOpen: false,

  recordCall(call) {
    set((s) => ({ calls: [...s.calls, call] }));
  },

  setPaneOpen(open) {
    // Opening the pane is what marks the conversation read.
    set(open ? { paneOpen: true, hasUnread: false } : { paneOpen: false });
  },

  setSymphonyConfirmation(confirmation) {
    set({ symphonyConfirmation: confirmation?.confirmed ? undefined : confirmation });
  },

  cancel() {
    controller?.abort();
    controller = null;
    set({ isSending: false });
  },

  async load() {
    const { messages, calls } = await loadChat();
    set({ messages: messages as ChatMessage[], calls: calls as AgentCall[] });
  },

  clear() {
    get().cancel();
    void clearChat();
    set({ messages: [], statuses: [], citations: [], suggestions: [], calls: [], error: null, agentOffline: false, hasUnread: false, symphonyConfirmation: undefined });
  },

  async send(text, deps) {
    if (!text.trim() || get().isSending) return;

    const userMessage: ChatMessage = { role: "human", content: text.trim() };
    const history = [...get().messages, userMessage];

    set({
      messages: history,
      isSending: true,
      error: null,
      agentOffline: false,
      // Reasoning and suggestions belong to the turn that produced them.
      statuses: [],
      citations: [],
      suggestions: [],
    });

    /** Flags unread only when nobody is looking at the pane. */
    const noteActivity = () => {
      if (!get().paneOpen) set({ hasUnread: true });
    };

    controller = new AbortController();

    try {
      const appended = await runAgentQuery({
        queryUrl: deps.queryUrl,
        messages: history,
        widgets: deps.widgets,
        tools: deps.tools,
        signal: controller.signal,
        fetchWidgetData: deps.fetchWidgetData,
        runAgentTool: deps.runAgentTool,
        workspaceOptions: deps.workspaceOptions,
        onEvent: (event) => {
          switch (event.kind) {
            case "chunk": {
              if (event.delta === undefined) return;
              set((s) => {
                const last = s.messages[s.messages.length - 1];
                if (last && last.role === "ai" && typeof last.content === "string") {
                  const updated = [...s.messages];
                  updated[updated.length - 1] = { ...last, content: last.content + event.delta };
                  return { messages: updated };
                }
                return { messages: [...s.messages, { role: "ai", content: event.delta ?? "" }] };
              });
              noteActivity();
              return;
            }

            case "status": {
              if (!event.status) return;
              set((s) => ({ statuses: [...s.statuses, event.status!] }));
              // Rita's tools run on the agent host; a status update is the
              // only window we have onto them.
              const tc = event.status.tool_call;
              if (tc?.tool_name) {
                get().recordCall({
                  kind: "agent_tool",
                  at: new Date().toISOString(),
                  label: tc.tool_name,
                  input: tc.input,
                });
                if (tc.tool_name === "post_to_symphony") {
                  get().setSymphonyConfirmation({
                    toolName: tc.tool_name,
                    input: tc.input ?? {},
                    confirmed: false,
                  });
                }
              }
              // A completing step can carry the artifacts it produced.
              const carried = event.status.artifacts;
              if (Array.isArray(carried) && carried.length > 0) {
                set((s) => ({ messages: [...s.messages, { role: "ai", content: carried }] }));
                noteActivity();
              }
              return;
            }

            case "artifact": {
              const artifact = event.artifact;
              if (!artifact) return;
              set((s) => {
                // The same artifact can arrive twice: once on a status step,
                // once as its own event.
                const seen = s.messages.some(
                  (m) =>
                    m.role === "ai" &&
                    Array.isArray(m.content) &&
                    (m.content as ClientArtifact[]).some((a) => a.uuid === artifact.uuid)
                );
                return seen ? {} : { messages: [...s.messages, { role: "ai", content: [artifact] }] };
              });
              noteActivity();
              return;
            }

            case "citations":
              set((s) => ({ citations: [...s.citations, ...(event.citations ?? [])] }));
              return;

            case "suggestions":
              set({ suggestions: event.suggestions ?? [] });
              return;

            default:
              return;
          }
        },
      });

      // Protocol messages (function-call echo, tool result) belong in history
      // so the next turn is complete; ChatMessages filters them from the view.
      const protocolMsgs = appended.filter(
        (m) => m.role === "tool" || (m.role === "ai" && typeof m.content !== "string")
      );
      if (protocolMsgs.length > 0) {
        set((s) => ({ messages: [...s.messages, ...protocolMsgs] }));
      }

    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Failed to send message";
      logError(`chat: turn failed: ${message}`);
      // The spec asks these to be distinguishable: a host that never answered
      // is a different problem from one that answered with an error.
      const unreachable =
        !/HTTP \d{3}/.test(message) &&
        /fetch|network|ECONNREFUSED|ENOTFOUND|Failed to fetch|NetworkError|timed? ?out/i.test(message);
      set({
        error: unreachable
          ? `Rita is unreachable at ${new URL(deps.queryUrl).origin} — ${message}`
          : message,
        agentOffline: unreachable,
      });
      noteActivity();
    } finally {
      controller = null;
      set({ isSending: false });
      // Persist once per turn, not per delta: a streamed answer would
      // otherwise rewrite the file on every token.
      const { messages: m, calls: c } = get();
      saveChat({ messages: m, calls: c }).catch((e) =>
        logError(`chat: failed to persist transcript: ${String(e)}`)
      );
    }
  },
}));
