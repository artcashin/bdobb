import type { AgentCall, AgentFeatureSelectOption, AgentFeatureToggleOption, AgentFeatureValue, AgentInfo, AgentsJson, AgentEvent, AgentTool, ChatMessage, FunctionCallEvent, GetWidgetDataSource, QueryRequest, ToolResultMessage, WidgetDataFetcher, WidgetRef, WidgetParamRef } from "./types";
import type { BackendConfig, DashboardCard, WidgetDef } from "../types";

// Re-export types for convenience
export type { AgentsJson, AgentEvent, ChatMessage, WidgetRef, DashboardCard, WidgetDef };
import { sseEvents, toAgentEvent } from "./sse";
import { buildWidgetUrl, fetchWidgetData } from "../dataClient";
import { logOnce } from "../logger";
import type { ParamValues } from "../types";

const RESPONSE_BODY_PREVIEW_CHARS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSelectFeature(v: Record<string, unknown>): v is AgentFeatureSelectOption & Record<string, unknown> {
  return v.type === "select" && typeof v.label === "string"
    && typeof v.default === "string" && Array.isArray(v.options);
}

function isToggleFeature(v: Record<string, unknown>): v is AgentFeatureToggleOption & Record<string, unknown> {
  return v.type === undefined && typeof v.label === "string"
    && typeof v.default === "boolean";
}

/**
 * `agents.json`'s `features` map is heterogeneous (plain booleans, a
 * `{type:"select",...}` model picker, and a `{label,default:boolean,...}`
 * toggle with no `type` at all — see types.ts). Never throw on a shape we
 * don't recognize: drop it and log once, so a future field Rita adds can't
 * take the whole agents.json response down with it (desk agentClient.ts;
 * ported here per Task 17's carried requirement rather than the blind
 * `as AgentsJson` cast this file used before).
 */
function normalizeFeatures(raw: unknown, agentKey: string): Record<string, AgentFeatureValue> {
  if (!isRecord(raw)) return {};
  const out: Record<string, AgentFeatureValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean") {
      out[key] = value;
    } else if (isRecord(value) && isSelectFeature(value)) {
      out[key] = value;
    } else if (isRecord(value) && isToggleFeature(value)) {
      out[key] = value;
    } else {
      logOnce(
        `agents:unknown-feature-shape:${agentKey}:${key}`,
        `agents.json: agent "${agentKey}" feature "${key}" has an unrecognized shape; ignoring it`
      );
    }
  }
  return out;
}

function normalizeAgentsJson(raw: unknown): AgentsJson {
  if (!isRecord(raw)) {
    logOnce("agents:not-an-object", "agents.json: response body was not an object; returning no agents");
    return {};
  }
  const out: AgentsJson = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      logOnce(`agents:unknown-agent-shape:${key}`, `agents.json: agent "${key}" was not an object; skipping it`);
      continue;
    }
    const endpoints = isRecord(value.endpoints) && typeof value.endpoints.query === "string"
      ? { query: value.endpoints.query }
      : { query: "" };
    const agent: AgentInfo = {
      name: typeof value.name === "string" ? value.name : key,
      description: typeof value.description === "string" ? value.description : "",
      endpoints,
      features: normalizeFeatures(value.features, key),
    };
    if (typeof value.image === "string") agent.image = value.image;
    out[key] = agent;
  }
  return out;
}

export async function fetchAgentsJson(backendUrl: string): Promise<AgentsJson> {
  const url = `${backendUrl.replace(/\/+$/, "")}/agents.json`;

  try {
    const res = await window.fetch(url);

    if (!res.ok) {
      // Preserve the response body: a reverse proxy's own error page or a
      // JSON error naming the actual problem is more actionable than a bare
      // status code — this was the only network call in the client still
      // discarding it (desk commit 03c132a).
      const detail = await res.text().catch(() => "");
      throw new Error(
        `fetchAgentsJson: HTTP ${res.status} from ${url}` +
          (detail ? `: ${detail.slice(0, RESPONSE_BODY_PREVIEW_CHARS)}` : "")
      );
    }

    // Boundary validation instead of a blind cast (desk's
    // normalizeAgentsJson/normalizeFeatures): a shape agents.json adds later
    // gets dropped with a logged warning rather than silently corrupting
    // whatever reads AgentInfo.features downstream.
    return normalizeAgentsJson(await res.json());
  } catch (err) {
    throw new Error(`fetchAgentsJson failed for ${url}: ${String(err)}`);
  }
}

