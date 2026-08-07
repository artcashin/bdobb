import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { AgentFeatureSelectOption, AgentInfo, ChatMessage } from "../../lib/agent/types";
import type { Settings } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDashboardStore } from "../../stores/dashboardStore";
import { useBackendsStore } from "../../stores/backendsStore";
import { useRegistryStore } from "../../stores/registryStore";
import { useChatStore } from "../../stores/chatStore";
import { buildWidgetRefs, fetchAgentsJson, makeWidgetDataFetcher } from "../../lib/agent/agentClient";
import { assembleTools, callMcpTool } from "../../lib/agent/mcp";
import { LOCAL_TOOLS, LOCAL_TOOL_SERVER_ID, executeLocalTool } from "../../lib/agent/localTools";
import { useAgentEditsStore } from "../../stores/agentEditsStore";
import { DEFAULT_RITA_URL } from "../../lib/config";
import { saveChatExport } from "../../lib/chatExportFile";
import { chatToMarkdown, exportFilename } from "../../lib/chatExport";
import { shareChat } from "../../lib/chatShare";
import { writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { logError } from "../../lib/logger";
import { safeUrl } from "../../lib/safeUrl";
import Modal from "../Modal";

import ChatMessages from "./ChatMessages";
import StatusTrail from "./StatusTrail";

/**
 * Rita's Symphony-posting tool, arriving as an ordinary MCP call. It is not
 * declared or discovered here (it comes from whatever MCP server exposes it
 * -- see mcp.ts's assembleTools), so this is the one place BDOBB knows its
 * name: `runAgentTool` below gates any call with this name on user approval
 * before it may run, matching the plan's F2-10 requirement (BDOBB-side gate,
 * not trust in the model) regardless of which server_id it was declared
 * under.
 */
const SYMPHONY_POST_TOOL = "post_to_symphony";

/**
 * Anything that plausibly IS post_to_symphony, not just an exact string match.
 * A bridge advertising different casing (`postToSymphony`) or some other
 * `*symphony*` variant this app has never seen must still hit the gate --
 * silently executing an unrecognized variant would be a fail-OPEN bug, and
 * over-prompting (gating something that turns out to be harmless) is the safe
 * direction to err in here, under-prompting is not.
 */
const SYMPHONY_TOOL_PATTERN = /symphony/i;

function isSymphonyPostTool(toolName: string): boolean {
  return toolName.toLowerCase() === SYMPHONY_POST_TOOL || SYMPHONY_TOOL_PATTERN.test(toolName);
}

/** The parameter names that might carry the post's destination, in the order
 * the plan documents them ("streamId or saved-destination name", spec F2-8)
 * plus a couple of obvious synonyms. Order here is display order only now --
 * see `destinationCandidates` below for why picking just the first is wrong. */
const DESTINATION_KEYS = ["streamId", "destination", "stream_id", "room", "roomId"] as const;

/**
 * Best-effort read of a post_to_symphony call's destination/message for the
 * confirmation dialog. The tool is defined by the symphony-bridge service,
 * not by this app, so its exact argument names aren't a contract we own.
 *
 * `destinationCandidates` deliberately does not collapse to a single value:
 * a payload carrying both a human-readable name (e.g. `room`) and a resolved
 * id (e.g. `streamId`) is ambiguous about which one the bridge actually
 * routes by, and silently showing just the first match (old behavior) could
 * show the user a room that isn't where the message goes. Every known key
 * that is present gets surfaced so the dialog can show all of them; an empty
 * array means none of the known keys matched at all, which the dialog must
 * call out explicitly rather than just... not mentioning a destination.
 */
function symphonyConfirmationText(parameters: Record<string, unknown>): {
  destinationCandidates: { key: string; value: string }[];
  message: string | null;
} {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const destinationCandidates = DESTINATION_KEYS.flatMap((key) => {
    const value = str(parameters[key]);
    return value ? [{ key, value }] : [];
  });
  const message =
    str(parameters.message) ??
    str(parameters.text) ??
    str(parameters.content) ??
    str(parameters.body);
  return { destinationCandidates, message };
}

/** Picks the `{type:"select",...}` feature out of `AgentInfo.features` (desk
 * ChatPane.tsx), e.g. agents.json's "model" picker. */
function selectFeature(info: AgentInfo, key: string): AgentFeatureSelectOption | null {
  const f = info.features[key];
  return typeof f === "object" && "type" in f && f.type === "select" ? f : null;
}

/**
 * A short toolbar label whose full explanation used to live only in a
 * `title` tooltip — unreachable without a mouse (desk ChatPane.tsx, Finding
 * 10, Task 16 review). Renders as a real `<button>` so it's in the Tab order
 * and Enter/Space-activatable; the explanation becomes visible text on
 * activation instead of hover-only.
 */
function NoteButton({ label, detail }: { label: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="chat-note">
      <button
        type="button"
        className="chat-note-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && <span className="chat-note-detail">{detail}</span>}
    </span>
  );
}

export interface ChatPaneProps {
  /**
   * Raised while the input has focus, so the pane does not fold away
   * mid-sentence. Streaming no longer holds it open: the turn lives in
   * chatStore and continues regardless, with an unread dot on the collapsed
   * strip when the answer lands.
   */
  onStickyChange?: (sticky: boolean) => void;
}

/**
 * Stable empty arrays for store selectors. Returning a fresh `[]` from a
 * zustand selector makes every read look like a change under Object.is, which
 * re-renders forever.
 */
const NO_TARGETS: NonNullable<Settings["shareTargets"]> = [];
const NO_MCP: Settings["mcpServers"] = [];

/**
 * The human confirmation gate's UI: shows what Rita is about to post to
 * Symphony and lets the user approve or decline before it is sent.
 */
function SymphonyConfirmDialog({
  confirmation,
}: {
  confirmation: { id: string; parameters: Record<string, unknown> };
}) {
  const { destinationCandidates, message } = symphonyConfirmationText(confirmation.parameters);
  const decide = (decision: "approved" | "declined") =>
    useChatStore.getState().resolveToolConfirmation(confirmation.id, decision);

  // Exactly one known destination key matched -- the unambiguous, common
  // case -- shows its value inline. Zero or multiple matches are both cases
  // where a single parenthetical would either be missing (silently) or
  // arbitrarily pick one of several candidates that may not agree on where
  // the bridge actually routes the post, so both get their own explicit,
  // non-collapsed callout instead.
  const destinationUnresolved = destinationCandidates.length === 0;
  const destinationAmbiguous = destinationCandidates.length > 1;
  const destinationInline = destinationCandidates.length === 1 ? destinationCandidates[0].value : null;
  const messageUnresolved = message === null;
  // The raw-parameters fallback is the only place an unresolved destination
  // or message can actually be reviewed -- defaulting it open whenever
  // either is unresolved turns that fallback from an opt-in mitigation into
  // one the user actually sees.
  const rawParamsOpenByDefault = destinationUnresolved || destinationAmbiguous || messageUnresolved;

  return (
    <Modal isOpen onClose={() => decide("declined")} title="Review and Send"
      footer={
        <>
          <button
            onClick={() => decide("declined")}
            className="backend-btn"
            style={{ color: "var(--text)", padding: "8px 16px" }}
          >
            Decline
          </button>
          <button
            onClick={() => decide("approved")}
            className="backend-btn"
            style={{ padding: "8px 16px", background: "var(--accent)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
            autoFocus
          >
            Send
          </button>
        </>
      }
    >
      <p className="symphony-confirm-summary">
        Rita wants to post this message to Symphony{destinationInline ? ` (${destinationInline})` : ""}:
      </p>
      {destinationUnresolved && (
        <p className="symphony-confirm-warning" role="alert">
          Destination could not be determined from these parameters — review the raw parameters below.
        </p>
      )}
      {destinationAmbiguous && (
        <p className="symphony-confirm-warning" role="alert">
          Multiple possible destinations were found ({destinationCandidates
            .map((c) => `${c.key}: ${c.value}`)
            .join(", ")}) and it is not known which one the bridge will use — review the raw parameters below.
        </p>
      )}
      <pre className="symphony-confirm-message">
        {message ?? "(no message text found -- see raw parameters below)"}
      </pre>
      <details open={rawParamsOpenByDefault}>
        <summary>Raw parameters</summary>
        <pre className="symphony-confirm-raw">{JSON.stringify(confirmation.parameters, null, 2)}</pre>
      </details>
    </Modal>
  );
}

/** The opening question, used as a title when sending to another app. */
function firstPrompt(messages: ChatMessage[]): string | null {
  const first = messages.find((m) => m.role === "human");
  const content = (first as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return null;
  const line = content.trim().split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export default function ChatPane({ onStickyChange }: ChatPaneProps = {}) {
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const messages = useChatStore((s) => s.messages);
  const statuses = useChatStore((s) => s.statuses);
  const citations = useChatStore((s) => s.citations);
  const suggestions = useChatStore((s) => s.suggestions);
  const isSending = useChatStore((s) => s.isSending);
  const error = useChatStore((s) => s.error);
  const agentOffline = useChatStore((s) => s.agentOffline);
  const calls = useChatStore((s) => s.calls);
  const pendingToolConfirmation = useChatStore((s) => s.pendingToolConfirmation);
  const [exported, setExported] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const shareTargets = useSettingsStore((s) => s.settings?.shareTargets ?? NO_TARGETS);
  /** Which MCP servers this turn's tool assembly had to drop, if any (Task 9
   * review's `AssembleToolsResult.budgetExceeded`/`unreachable` — desk
   * fb47f16 for `unreachable`). Local, turn-scoped state: chatStore's `error`
   * is reserved for the query itself failing, and this can be non-empty on
   * an otherwise-successful turn. */
  const [toolWarnings, setToolWarnings] = useState<string[]>([]);
  /** Best-effort agents.json discovery, purely for the model note below —
   * chatStore still owns the actual query URL/offline detection unchanged. */
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);

  const ritaUrl = useSettingsStore((s) => s.settings?.ritaUrl || DEFAULT_RITA_URL);
  const contextSharing = useSettingsStore((s) => s.settings?.contextSharing ?? false);
  const mcpServers = useSettingsStore((s) => s.settings?.mcpServers ?? NO_MCP);
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const currentDashboard = dashboards.find((d) => d.id === activeId) ?? null;
  const currentWidgets = useMemo(() => currentDashboard?.cards ?? [], [currentDashboard]);
  const backends = useBackendsStore((s) => s.backends);

  const getBackend = useCallback(
    (backendId: string) => backends.find((b) => b.id === backendId),
    [backends]
  );

  const getWidgetDef = useCallback(
    (backendId: string, widgetId: string) => useRegistryStore.getState().find(backendId, widgetId),
    []
  );

  const widgetRefs = useMemo(
    () =>
      buildWidgetRefs(currentWidgets, getWidgetDef, (backendId) => {
        const backend = getBackend(backendId);
        return backend?.name || backendId;
      }),
    [currentWidgets, getWidgetDef, getBackend]
  );

  // agents.json's live `model` feature can advertise options this deployment
  // can't actually reach, and its `default` isn't always one of the listed
  // `options` (desk ChatPane.tsx deviation note) — so the toolbar renders the
  // resolved default as read-only text via NoteButton (below), not a
  // functional `<select>` that would let the user pick an option that
  // hard-fails. The SAME resolved default is what actually gets sent (desk
  // ChatPane.tsx:252,324): the note must describe what's really queried, not
  // just decorate the toolbar.
  const modelFeature = agentInfo ? selectFeature(agentInfo, "model") : null;

  // While mounted, the pane is visible — that is what marks the chat read.
  useEffect(() => {
    useChatStore.getState().setPaneOpen(true);
    return () => useChatStore.getState().setPaneOpen(false);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // The dialog below is what actually renders for a pending confirmation --
  // this mirrors that same gate so "is the confirmation dialog showing"
  // and "should the pane refuse to auto-collapse" never disagree.
  const pendingSymphonyConfirmation =
    pendingToolConfirmation !== null && isSymphonyPostTool(pendingToolConfirmation.toolName);

  // Focus holds the pane open, and so does an unresolved Symphony
  // confirmation. Without the latter, the confirmation dialog -- portalled to
  // document.body by Modal, so it sits outside the pane's own DOM subtree --
  // gets misread as "tapped outside" by the pane's coarse-pointer outside-tap
  // detector (useHoverPanel.ts): a tap on Send/Decline/the close X/the
  // backdrop would collapse the pane (unmounting ChatPane, and the dialog
  // with it) before the tap's click ever reaches the button, deadlocking the
  // turn with no way to resolve or even see the pending confirmation again
  // except by reopening the pane into the same trap. Keeping `sticky` true
  // for the duration makes useHoverPanel's outside-tap listener a no-op
  // (it already special-cases sticky), so the tap lands on the dialog instead
  // of collapsing out from under it. Deliberately no autofocus on mount:
  // the pane mounts on hover, so grabbing focus would steal the keyboard from
  // wherever the user was working and pin the pane open indefinitely.
  useEffect(() => {
    onStickyChange?.(inputFocused || pendingSymphonyConfirmation);
  }, [inputFocused, pendingSymphonyConfirmation, onStickyChange]);

  useEffect(() => () => onStickyChange?.(false), [onStickyChange]);

  // Best-effort agents.json discovery (desk ChatPane.tsx's `connect`,
  // narrowed to just the model note this pane renders): chatStore's own
  // `/v1/query` URL and offline detection are unchanged, so a failure here
  // is logged and otherwise silent rather than blocking the pane.
  useEffect(() => {
    let cancelled = false;
    fetchAgentsJson(ritaUrl)
      .then((agents) => {
        if (cancelled) return;
        const id = agents.openbb_agent_rita ? "openbb_agent_rita" : Object.keys(agents)[0];
        setAgentInfo(id ? agents[id] : null);
      })
      .catch((e) => {
        if (cancelled) return;
        setAgentInfo(null);
        logError(`agents.json discovery failed: ${ritaUrl}: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [ritaUrl]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isSending) return;
    setInput("");
    setToolWarnings([]);

    // Active-dashboard context for the request's `widgets` field, gated on the
    // contextSharing setting. Distinct from QueryRequest.tools below.
    const widgetContext = contextSharing ? widgetRefs : [];

    // Spec tool-assembly rule: enabled Settings MCP servers UNION the
    // storage.mcpUrl of widgets on the active dashboard. Gated on
    // contextSharing the same as widgetContext above (desk 2b8a646, F3):
    // a card's widget-derived MCP server is dashboard context just as much
    // as its widget ref is — sending it while contextSharing is off leaked
    // the widget id (as a tool label) and contacted a private MCP server
    // behind the user's back.
    const dashboardMcp = contextSharing
      ? currentWidgets
          .map((c) => {
            const def = useRegistryStore.getState().find(c.backendId, c.widgetId);
            return def?.mcpUrl ? { widgetId: c.widgetId, url: def.mcpUrl } : null;
          })
          .filter((x): x is { widgetId: string; url: string } => x !== null)
      : [];

    // assembleTools returns a structured result: usable tools, plus any MCP
    // server that got skipped because it blew the request's byte/tool budget
    // (`budgetExceeded`) or didn't answer at all (`unreachable`). Both carry
    // a pre-formatted, user-facing `message` (types.ts) — surfaced here so a
    // reply that's quietly missing a server's tools isn't unexplained.
    const { tools: mcpTools, budgetExceeded, unreachable } = await assembleTools(mcpServers, dashboardMcp);
    if (budgetExceeded.length > 0 || unreachable.length > 0) {
      setToolWarnings([
        ...budgetExceeded.map((b) => b.message),
        ...unreachable.map((u) => u.message),
      ]);
    }
    // Local tools come first: they are few and cheap, and must not be the ones
    // dropped if a fat MCP server eats the budget.
    const tools = [...LOCAL_TOOLS, ...(mcpTools ?? [])];

    /**
     * Runs whatever the agent invoked. Rita wraps every declared tool in
     * execute_agent_tool and names the server it was declared under, so the
     * server_id is what decides between BDOBB's own tools and a real MCP
     * server. Before this existed the client refused all of them.
     */
    const runAgentTool = async (
      serverId: string,
      toolName: string,
      parameters: Record<string, unknown>
    ) => {
      // Human confirmation gate (plan F2-10): a Symphony post must never
      // execute before the user approves it, regardless of which server_id
      // it arrived under. Checked before any dispatch below -- including the
      // local-tool branch -- so there is no path from a discovered
      // post_to_symphony call to execution that skips this. The await
      // suspends here until resolveToolConfirmation is called (ChatPane's
      // dialog below, or chatStore's cancel()/clear() declining it), so
      // nothing past this point runs until then.
      if (isSymphonyPostTool(toolName)) {
        const decision = await useChatStore
          .getState()
          .requestToolConfirmation(serverId, toolName, parameters);
        if (decision === "declined") {
          return {
            content:
              "The user declined to approve this Symphony message; it was not sent. " +
              "Do not send it again unless the user explicitly asks.",
            isError: true,
          };
        }
      }

      if (serverId === LOCAL_TOOL_SERVER_ID) {
        return executeLocalTool(toolName, parameters, {
          getDashboards: () => useDashboardStore.getState().dashboards,
          getActiveId: () => useDashboardStore.getState().activeId,
          getWidgets: () => useRegistryStore.getState().widgets,
          createDashboard: (name) => useDashboardStore.getState().addDashboard(name),
          setActive: (id) => useDashboardStore.getState().setActive(id),
          addWidget: (widget, backendId) =>
            useDashboardStore.getState().addCard(widget, backendId),
          onBeforeChange: (label, before) =>
            useAgentEditsStore.getState().record(label, before),
        });
      }

      const url = (mcpTools ?? []).find((t) => t.server_id === serverId)?.url;
      if (!url) return null;
      try {
        const res = await callMcpTool(url, toolName, parameters);
        return {
          content: res.content.map((c) => c.text ?? "").filter(Boolean).join("\n"),
        };
      } catch (e) {
        return { content: `MCP tool ${toolName} failed: ${String(e)}`, isError: true };
      }
    };

    // Lets Rita pull a widget's data mid-turn via get_widget_data rather than
    // us pushing table contents into every request.
    const fetchWidgetData = makeWidgetDataFetcher({
      getCards: () => useDashboardStore.getState().active()?.cards ?? [],
      lookupWidget: (backendId, widgetId) => useRegistryStore.getState().find(backendId, widgetId),
      getBackend: (backendId) =>
        useBackendsStore.getState().backends.find((b) => b.id === backendId),
      // Without this the export's "API calls made on your behalf" section is
      // permanently empty while still claiming to record requests in full.
      onCall: (call) => useChatStore.getState().recordCall(call),
    });

    // Not awaited by the component: the store owns the turn, so it survives
    // this pane unmounting when the user hovers away.
    void useChatStore.getState().send(text, {
      queryUrl: `${ritaUrl.replace(/\/+$/, "")}/v1/query`,
      widgets: widgetContext,
      tools,
      fetchWidgetData,
      runAgentTool,
      // Desk ChatPane.tsx:252,324: the model the toolbar note displays is
      // the model actually queried, not just decoration. Omitted (not `{}`)
      // when no model feature was discovered, matching runAgentQuery's own
      // "undefined means no preference" default.
      workspaceOptions: modelFeature ? { model: modelFeature.default } : undefined,
    });
  };

  const handleExport = async () => {
    try {
      const path = await saveChatExport(messages, calls, {
        exportedAt: new Date().toISOString(),
        ritaUrl,
        dashboardName: currentDashboard?.name,
      });
      // null means the user cancelled the dialog, which is not a failure.
      if (path) setExported(path);
    } catch (e) {
      logError(`chat export failed: ${String(e)}`);
    }
  };

  const handleShare = async (targetId: string) => {
    const target = shareTargets.find((t) => t.id === targetId);
    if (!target) return;

    setSharing(true);
    setExported(null);
    try {
      const exportedAt = new Date().toISOString();
      const filename = exportFilename(exportedAt);
      const result = await shareChat(target, {
        markdown: chatToMarkdown(messages, calls, {
          exportedAt,
          ritaUrl,
          dashboardName: currentDashboard?.name,
        }),
        // The first thing asked makes a better note title than a timestamp.
        title: firstPrompt(messages) ?? "Rita conversation",
        filename,
        exportedAt,
      }, {
        // A file target writes outside $APPDATA, so the destination folder
        // must be covered by the fs scope.
        writeFile: (path, contents) => writeTextFile(path, contents),
        mkdir: (path) => mkdir(path, { recursive: true }).then(() => {}),
      });
      setExported(`${result.target}: ${result.detail}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError(`chat share failed: ${message}`);
      setExported(`Failed: ${message}`);
    } finally {
      setSharing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const modelLabel =
    modelFeature?.options.find((o) => o.value === modelFeature.default)?.label
    ?? modelFeature?.default
    ?? null;

  return (
    <div className="chat-pane">
      <div className="chat-toolbar">
        {modelFeature && modelLabel && (
          <NoteButton
            label={`Model: ${modelLabel}`}
            detail={
              `Only ${modelFeature.default} is reachable from this deployment's Rita; ` +
              "the other options in agents.json need providers that aren't configured here."
            }
          />
        )}
        <button
          type="button"
          className="chat-export-btn"
          onClick={handleExport}
          disabled={messages.length === 0}
          title="Save this conversation, and the requests made for it, as markdown"
        >
          Export…
        </button>
        {shareTargets.length > 0 && (
          <select
            className="chat-share-select"
            value=""
            disabled={messages.length === 0 || sharing}
            title="Send this conversation to a configured app"
            onChange={(e) => {
              if (e.target.value) handleShare(e.target.value);
            }}
          >
            <option value="">{sharing ? "Sending…" : "Send to…"}</option>
            {shareTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {exported && <span className="chat-export-note">{exported}</span>}
      </div>
      <div className="chat-messages-container">
        <div className="chat-messages-container-content">
          <ChatMessages messages={messages} />
          <StatusTrail statuses={statuses} live={isSending} />
          {citations.length > 0 && (
            <div className="chat-citations">
              <span className="chat-citations-label">Sources</span>
              <ol>
                {citations.map((c, i) => {
                  const cite = c as { source?: string; url?: string; title?: string };
                  const label = cite.title || cite.source || cite.url || `Source ${i + 1}`;
                  // Citations arrive over the agent's SSE stream. Rendering the
                  // url straight into href would honour javascript:, so an
                  // unsafe scheme degrades to plain text rather than a link.
                  const href = safeUrl(cite.url);
                  return (
                    <li key={i}>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer noopener">
                          {label}
                        </a>
                      ) : (
                        label
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {toolWarnings.map((message, i) => (
        // One MCP server per line: budgetExceeded/unreachable can both fire
        // in the same turn, each naming a different server (Task 9 review's
        // AssembleToolsResult; desk fb47f16 for `unreachable`).
        <div key={i} className="chat-error" role="alert">
          {message}
        </div>
      ))}

      {error && (
        <div className={`chat-error ${agentOffline ? "offline" : ""}`} role="alert">
          {agentOffline && <strong>Rita offline. </strong>}
          {error}
        </div>
      )}

      {pendingSymphonyConfirmation && (
        <SymphonyConfirmDialog confirmation={pendingToolConfirmation!} />
      )}

      <div className="chat-input-area">
        {suggestions.length > 0 && !isSending && (
          <div className="chat-suggestions">
            {suggestions.map((sug, i) => (
              <button
                key={i}
                type="button"
                className="chat-suggestion"
                onClick={() => {
                  setInput(sug);
                  inputRef.current?.focus();
                }}
              >
                {sug}
              </button>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <input
            ref={inputRef}
            type="text"
            aria-label="Message Rita"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Message Rita..."
            disabled={isSending}
            className="chat-input"
          />
          <button
            onClick={sendMessage}
            disabled={isSending || !input.trim()}
            aria-label="Send message"
            className="chat-send-btn"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="chat-send-icon"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        </div>
        <div className="chat-hint">Press Enter to send, Shift+Enter for new line</div>
      </div>
    </div>
  );
}
