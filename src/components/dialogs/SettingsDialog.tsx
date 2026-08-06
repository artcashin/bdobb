import { useEffect, useState, useId } from "react";
import Modal from "../Modal";
import { useSettingsStore } from "../../stores/settingsStore";
import { defaultTemplate, type ShareTarget } from "../../lib/chatShare";
import { DEFAULT_SETTINGS } from "../../lib/persistence";
import { assembleTools, clearMcpCache } from "../../lib/agent/mcp";
import { getLogPath, logError, readLogTail } from "../../lib/logger";
import { isHttpUrl } from "../../lib/safeUrl";
import type { McpBudgetExceeded, McpUnreachable } from "../../lib/agent/types";

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const fieldIds = useId();
  const settings = useSettingsStore((s) => s.settings);
  const loadError = useSettingsStore((s) => s.loadError);
  const updateSettings = useSettingsStore((s) => s.update);

  const [localSettings, setLocalSettings] = useState(settings || DEFAULT_SETTINGS);
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [logPath, setLogPath] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoadError, setLogLoadError] = useState<string | null>(null);
  const [mcpChecking, setMcpChecking] = useState(false);
  const [mcpCheck, setMcpCheck] = useState<
    { toolCount: number; budgetExceeded: McpBudgetExceeded[]; unreachable: McpUnreachable[] } | null
  >(null);

  useEffect(() => {
    setLocalSettings(settings || DEFAULT_SETTINGS);
    setMcpCheck(null);
  }, [settings]);

  // Ported from desk's SettingsDialog log viewer (carried requirement, Task
  // 3 forward-note): readLogTail/getLogPath were added to lib/logger.ts
  // specifically for this panel.
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
    // Gated on isOpen (unlike desk's, which is only ever mounted while open)
    // -- qwen's SettingsDialog stays mounted at all times so Modal's isOpen
    // prop can animate/hide it, so an unconditional effect here would read
    // the log file on every app launch whether or not Settings is ever
    // opened.
    if (!isOpen) return;
    loadLog().catch((e) => logError(`SettingsDialog: loadLog failed: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleSave = async () => {
    if (localSettings.ritaUrl && !isHttpUrl(localSettings.ritaUrl)) {
      alert("Please enter a valid HTTP/HTTPS URL for Rita");
      return;
    }

    // One awaited write. Four un-awaited setters each wrote settings.json in
    // the same tick, so which snapshot landed was non-deterministic and three
    // rejections went unhandled.
    try {
      await updateSettings({
        ritaUrl: localSettings.ritaUrl,
        contextSharing: localSettings.contextSharing,
        mcpServers: localSettings.mcpServers,
        shareTargets: localSettings.shareTargets ?? [],
      });
    } catch (e) {
      alert(`Could not save settings: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    onClose();
  };

  const addShareTarget = (kind: ShareTarget["kind"]) => {
    setLocalSettings((prev) => ({
      ...prev,
      shareTargets: [
        ...(prev.shareTargets ?? []),
        {
          id: `target-${Date.now()}`,
          name:
            kind === "mcp" ? "New MCP target"
            : kind === "file" ? "New folder target"
            : "New HTTP target",
          kind,
          url: "",
          tool: kind === "mcp" ? "" : undefined,
          template: defaultTemplate(kind),
        },
      ],
    }));
  };

  const updateShareTarget = (id: string, patch: Partial<ShareTarget>) => {
    setLocalSettings((prev) => ({
      ...prev,
      shareTargets: (prev.shareTargets ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  };

  const removeShareTarget = (id: string) => {
    setLocalSettings((prev) => ({
      ...prev,
      shareTargets: (prev.shareTargets ?? []).filter((t) => t.id !== id),
    }));
  };

  const handleAddMcpServer = () => {
    const url = newMcpUrl.trim();
    if (!url || !isHttpUrl(url)) return;

    const newServer = {
      id: `mcp-${Date.now()}`,
      url,
      enabled: true,
    };

    clearMcpCache();
    setMcpCheck(null);
    setLocalSettings((prev) => ({
      ...prev,
      mcpServers: [...prev.mcpServers, newServer],
    }));
    setNewMcpUrl("");
  };

  const handleRemoveMcpServer = (id: string) => {
    clearMcpCache();
    setMcpCheck(null);
    setLocalSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.filter((s) => s.id !== id),
    }));
  };

  const handleToggleMcpServer = (id: string) => {
    clearMcpCache();
    setMcpCheck(null);
    setLocalSettings((prev) => ({
      ...prev,
      mcpServers: prev.mcpServers.map((s) =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      ),
    }));
  };

  // Diagnostic, not a save action: runs assembleTools against the draft's
  // server list so a budget/unreachable problem is caught before Save
  // instead of surfacing as a transient chat-turn error (Task 17 already
  // surfaces both there, but only after a real chat query is attempted).
  const checkMcpBudget = async () => {
    clearMcpCache();
    setMcpChecking(true);
    try {
      const result = await assembleTools(localSettings.mcpServers, []);
      setMcpCheck({
        toolCount: result.tools?.length ?? 0,
        budgetExceeded: result.budgetExceeded,
        unreachable: result.unreachable,
      });
    } catch (e) {
      logError(`SettingsDialog: MCP budget check failed: ${String(e)}`);
    } finally {
      setMcpChecking(false);
    }
  };

  const newMcpUrlTrimmed = newMcpUrl.trim();
  const newMcpUrlValid = newMcpUrlTrimmed === "" || isHttpUrl(newMcpUrlTrimmed);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      footer={
        <>
          <button
            onClick={onClose}
            className="backend-btn"
            style={{ color: "var(--text)", padding: "8px 16px" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="backend-btn"
            style={{ padding: "8px 16px", background: "var(--accent)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            Save Settings
          </button>
        </>
      }
    >
      <div>
        {loadError && (
          <p className="error-box" role="status">
            Settings could not be loaded from disk ({loadError}); showing the
            last-known values. Saving now will overwrite whatever is on disk
            with these.
          </p>
        )}
        <div className="settings-section">
          <h3 className="settings-section-title">Rita Configuration</h3>
          <div>
            <div className="settings-field">
              <label className="settings-label" htmlFor={`${fieldIds}-ritaUrl`}>
                Rita URL
              </label>
              <input
                id={`${fieldIds}-ritaUrl`}
                type="text"
                value={localSettings.ritaUrl}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    ritaUrl: e.target.value,
                  }))
                }
                className="settings-input"
                placeholder="http://localhost:8002"
              />
              <p className="settings-hint">
                The URL where Rita is running. Required for chat functionality.
              </p>
            </div>
            <div className="settings-toggle">
              <label className="settings-toggle-label" id={`${fieldIds}-ctxLabel`}>
                Context Sharing
              </label>
              <button
                onClick={() =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    contextSharing: !prev.contextSharing,
                  }))
                }
                role="switch"
                aria-checked={localSettings.contextSharing}
                // The name must describe the control, not the action: the old
                // aria-label read "Enable context sharing" while aria-checked
                // said it was already on, which is the opposite of the state.
                aria-labelledby={`${fieldIds}-ctxLabel`}
                className={`settings-toggle-switch ${localSettings.contextSharing ? "active" : ""}`}
              >
                <span
                  className="settings-toggle-thumb"
                />
              </button>
              <span className="settings-toggle-hint">
                Share dashboard widgets with Rita for context
              </span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">MCP Servers</h3>
          <div>
            {localSettings.mcpServers.map((server) => {
              const exceeded = mcpCheck?.budgetExceeded.find((b) => b.serverId === server.id);
              const unreachable = mcpCheck?.unreachable.find((u) => u.serverId === server.id);
              return (
                <div
                  key={server.id}
                  className="mcp-server-item"
                >
                  <div className="mcp-server-info">
                    <span className="mcp-server-url">
                      {server.url}
                    </span>
                    <span
                      className={`mcp-status-badge ${server.enabled ? "enabled" : "disabled"}`}
                    >
                      {server.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {exceeded && (
                      <span className="mcp-status-badge disabled" title={exceeded.message}>
                        budget exceeded ({exceeded.toolCount} tools)
                      </span>
                    )}
                    {unreachable && (
                      <span className="mcp-status-badge disabled" title={unreachable.message}>
                        unreachable
                      </span>
                    )}
                  </div>
                  <div className="mcp-server-actions">
                    <button
                      onClick={() => handleToggleMcpServer(server.id)}
                      className="mcp-btn enable"
                    >
                      {server.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => handleRemoveMcpServer(server.id)}
                      className="mcp-btn remove"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}

            <div className="mcp-add-row">
              <input
                type="text"
                aria-label="New MCP server URL"
                value={newMcpUrl}
                onChange={(e) => setNewMcpUrl(e.target.value)}
                className="mcp-add-input"
                placeholder="http://localhost:7769/mcp"
              />
              <button
                onClick={handleAddMcpServer}
                disabled={newMcpUrlTrimmed === "" || !newMcpUrlValid}
                className="mcp-add-btn"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => checkMcpBudget().catch((e) => logError(`SettingsDialog: MCP check failed: ${String(e)}`))}
                disabled={mcpChecking || localSettings.mcpServers.every((s) => !s.enabled)}
                className="mcp-add-btn"
              >
                {mcpChecking ? "Checking…" : "Check tool budget"}
              </button>
            </div>
            {!newMcpUrlValid && newMcpUrlTrimmed !== "" && (
              <p className="settings-hint">Not a valid URL.</p>
            )}
            {mcpCheck && (
              <p className="settings-hint">
                {mcpCheck.toolCount} tool(s) available from enabled servers.
                {mcpCheck.budgetExceeded.length > 0 &&
                  " One or more servers exceeded the request budget and were dropped — see above."}
                {mcpCheck.unreachable.length > 0 &&
                  " One or more servers could not be reached — see above."}
              </p>
            )}
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">Send chat to…</h3>
          <p className="settings-help">
            Places a conversation can be sent from the chat pane. The template is
            the JSON argument object for an MCP tool, or the request body for an
            HTTP endpoint. Use <code>{"{{markdown}}"}</code>,{" "}
            <code>{"{{title}}"}</code>, <code>{"{{filename}}"}</code> or{" "}
            <code>{"{{exportedAt}}"}</code> where the values should go.
          </p>

          {(localSettings.shareTargets ?? []).map((t) => (
            <div key={t.id} className="share-target">
              <div className="share-target-row">
                <input
                  aria-label="Target name"
                  value={t.name}
                  onChange={(e) => updateShareTarget(t.id, { name: e.target.value })}
                  placeholder="Name"
                />
                <span className="share-target-kind">{t.kind.toUpperCase()}</span>
                <button onClick={() => removeShareTarget(t.id)} className="mcp-btn remove">
                  Remove
                </button>
              </div>
              <input
                aria-label={`${t.name} URL`}
                value={t.url}
                onChange={(e) => updateShareTarget(t.id, { url: e.target.value })}
                placeholder={
                  t.kind === "mcp" ? "https://host/mcp"
                  : t.kind === "file" ? "/Users/you/Vault/Folder"
                  : "https://host/webhook"
                }
              />
              {t.kind === "mcp" && (
                <input
                  aria-label={`${t.name} tool`}
                  value={t.tool ?? ""}
                  onChange={(e) => updateShareTarget(t.id, { tool: e.target.value })}
                  placeholder="Tool name, e.g. create_note"
                />
              )}
              <textarea
                aria-label={`${t.name} template`}
                value={t.template}
                onChange={(e) => updateShareTarget(t.id, { template: e.target.value })}
                rows={5}
                spellCheck={false}
                className="share-target-template"
              />
            </div>
          ))}

          <div className="mcp-add-row">
            <button onClick={() => addShareTarget("mcp")} className="mcp-add-btn">
              Add MCP target
            </button>
            <button onClick={() => addShareTarget("file")} className="mcp-add-btn">
              Add folder target
            </button>
            <button onClick={() => addShareTarget("http")} className="mcp-add-btn">
              Add HTTP target
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">Appearance</h3>
          <div>
            <div className="mcp-server-item" style={{ padding: "8px 12px" }}>
              <span className="mcp-server-url">Theme</span>
              <span className="mcp-server-url">Dark (v1)</span>
            </div>
            <p className="settings-hint">
              Version 1 only supports dark theme. Light theme support is planned for future versions.
            </p>
          </div>
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
            className="mcp-add-btn"
          >
            Reload log
          </button>
        </div>
      </div>
    </Modal>
  );
}
