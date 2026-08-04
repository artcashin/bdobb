import { useState } from "react";
import { useAgentEditsStore } from "../stores/agentEditsStore";
import { logError } from "../lib/logger";

/**
 * Reports the agent's most recent dashboard change and offers to reverse it.
 *
 * Sits with the dashboard rather than in the chat pane on purpose: the pane
 * collapses when the pointer leaves it, and an undo the user cannot find is
 * the same as no undo at all. Agent edits apply immediately — asking first on
 * every step would make building a dashboard by conversation slower than doing
 * it by hand — so this is what makes that acceptable.
 */
export default function AgentEditBar() {
  const edits = useAgentEditsStore((s) => s.edits);
  const undoLast = useAgentEditsStore((s) => s.undoLast);
  const clear = useAgentEditsStore((s) => s.clear);
  const [busy, setBusy] = useState(false);

  const last = edits[edits.length - 1];
  if (!last) return null;

  return (
    <div className="agent-edit-bar" role="status">
      <span className="agent-edit-text">
        Rita {last.label}
        {edits.length > 1 && (
          <span className="agent-edit-count"> · {edits.length} changes this session</span>
        )}
      </span>
      <button
        className="agent-edit-undo"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          undoLast()
            .catch((e) => logError(`undo failed: ${String(e)}`))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Undoing…" : "Undo"}
      </button>
      <button className="agent-edit-dismiss" aria-label="Dismiss" onClick={() => clear()}>
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
