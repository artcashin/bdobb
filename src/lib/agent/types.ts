// OpenBB agent protocol types (openbb-ai v2.1.0). Reconciled against live
// traffic captured from Agent Rita — where documented protocol behavior and
// observed bytes disagreed, the observed bytes won; see the inline notes
// below for the specific deviations.

// ---- SSE event types ----
export type SseEventType =
  | "message"
  | "copilotMessageChunk"
  | "copilotStatusUpdate"
  | "copilotFunctionCall"
  | "copilotMessageArtifact"
  | "copilotCitationCollection"
  | "copilotPromptSuggestions"
  | "error"
  | "done";

// ---- Agent protocol message types ----
export interface HumanMessage {
  role: "human";
  content: string;
}

export interface AiTextMessage {
  role: "ai";
  content: string;
}

/**
 * Artifacts rendered inline in the transcript. Client-side only — this is not
 * sent back to the agent, which receives artifacts via its own state.
 */
export interface AiArtifactMessage {
  role: "ai";
  content: ClientArtifact[];
}

export interface AiFunctionCallMessage {
  role: "ai";
  content: {
    function: string;
    input_arguments: Record<string, unknown>;
  };
}

export interface DataContentItem {
  content: string;
  /**
   * "table" for widget payloads; "text" for a tool that returns prose, such as
   * BDOBB's own dashboard tools reporting what they changed.
   */
  data_format: { data_type: "object"; parse_as: "table" | "text" };
  citable: boolean;
}

export interface DataContent {
  items: DataContentItem[];
  /**
   * Sent alongside `items` on every outgoing `tool` message's data entries.
   * A direct A/B round trip against Agent Rita with the field present vs.
   * omitted produced identical results — HTTP 200, the same event mix, and
   * the same `copilotCitationCollection` citation id. Rita accepts and
   * ignores it; kept optional and still sent as `[]` because it's harmless,
   * not because it's required.
   */
  extra_citations?: unknown[];
}

export interface ToolError {
  error_type: string;
  content: string;
}

export interface ToolResultMessage {
  role: "tool";
  function: string;
  input_arguments: Record<string, unknown>;
  data: (DataContent | ToolError)[];
  /** Round-tripped verbatim from the copilotFunctionCall event's extra_state. */
  extra_state: Record<string, unknown>;
}

export type ChatMessage =
  | HumanMessage
  | AiTextMessage
  | AiArtifactMessage
  | AiFunctionCallMessage
  | ToolResultMessage;

// ---- Agent protocol (agents.json) ----

/** A `{type:"select",...}` feature value, e.g. agents.json's "model" picker. */
export interface AgentFeatureSelectOption {
  label: string;
  type: "select";
  default: string;
  description?: string;
  options: { label: string; value: string }[];
}

/**
 * A toggleable feature with a boolean default, e.g. agents.json's
 * "prompt-suggestions" feature: `{label, default: true, description}` — no
 * `type`, and `default` is a boolean, not a string. Modeled as its own
 * variant because a plain `boolean` union member can't carry the label or
 * description Settings needs to render the toggle.
 */
export interface AgentFeatureToggleOption {
  label: string;
  default: boolean;
  description?: string;
}

export type AgentFeatureValue =
  | boolean
  | AgentFeatureSelectOption
  | AgentFeatureToggleOption;

export interface AgentInfo {
  name: string;
  description: string;
  image?: string;
  endpoints: { query: string };
  features: Record<string, AgentFeatureValue>;
}

export type AgentsJson = Record<string, AgentInfo>;

// ---- Widget reference types ----
export interface WidgetParamRef {
  name: string;
  type: "text";
  description: string;
  current_value: unknown;
  default_value: unknown;
}

export interface WidgetRef {
  uuid: string;
  origin: string;
  widget_id: string;
  name: string;
  description: string;
  params: WidgetParamRef[];
  metadata: Record<string, unknown>;
}

// ---- MCP tool types ----
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  id: string;
  url: string;
  enabled: boolean;
}

/**
 * A tool descriptor as Rita expects it in QueryRequest.tools. Distinct from
 * McpTool, which is the raw shape a server returns from tools/list.
 */
export interface AgentTool {
  server_id: string;
  name: string;
  url: string;
  endpoint: string;
  description: string;
  input_schema: Record<string, unknown>;
  auth_token?: string;
}

export interface McpToolsResponse {
  tools: McpTool[];
  serverInfo?: {
    name: string;
    version: string;
  };
}

/**
 * One MCP server whose assembled tool set was dropped ENTIRELY (never
 * truncated mid-list) because admitting it would have exceeded
 * `TOOL_PAYLOAD_BUDGET_CHARS` (./mcp.ts `assembleTools`).
 *
 * The budget is CUMULATIVE across all servers, not per server — Rita's
 * context slot is one shared pool, so two individually-small servers can
 * still blow it out combined. Servers are admitted in configured order
 * against a running total; this entry is emitted for the first one that
 * would push that total over the ceiling.
 *
 * `payloadChars` is the tool set's serialized size in CHARACTERS
 * (`JSON.stringify(tools).length`), the same unit as
 * `TOOL_PAYLOAD_BUDGET_CHARS` — not bytes. `message` is pre-formatted and
 * user-facing — render it as-is, naming the server and its size, rather
 * than re-deriving a message from the other fields.
 */
