import { useEffect, useState } from "react";
import type { Settings } from "../../../lib/types";
import { assembleTools, clearMcpCache } from "../../../lib/agent/mcp";
import { logError } from "../../../lib/logger";
import { isHttpUrl } from "../../../lib/safeUrl";
import type { McpBudgetExceeded, McpUnreachable } from "../../../lib/agent/types";

export interface McpTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  fieldIds: string;
}

export default function McpTab({ settings, onChange }: McpTabProps) {
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [mcpChecking, setMcpChecking] = useState(false);
  const [mcpCheck, setMcpCheck] = useState<
    { toolCount: number; budgetExceeded: McpBudgetExceeded[]; unreachable: McpUnreachable[] } | null
  >(null);

  // Mirrors the pre-split SettingsDialog effect that reset both the draft
  // and the MCP budget-check result when the store's settings changed while
  // the dialog was open. The draft reset now lives in SettingsDialog; this
  // clears the check so a stale banner (computed against the pre-reset
  // server list) doesn't linger on screen.
  useEffect(() => {
    setMcpCheck(null);
  }, [settings]);

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
    onChange({ mcpServers: [...settings.mcpServers, newServer] });
    setNewMcpUrl("");
  };

  const handleRemoveMcpServer = (id: string) => {
    clearMcpCache();
    setMcpCheck(null);
    onChange({ mcpServers: settings.mcpServers.filter((s) => s.id !== id) });
  };

  const handleToggleMcpServer = (id: string) => {
    clearMcpCache();
    setMcpCheck(null);
    onChange({
      mcpServers: settings.mcpServers.map((s) =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      ),
    });
  };

  // Diagnostic, not a save action: runs assembleTools against the draft's
  // server list so a budget/unreachable problem is caught before Save
  // instead of surfacing as a transient chat-turn error (Task 17 already
  // surfaces both there, but only after a real chat query is attempted).
  const checkMcpBudget = async () => {
    clearMcpCache();
    setMcpChecking(true);
    try {
      const result = await assembleTools(settings.mcpServers, []);
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
    <div className="settings-section">
      <h3 className="settings-section-title">MCP Servers</h3>
      <div>
        {settings.mcpServers.map((server) => {
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
            disabled={mcpChecking || settings.mcpServers.every((s) => !s.enabled)}
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
  );
}