export interface QueryAgentOptions {
  backendUrl: string;
  message: ChatMessage[];
  onEvent: (ev: AgentEvent) => void;
  widgets?: WidgetRef[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function queryAgent(
  backendUrl: string,
  message: ChatMessage[],
  onEvent: (ev: AgentEvent) => void,
  widgets: WidgetRef[] = [],
  fetchImpl: typeof fetch = (...args) => window.fetch(...args),
  signal?: AbortSignal,
  tools: AgentTool[] = []
): Promise<void> {
  const url = `${backendUrl.replace(/\/+$/, "")}/v1/query`;

  const body: QueryRequest = {
    messages: message,
    widgets: { primary: widgets, secondary: [], extra: [] },
    context: null,
    // Rita validates these as arrays and rejects null with HTTP 400:
    //   {"expected":"array","code":"invalid_type","path":["urls"]}
    // Verified against the live agent — every request sent with nulls here
    // was rejected before it reached the model.
    urls: [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workspace_options: {},
    tools,
  };

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      // Preserve the response body: Rita reports validation failures there,
      // and "HTTP 400" alone is not actionable.
      const detail = await res.text().catch(() => "");
      throw new Error(
        `queryAgent: HTTP ${res.status} from ${url}${detail ? `: ${detail.slice(0, RESPONSE_BODY_PREVIEW_CHARS)}` : ""}`
      );
    }

    if (!res.body) {
      throw new Error(`queryAgent: no response body from ${url}`);
    }

    for await (const ev of sseEvents(res.body)) {
      const agentEv = toAgentEvent(ev);

      if (agentEv) {
        onEvent(agentEv);
      }
    }
  } catch (err) {
    throw new Error(`queryAgent failed for ${url}: ${String(err)}`);
  }
}

/**
 * Fetches a widget's data for the agent through the same client the grid uses.
 *
 * This previously re-implemented URL building with string concatenation and
 * window.fetch, so it sent no auth header, applied no dataKey extraction, and
 * bypassed plugin-http — an agent-initiated fetch 401'd against an
 * authenticated backend while the same widget loaded fine on the dashboard.
 *
 * `signal` is threaded down to dataClient's `fetchWidgetData` (Task 6 added
 * the optional-`AbortSignal` param it relies on) so aborting a turn also
 * cancels an in-flight widget fetch instead of letting it run to completion.
 */
export async function getWidgetData(
  backend: BackendConfig,
  widget: WidgetDef,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onRequest?: (url: string) => void
): Promise<unknown> {
  onRequest?.(buildWidgetUrl(backend, widget, params as ParamValues, { theme: "dark" }));
  return fetchWidgetData(backend, widget, params as ParamValues, { theme: "dark" }, undefined, signal);
}

export function buildWidgetRefs(
  cards: DashboardCard[],
  lookupWidget: (backendId: string, widgetId: string) => WidgetDef | undefined,
  backendName: (backendId: string) => string
): WidgetRef[] {
  const refs: WidgetRef[] = [];

  for (const card of cards) {
    const widget = lookupWidget(card.backendId, card.widgetId);

    if (!widget) {
      continue;
    }

    // Key state must never reach an LLM, regardless of the user's
    // contextSharing setting: filtering here (rather than in each caller,
    // e.g. ChatPane) covers every caller of buildWidgetRefs, present and
    // future.
    if (widget.type === "keys") {
      continue;
    }

    const paramRefs: WidgetParamRef[] = [];

    for (const param of widget.params) {
      paramRefs.push({
        name: param.paramName,
        type: "text" as const,
        description: param.description,
        current_value: card.params[param.paramName] ?? param.value ?? null,
        default_value: param.value ?? null,
      });
    }

    refs.push({
      uuid: card.uuid,
      // The backend ID, not its display name: Rita echoes origin back in
      // get_widget_data and makeWidgetDataFetcher resolves it against the
      // backends store. Names are user-editable and can collide; ids cannot.
      // The human-readable name travels in metadata instead.
      origin: card.backendId,
      widget_id: widget.id,
      name: widget.name,
      description: widget.description,
      params: paramRefs,
      metadata: { backend_name: backendName(card.backendId) },
    });
  }

  return refs;
}

export function makeWidgetDataFetcher(
  deps: {
    getCards: () => DashboardCard[];
    lookupWidget: (backendId: string, widgetId: string) => WidgetDef | undefined;
    getBackend: (backendId: string) => BackendConfig | undefined;
    /** Records each request for the exported transcript. */
    onCall?: (call: AgentCall) => void;
  }
): WidgetDataFetcher {
  return async (source: GetWidgetDataSource, signal?: AbortSignal): Promise<string> => {
    // Only serve widgets actually on the active dashboard. The agent echoes
    // back what we sent it, but this keeps a malformed or stale call from
    // pulling an arbitrary endpoint.
    const onDashboard = deps.getCards().some((c) => c.uuid === source.widget_uuid);

    if (!onDashboard) {
      throw new Error(`Widget ${source.widget_uuid} is not on the active dashboard`);
    }

    const backend = deps.getBackend(source.origin);

    if (!backend) {
      throw new Error(`Backend not found: ${source.origin}`);
    }

    const widget = deps.lookupWidget(source.origin, source.id);

    if (!widget) {
      throw new Error(`Widget not found: ${source.id}`);
    }

    // buildWidgetRefs already keeps a keys widget's uuid out of what Rita
    // ever sees, but that is the only thing standing between this function
    // and serving actual API key values: nothing here checked widget type,
    // so any other path that produced a keys uuid (a stale ref, a hand-built
    // tool call) would have this function fetch and hand back live secrets.
    // Refuse in the same shape as an unknown uuid -- not a keys-specific
    // message -- so the response itself doesn't tell the agent a keys widget
    // exists at this uuid.
    if (widget.type === "keys") {
      throw new Error(`Widget ${source.widget_uuid} is not on the active dashboard`);
    }

    const started = Date.now();
    let url = "";
    try {
      // `signal` threaded through to the underlying HTTP fetch so Stop
      // cancels an in-flight widget fetch instead of letting it run to
      // completion (desk commit 03c132a).
      const data = await getWidgetData(backend, widget, source.input_args, signal, (u) => {
        url = u;
      });
      const serialized = JSON.stringify(data);
      deps.onCall?.({
        kind: "widget_data",
        at: new Date(started).toISOString(),
        label: widget.name || widget.id,
        url,
        params: source.input_args,
        ok: true,
        durationMs: Date.now() - started,
        rows: Array.isArray(data) ? data.length : undefined,
      });
      return serialized;
    } catch (e) {
      deps.onCall?.({
        kind: "widget_data",
        at: new Date(started).toISOString(),
        label: widget.name || widget.id,
        url,
        params: source.input_args,
        ok: false,
        durationMs: Date.now() - started,
        error: String(e),
      });
      throw e;
    }
  };
}

// ---- get_widget_data function-call round trip ----

/**
 * Executes a function call from Rita and packages the result as the
 * ToolResultMessage the protocol expects back on the next turn.
 *
 * Per the plan's global constraint, dashboard context carries widget
 * definitions and parameters only — data is never pushed proactively. The
 * agent pulls what it needs through this round trip, which is why there is no
 * "table size threshold" anywhere in the client.
 */
/**
 * Executes a tool the agent asked the client to run.
 *
 * Rita wraps every tool declared in QueryRequest.tools — MCP servers and
 * BDOBB's own local tools alike — in a single `execute_agent_tool` call
 * carrying the server_id it was declared under. Verified live:
 *
 *   {"function":"execute_agent_tool",
 *    "input_arguments":{"server_id":"...","tool_name":"...","parameters":{...}}}
 *
 * Returning null means "not handled", and the caller reports it as unsupported.
 */
export type AgentToolRunner = (
  serverId: string,
  toolName: string,
  parameters: Record<string, unknown>
) => Promise<{ content: string; isError?: boolean } | null>;

async function handleExecuteAgentTool(
  call: FunctionCallEvent,
  runAgentTool?: AgentToolRunner
): Promise<ToolResultMessage> {
  const args = call.input_arguments ?? {};
  const serverId = String(args.server_id ?? "");
  const toolName = String(args.tool_name ?? "");
  const parameters =
    args.parameters && typeof args.parameters === "object"
      ? (args.parameters as Record<string, unknown>)
      : {};

  let result: { content: string; isError?: boolean } | null = null;
  try {
    result = runAgentTool ? await runAgentTool(serverId, toolName, parameters) : null;
  } catch (e) {
    result = { content: `Tool ${toolName} failed: ${String(e)}`, isError: true };
  }

  if (result === null) {
    return {
      role: "tool",
      function: call.function,
      input_arguments: call.input_arguments,
      data: [{
        error_type: "unsupported",
        content: `No handler for tool ${toolName} on ${serverId}.`,
      }],
      extra_state: call.extra_state ?? {},
    };
  }

  return {
    role: "tool",
    function: call.function,
    input_arguments: call.input_arguments,
    data: result.isError
      ? [{ error_type: "tool_failed", content: result.content }]
      : [{
          items: [{
            content: result.content,
            data_format: { data_type: "object", parse_as: "text" },
            citable: false,
          }],
        }],
    extra_state: call.extra_state ?? {},
  };
}

async function handleGetWidgetData(
  call: FunctionCallEvent,
  fetchWidgetData: WidgetDataFetcher,
  signal?: AbortSignal
): Promise<ToolResultMessage> {
  const sources = Array.isArray(call.input_arguments?.data_sources)
    ? (call.input_arguments.data_sources as GetWidgetDataSource[])
    : [];

  const data: ToolResultMessage["data"] = [];
  for (const src of sources) {
    try {
      const content = signal ? await fetchWidgetData(src, signal) : await fetchWidgetData(src);
      data.push({
        items: [{
          content,
          data_format: { data_type: "object", parse_as: "table" },
          citable: true,
        }],
      });
    } catch (e) {
      data.push({
        error_type: "fetch_failed",
        content: `Failed to fetch widget data: ${String(e)}`,
      });
    }
  }

  return {
    role: "tool",
    function: "get_widget_data",
    input_arguments: call.input_arguments,
    data,
    extra_state: call.extra_state ?? {},
  };
}

async function executeFunction(
  call: FunctionCallEvent,
  fetchWidgetData: WidgetDataFetcher,
  runAgentTool?: AgentToolRunner,
  signal?: AbortSignal
): Promise<ToolResultMessage> {
  if (call.function === "execute_agent_tool") {
    return handleExecuteAgentTool(call, runAgentTool);
  }

  if (call.function !== "get_widget_data") {
    return {
      role: "tool",
      function: call.function,
      input_arguments: call.input_arguments,
      data: [{
        error_type: "unsupported",
        content: `Function not supported by BDOBB: ${call.function}`,
      }],
      extra_state: call.extra_state ?? {},
    };
  }

  return handleGetWidgetData(call, fetchWidgetData, signal);
}

/** Default per-round timeout (desk commit 03c132a): see `RunQueryOptions.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 45_000;

export interface RunQueryOptions {
  queryUrl: string;
  messages: ChatMessage[];
  widgets?: WidgetRef[];
  tools?: AgentTool[] | null;
  /** Runs a tool the agent invoked via execute_agent_tool. */
  runAgentTool?: AgentToolRunner;
  workspaceOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent(ev: AgentEvent): void;
  fetchWidgetData: WidgetDataFetcher;
  /** Native fetch by default — SSE streams cannot go through plugin-http. */
  fetchImpl?: typeof fetch;
  maxFunctionRounds?: number;
  /**
   * Aborts a single round (the POST plus its SSE stream) that produces
   * nothing within this window. Desk commit 03c132a, Finding 7: the exact
   * same request body once hung with zero bytes for 120s, then completed in
   * 12s on retry — without this the only escape was the user pressing Stop.
   * Pass 0 to disable. Default 45s.
   */
  timeoutMs?: number;
}