export interface McpBudgetExceeded {
  serverId: string;
  url: string;
  toolCount: number;
  payloadChars: number;
  message: string;
}

/**
 * One MCP server whose discovery call itself failed (down, DNS failure,
 * garbage URL, timeout) — distinct from `McpBudgetExceeded`, where discovery
 * succeeded but the result was too large. Without a structural signal for
 * this case, a dead or misconfigured server is indistinguishable in the UI
 * from "no servers configured". `message` is pre-formatted and user-facing,
 * same convention as `McpBudgetExceeded.message`.
 */
export interface McpUnreachable {
  serverId: string;
  url: string;
  message: string;
}

/**
 * Return shape of `assembleTools` (./mcp.ts). `tools` is what goes on
 * `QueryRequest.tools` (null when no server contributed any). A non-empty
 * `budgetExceeded` means at least one MCP server's tools were silently
 * omitted from `tools` — surface each entry's `message` as a visible error
 * rather than proceeding as if nothing happened. `unreachable` is the same
 * idea for servers whose discovery call itself failed rather than
 * succeeding-but-oversized.
 */
export interface AssembleToolsResult {
  tools: AgentTool[] | null;
  budgetExceeded: McpBudgetExceeded[];
  unreachable: McpUnreachable[];
}

// ---- SSE event parsing types ----
export interface SseEvent {
  event: SseEventType;
  data: unknown;
}

// ---- Query request (POST /v1/query body) ----
export interface QueryRequest {
  messages: ChatMessage[];
  widgets?: { primary: WidgetRef[]; secondary: WidgetRef[]; extra: WidgetRef[] };
  context: null;
  /**
   * `null` is REJECTED by Rita with HTTP 400 ("expected array, received
   * null" at path ["urls"]), but omitting the field entirely is accepted.
   * Typed optional so callers can leave it out rather than send a populated
   * shape that was never probed. Verified against the live agent.
   */
  urls?: unknown[];
  timezone?: string;
  workspace_options?: Record<string, unknown>;
  /** Same null-vs-omit rule as `urls`: `null` 400s, omitting is accepted. */
  tools?: AgentTool[];
}

// ---- Agent event types (parsed from SSE) ----
export interface StatusUpdate {
  eventType: "INFO" | "WARNING" | "ERROR";
  message: string;
  group?: string;
  details?: unknown;
  hidden?: boolean;
  /** Present when the step is a tool invocation (observed live). */
  tool_call?: { tool_name?: string; input?: Record<string, unknown> };
  /** A completed step may carry the artifacts it produced (observed live). */
  artifacts?: ClientArtifact[];
}

export interface ClientArtifact {
  type: "text" | "table" | "chart" | "html";
  name: string;
  description: string;
  uuid: string;
  /**
   * Text, table rows, or — for a chart — a Plotly figure object. The
   * renderer accepts all three; the type previously omitted the figure.
   */
  content: string | Record<string, unknown>[] | Record<string, unknown>;
  chart_params?: Record<string, unknown>;
}

export interface FunctionCallEvent {
  function: string;
  input_arguments: Record<string, unknown>;
  extra_state?: Record<string, unknown>;
}

export interface CitationSourceInfo {
  type: string;
  uuid: string;
  origin: string;
  widget_id: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  citable: boolean;
}

export interface Citation {
  id: string;
  source_info: CitationSourceInfo;
  details: unknown[];
  signature?: string;
}

export interface AgentEvent {
  kind: "chunk" | "status" | "artifact" | "citations" | "suggestions" | "functionCall" | "error" | "done";
  delta?: string;
  status?: StatusUpdate;
  artifact?: ClientArtifact;
  citations?: Citation[];
  suggestions?: string[];
  call?: FunctionCallEvent;
  /** Set on kind: "error" — the agent reported a failure mid-stream. */
  message?: string;
}

// ---- Get widget data types ----
export interface GetWidgetDataSource {
  widget_uuid: string;
  origin: string;
  id: string;
  input_args: Record<string, unknown>;
}

/**
 * `signal` is threaded from `runAgentQuery`'s caller signal through
 * `executeFunction` and `makeWidgetDataFetcher` down to the underlying
 * `dataClient` fetch (Task 6 added the optional-`AbortSignal` support this
 * relies on), so aborting a turn also cancels an in-flight widget fetch
 * instead of letting it run to completion.
 */
export type WidgetDataFetcher = (
  source: GetWidgetDataSource,
  signal?: AbortSignal
) => Promise<string>;

/**
 * One request made while answering a turn, for the exported transcript.
 *
 * `widget_data` calls are made by this app, so everything is known. `agent_tool`
 * entries are only what Rita narrates in a status update — no URL, status or
 * timing, and a tool it does not narrate is invisible to us.
 */
export interface AgentCall {
  kind: "widget_data" | "agent_tool";
  at: string;
  label: string;
  url?: string;
  params?: Record<string, unknown>;
  input?: Record<string, unknown>;
  ok?: boolean;
  durationMs?: number;
  rows?: number;
  error?: string;
}
