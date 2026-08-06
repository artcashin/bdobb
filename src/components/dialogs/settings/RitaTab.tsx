import type { Settings } from "../../../lib/types";
import { defaultTemplate, type ShareTarget } from "../../../lib/chatShare";

export interface RitaTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  fieldIds: string;
}

export default function RitaTab({ settings, onChange, fieldIds }: RitaTabProps) {
  const addShareTarget = (kind: ShareTarget["kind"]) => {
    onChange({
      shareTargets: [
        ...(settings.shareTargets ?? []),
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
    });
  };

  const updateShareTarget = (id: string, patch: Partial<ShareTarget>) => {
    onChange({
      shareTargets: (settings.shareTargets ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  };

  const removeShareTarget = (id: string) => {
    onChange({
      shareTargets: (settings.shareTargets ?? []).filter((t) => t.id !== id),
    });
  };

  return (
    <>
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
              value={settings.ritaUrl}
              onChange={(e) => onChange({ ritaUrl: e.target.value })}
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
              onClick={() => onChange({ contextSharing: !settings.contextSharing })}
              role="switch"
              aria-checked={settings.contextSharing}
              // The name must describe the control, not the action: the old
              // aria-label read "Enable context sharing" while aria-checked
              // said it was already on, which is the opposite of the state.
              aria-labelledby={`${fieldIds}-ctxLabel`}
              className={`settings-toggle-switch ${settings.contextSharing ? "active" : ""}`}
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
        <h3 className="settings-section-title">Send chat to…</h3>
        <p className="settings-help">
          Places a conversation can be sent from the chat pane. The template is
          the JSON argument object for an MCP tool, or the request body for an
          HTTP endpoint. Use <code>{"{{markdown}}"}</code>,{" "}
          <code>{"{{title}}"}</code>, <code>{"{{filename}}"}</code> or{" "}
          <code>{"{{exportedAt}}"}</code> where the values should go.
        </p>

        {(settings.shareTargets ?? []).map((t) => (
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
    </>
  );
}