/**
 * Drives a full conversation turn, including any get_widget_data round trips,
 * and returns the messages to append to the transcript: the agent's function
 * call, the tool result, and its final text.
 */
export async function runAgentQuery(opts: RunQueryOptions): Promise<ChatMessage[]> {
  const {
    queryUrl,
    signal,
    onEvent,
    fetchWidgetData,
    fetchImpl = (...args: Parameters<typeof fetch>) => window.fetch(...args),
    maxFunctionRounds = 5,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const messages: ChatMessage[] = [...opts.messages];
  const appended: ChatMessage[] = [];

  for (let round = 0; round <= maxFunctionRounds; round++) {
    const body: QueryRequest = {
      messages,
      widgets: { primary: opts.widgets ?? [], secondary: [], extra: [] },
      context: null,
      // Rita validates these as arrays and rejects null with HTTP 400.
      urls: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      workspace_options: opts.workspaceOptions ?? {},
      tools: opts.tools ?? [],
    };

    // Merge the caller's abort signal with a per-round timeout so either one
    // aborts this round's fetch + SSE stream (desk commit 03c132a, Finding 7).
    // `signal` stays optional here (qwen callers, and this file's own tests,
    // routinely omit it) — desk's version requires it, so the merge into a
    // fresh AbortController only listens for a caller abort when one exists.
    const roundController = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => roundController.abort();
    if (signal) {
      if (signal.aborted) roundController.abort();
      else signal.addEventListener("abort", onCallerAbort);
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        roundController.abort();
      }, timeoutMs)
      : undefined;

    let assistantText = "";
    let functionCall: FunctionCallEvent | null = null;
    let streamError: string | null = null;

    try {
      const res = await fetchImpl(queryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: roundController.signal,
      });

      if (!res.ok) {
        // Preserve the response body: Rita's 400s are pydantic payloads naming
        // the exact rejected field (desk commit 03c132a).
        const detail = await res.text().catch(() => "");
        throw new Error(
          `runAgentQuery: HTTP ${res.status} from ${queryUrl}${detail ? `: ${detail.slice(0, RESPONSE_BODY_PREVIEW_CHARS)}` : ""}`
        );
      }
      if (!res.body) {
        throw new Error(`runAgentQuery: no response body from ${queryUrl}`);
      }

      for await (const raw of sseEvents(res.body)) {
        const ev = toAgentEvent(raw);
        if (!ev) continue;
        onEvent(ev);
        if (ev.kind === "chunk") assistantText += ev.delta ?? "";
        if (ev.kind === "functionCall" && ev.call) functionCall = ev.call;
        // The stream can carry a failure with a 200 status; treating it as a
        // normal end produced a successful-looking, truncated answer.
        if (ev.kind === "error") streamError = ev.message ?? "The agent reported an error";
      }
    } catch (e) {
      if (timedOut) {
        throw new Error(`runAgentQuery: timed out after ${timeoutMs}ms waiting on ${queryUrl}`);
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }

    if (streamError) {
      throw new Error(`Agent reported an error: ${streamError}`);
    }

    if (!functionCall) {
      // Turn complete. Only record a text message if there was any text.
      if (assistantText) {
        const msg: ChatMessage = { role: "ai", content: assistantText };
        messages.push(msg);
        appended.push(msg);
      }
      return appended;
    }

    // Echo the call, then answer it, then go round again with both in history.
    const callMsg: ChatMessage = {
      role: "ai",
      content: { function: functionCall.function, input_arguments: functionCall.input_arguments },
    };
    const resultMsg = await executeFunction(functionCall, fetchWidgetData, opts.runAgentTool, signal);

    messages.push(callMsg, resultMsg);
    appended.push(callMsg, resultMsg);
  }

  throw new Error(
    `runAgentQuery: exceeded ${maxFunctionRounds} function rounds without a final answer`
  );
}
