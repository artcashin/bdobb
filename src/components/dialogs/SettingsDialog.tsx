import { useEffect, useState } from "react";
import Modal from "../Modal";
import { getLogPath, logError, readLogTail } from "../../lib/logger";
import { useSettingsStore } from "../../stores/settingsStore";

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const loadError = useSettingsStore((s) => s.loadError);
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
    // Gated on isOpen — the dialog stays mounted at all times so Modal's
    // isOpen prop can animate/hide it, so an unconditional effect here would
    // read the log file on every app launch whether or not Settings is ever
    // opened.
    if (!isOpen) return;
    loadLog().catch((e) => logError(`SettingsDialog: loadLog failed: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      footer={
        <button
          onClick={onClose}
          className="backend-btn"
          style={{ color: "var(--text)", padding: "8px 16px" }}
        >
          Close
        </button>
      }
    >
      <div>
        {loadError && (
          <p className="error-box" role="status">
            Settings could not be loaded from disk ({loadError}); showing the
            last-known values.
          </p>
        )}
        <div className="settings-section">
          <h3 className="settings-section-title">Theme</h3>
          <p className="settings-hint">
            Version 3 only supports dark theme. Light theme support is planned
            for future versions.
          </p>
        </div>

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
            className="settings-reload-btn"
          >
            Reload log
          </button>
        </div>
      </div>
    </Modal>
  );
}
