import { useEffect, useState, useId } from "react";
import Modal from "../Modal";
import { useSettingsStore } from "../../stores/settingsStore";
import { DEFAULT_SETTINGS } from "../../lib/persistence";
import { isHttpUrl } from "../../lib/safeUrl";
import RitaTab from "./settings/RitaTab";
import McpTab from "./settings/McpTab";
import AppearanceTab from "./settings/AppearanceTab";
import SymphonyTab from "./settings/SymphonyTab";
import LogsTab from "./settings/LogsTab";

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const TABS = [
  { id: "rita", label: "Rita" },
  { id: "mcp", label: "MCP" },
  { id: "appearance", label: "Appearance" },
  { id: "symphony", label: "Symphony" },
  { id: "logs", label: "Logs" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const fieldIds = useId();
  const settings = useSettingsStore((s) => s.settings);
  const loadError = useSettingsStore((s) => s.loadError);
  const updateSettings = useSettingsStore((s) => s.update);

  const [localSettings, setLocalSettings] = useState(settings || DEFAULT_SETTINGS);
  const [activeTab, setActiveTab] = useState<TabId>("rita");

  useEffect(() => {
    setLocalSettings(settings || DEFAULT_SETTINGS);
  }, [settings]);

  useEffect(() => {
    // A reopen should never land on a stale tab from the previous visit.
    if (!isOpen) return;
    setActiveTab("rita");
  }, [isOpen]);

  const handleSave = async () => {
    if (localSettings.ritaUrl && !isHttpUrl(localSettings.ritaUrl)) {
      alert("Please enter a valid HTTP/HTTPS URL for Rita");
      return;
    }
    if (localSettings.symphonyPodUrl && !isHttpUrl(localSettings.symphonyPodUrl)) {
      alert("Please enter a valid HTTP/HTTPS URL for the Symphony pod");
      return;
    }
    if (localSettings.symphonyBridgeUrl && !isHttpUrl(localSettings.symphonyBridgeUrl)) {
      alert("Please enter a valid HTTP/HTTPS URL for the Symphony bridge");
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
        symphonyPodUrl: localSettings.symphonyPodUrl,
        symphonyPartnerId: localSettings.symphonyPartnerId,
        symphonyBridgeUrl: localSettings.symphonyBridgeUrl,
      });
    } catch (e) {
      alert(`Could not save settings: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    onClose();
  };

  const onChange = (patch: Partial<typeof localSettings>) =>
    setLocalSettings((prev) => ({ ...prev, ...patch }));

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
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`${fieldIds}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={activeTab === t.id}
              aria-controls={`${fieldIds}-panel-${t.id}`}
              tabIndex={activeTab === t.id ? 0 : -1}
              className={`settings-tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight" ? (i + 1) % TABS.length
                  : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
                  : e.key === "Home" ? 0
                  : e.key === "End" ? TABS.length - 1
                  : null;
                if (next === null) return;
                e.preventDefault();
                setActiveTab(TABS[next].id);
                document.getElementById(`${fieldIds}-tab-${TABS[next].id}`)?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${fieldIds}-panel-${activeTab}`}
          aria-labelledby={`${fieldIds}-tab-${activeTab}`}
        >
          {activeTab === "rita" && (
            <RitaTab settings={localSettings} onChange={onChange} fieldIds={fieldIds} />
          )}
          {activeTab === "mcp" && (
            <McpTab settings={localSettings} onChange={onChange} fieldIds={fieldIds} />
          )}
          {activeTab === "appearance" && <AppearanceTab settings={localSettings} />}
          {activeTab === "symphony" && (
            <SymphonyTab settings={localSettings} onChange={onChange} fieldIds={fieldIds} />
          )}
          {activeTab === "logs" && <LogsTab />}
        </div>
      </div>
    </Modal>
  );
}
