import type { AgentTool } from "./types";
import type { Dashboard, WidgetDef } from "../types";

/**
 * Tools BDOBB executes itself, letting the agent build dashboards.
 *
 * Rita cannot reach a dashboard through the custom-agent protocol — there is no
 * layout-mutation event, which is why OpenBB Copilot can create navigation bars
 * and a custom agent cannot. But the protocol already routes tool calls back to
 * the client: a tool advertised in QueryRequest.tools comes back as
 * `execute_agent_tool` carrying the server_id it was declared under. Declaring
 * tools under a reserved server_id and executing them locally gives the agent
 * the capability without extending the protocol.
 *
 * Verified against live Rita, which emits:
 *   {"function":"execute_agent_tool",
 *    "input_arguments":{"server_id":"bdobb-local","tool_name":"create_dashboard",
 *                       "parameters":{"name":"Macro Watch"}}}
 *
 * Kept deliberately few and flat. The default model is a local one, and
 * tool-calling accuracy falls off with the number of tools and the depth of
 * their arguments.
 */
export const LOCAL_TOOL_SERVER_ID = "bdobb-local";

export const CREATE_DASHBOARD = "create_dashboard";
export const ADD_WIDGET = "add_widget";

function tool(name: string, description: string, schema: Record<string, unknown>): AgentTool {
  return {
    server_id: LOCAL_TOOL_SERVER_ID,
    name,
    // Executed in-process; there is no endpoint to call. The server_id is what
    // routes the call, not the url.
    url: "",
    endpoint: "",
    description,
    input_schema: schema,
  };
}

export const LOCAL_TOOLS: AgentTool[] = [
  tool(
    CREATE_DASHBOARD,
    "Create a new dashboard for the user, optionally populated with widgets. " +
      "Use this when the user asks for a new dashboard, board, tab or view. " +
      "Widget ids must come from the widgets available on this workspace.",
    {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the new dashboard." },
        widget_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional widget ids to place on the new dashboard, in order.",
        },
      },
      required: ["name"],
    }
  ),
  tool(
    ADD_WIDGET,
    "Add a widget to a dashboard. Defaults to the dashboard the user is currently viewing.",
    {
      type: "object",
      properties: {
        widget_id: { type: "string", description: "Id of the widget to add." },
        dashboard_name: {
          type: "string",
          description: "Dashboard to add it to. Omit for the current dashboard.",
        },
      },
      required: ["widget_id"],
    }
  ),
];

/** State an undo needs to put back. */
export interface DashboardSnapshot {
  dashboards: Dashboard[];
  activeId: string | null;
}

export interface LocalToolDeps {
  getDashboards(): Dashboard[];
  getActiveId(): string | null;
  /** Every widget the registry knows, across backends. */
  getWidgets(): WidgetDef[];
  createDashboard(name: string): Promise<string>;
  setActive(id: string): void;
  addWidget(widget: WidgetDef, backendId: string): Promise<void>;
  /** Called with the pre-change state before anything is mutated. */
  onBeforeChange(label: string, snapshot: DashboardSnapshot): void;
}

export interface LocalToolResult {
  content: string;
  isError?: boolean;
}

function snapshot(deps: LocalToolDeps): DashboardSnapshot {
  // Structured copy, not a shallow one: undo must not hand back objects the
  // store has since mutated in place.
  return {
    dashboards: JSON.parse(JSON.stringify(deps.getDashboards())) as Dashboard[],
    activeId: deps.getActiveId(),
  };
}

/**
 * Resolves a widget id the agent named. Matched case-insensitively and against
 * the display name as a fallback, because a model asked to "add the historical
 * prices widget" reliably produces a plausible id rather than an exact one.
 */
function resolveWidget(widgets: WidgetDef[], wanted: string): WidgetDef | undefined {
  const needle = wanted.trim().toLowerCase();
  return (
    widgets.find((w) => w.id.toLowerCase() === needle) ??
    widgets.find((w) => w.name.toLowerCase() === needle) ??
    widgets.find((w) => w.id.toLowerCase().replace(/[_-]/g, "") === needle.replace(/[_-]/g, ""))
  );
}

export async function executeLocalTool(
  toolName: string,
  params: Record<string, unknown>,
  deps: LocalToolDeps
): Promise<LocalToolResult> {
  if (toolName === CREATE_DASHBOARD) {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) return { content: "create_dashboard needs a name.", isError: true };

    const wanted = Array.isArray(params.widget_ids)
      ? params.widget_ids.filter((w): w is string => typeof w === "string")
      : [];

    deps.onBeforeChange(`created dashboard "${name}"`, snapshot(deps));

    const id = await deps.createDashboard(name);
    deps.setActive(id);

    const added: string[] = [];
    const missing: string[] = [];
    const widgets = deps.getWidgets();
    for (const w of wanted) {
      const found = resolveWidget(widgets, w);
      if (!found) {
        missing.push(w);
        continue;
      }
      await deps.addWidget(found, found.backendId);
      added.push(found.name);
    }

    // The agent is told exactly what happened, including the misses, so it can
    // say so rather than claiming a dashboard that is half empty.
    const parts = [`Created dashboard "${name}".`];
    if (added.length) parts.push(`Added: ${added.join(", ")}.`);
    if (missing.length) parts.push(`No widget matched: ${missing.join(", ")}.`);
    return { content: parts.join(" ") };
  }

  if (toolName === ADD_WIDGET) {
    const wanted = typeof params.widget_id === "string" ? params.widget_id : "";
    if (!wanted) return { content: "add_widget needs a widget_id.", isError: true };

    const found = resolveWidget(deps.getWidgets(), wanted);
    if (!found) {
      return {
        content: `No widget matches "${wanted}". Available ids include: ${deps
          .getWidgets()
          .slice(0, 15)
          .map((w) => w.id)
          .join(", ")}`,
        isError: true,
      };
    }

    const target = typeof params.dashboard_name === "string" ? params.dashboard_name.trim() : "";
    let targetId = deps.getActiveId();
    if (target) {
      const match = deps
        .getDashboards()
        .find((d) => d.name.toLowerCase() === target.toLowerCase());
      if (!match) return { content: `No dashboard named "${target}".`, isError: true };
      targetId = match.id;
    }
    if (!targetId) return { content: "There is no dashboard to add to.", isError: true };

    deps.onBeforeChange(`added "${found.name}"`, snapshot(deps));
    deps.setActive(targetId);
    await deps.addWidget(found, found.backendId);

    const dashName = deps.getDashboards().find((d) => d.id === targetId)?.name ?? "the dashboard";
    return { content: `Added "${found.name}" to "${dashName}".` };
  }

  return { content: `Unknown tool: ${toolName}`, isError: true };
}
