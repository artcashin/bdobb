import { useState } from "react";
import type { StatusUpdate } from "../../lib/agent/types";

interface StatusTrailProps {
  statuses: StatusUpdate[];
  /** Keeps the trail open while the turn is still running. */
  live?: boolean;
}

/**
 * The agent's reasoning steps, as emitted by copilotStatusUpdate.
 *
 * Live shape (captured from a real turn):
 *   {"eventType":"INFO","message":"Extracting table from text",
 *    "group":"reasoning","tool_call":{"tool_name":"create_table_from_text",…}}
 *
 * Collapsed by default once a turn finishes: the steps matter while you are
 * waiting and become noise afterwards, but throwing them away makes it
 * impossible to see which tool produced an answer.
 */
export default function StatusTrail({ statuses, live = false }: StatusTrailProps) {
  const [open, setOpen] = useState(false);

  // `hidden` is the agent telling us a step is not for display.
  const visible = statuses.filter((s) => !s.hidden);
  if (visible.length === 0) return null;

  const expanded = live || open;
  const last = visible[visible.length - 1];
  const errors = visible.filter((s) => s.eventType === "ERROR").length;

  return (
    <div className={`status-trail ${live ? "live" : ""}`}>
      <button
        type="button"
        className="status-trail-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="status-trail-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        {live ? (
          <span className="status-trail-summary">{last.message}</span>
        ) : (
          <span className="status-trail-summary">
            {visible.length} step{visible.length === 1 ? "" : "s"}
            {errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}
          </span>
        )}
      </button>

      {expanded && (
        <ol className="status-trail-list">
          {visible.map((s, i) => (
            <li key={i} className={`status-step ${s.eventType.toLowerCase()}`}>
              <span className="status-step-message">{s.message}</span>
              {s.tool_call?.tool_name && (
                <code className="status-step-tool">{s.tool_call.tool_name}</code>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
