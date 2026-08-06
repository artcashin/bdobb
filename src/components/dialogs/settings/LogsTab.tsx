import { useEffect, useState } from "react";
import { getLogPath, logError, readLogTail } from "../../../lib/logger";

// Ported from desk's SettingsDialog log viewer (carried requirement, Task 3
// forward-note): readLogTail/getLogPath were added to lib/logger.ts
// specifically for this panel.
export default function LogsTab() {
  const [logPath, setLogPath] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoadError, setLogLoadError] = useState<string | null>(null);

  const loadLog = async () => {
    try {
      setLogPath(await getLogPath());
    } catch (e) {
      setLogPath("(available in the packaged app)");
      logError(`SettingsDialog: getLogPath failed: ${String(e)}`);
    }
    try {
      const lines = await readLogTail(100);
      setLogLines(lines);
      setLogLoadError(null);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logError(`SettingsDialog: readLogTail failed: ${reason}`);
      setLogLoadError(`Failed to read log: ${reason}`);
    }
  };

  useEffect(() => {
    // Unlike the dialog-level effect this replaces (gated on isOpen because
    // the dialog stayed mounted at all times), this tab only mounts when the
    // Logs tab is selected, so loading on mount already reads the log
    // exactly when someone looks at this panel -- no isOpen gate needed.
    loadLog().catch((e) => logError(`SettingsDialog: loadLog failed: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Log</h3>
      <p className="settings-hint">{logPath}</p>
      {logLoadError && <p className="error-box">{logLoadError}</p>}
      <pre className="raw-json" style={{ maxHeight: 200, background: "var(--bg-2, transparent)" }}>
        {logLines.length > 0 ? logLines.join("\n") : "(log is empty)"}
      </pre>
      <button
        type="button"
        onClick={() => loadLog().catch((e) => logError(`SettingsDialog: reload log failed: ${String(e)}`))}
        className="mcp-add-btn"
      >
        Reload log
      </button>
    </div>
  );
}
