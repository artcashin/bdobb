import type { Settings } from "../../../lib/types";

export interface SymphonyTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  fieldIds: string;
}

export default function SymphonyTab({ settings, onChange, fieldIds }: SymphonyTabProps) {
  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Symphony Configuration</h3>
      <div>
        <div className="settings-field">
          <label className="settings-label" htmlFor={`${fieldIds}-symphonyPodUrl`}>
            Pod URL
          </label>
          <input
            id={`${fieldIds}-symphonyPodUrl`}
            type="text"
            value={settings.symphonyPodUrl}
            onChange={(e) => onChange({ symphonyPodUrl: e.target.value })}
            className="settings-input"
            placeholder="https://my-pod.symphony.com"
          />
          <p className="settings-hint">
            Default Symphony pod, used when a card does not set its own Pod URL parameter.
          </p>
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor={`${fieldIds}-symphonyPartnerId`}>
            Partner ID
          </label>
          <input
            id={`${fieldIds}-symphonyPartnerId`}
            type="text"
            value={settings.symphonyPartnerId}
            onChange={(e) => onChange({ symphonyPartnerId: e.target.value })}
            className="settings-input"
            placeholder="Symphony partner ID"
          />
          <p className="settings-hint">
            Sent as the partnerId query parameter on every Symphony embed.
          </p>
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor={`${fieldIds}-symphonyBridgeUrl`}>
            Bridge URL
          </label>
          <input
            id={`${fieldIds}-symphonyBridgeUrl`}
            type="text"
            value={settings.symphonyBridgeUrl}
            onChange={(e) => onChange({ symphonyBridgeUrl: e.target.value })}
            className="settings-input"
            placeholder="http://localhost:PORT"
          />
          <p className="settings-hint">
            Symphony sharing bridge. Not used yet — reserved for sending dashboard context into
            Symphony chat.
          </p>
        </div>
      </div>
    </div>
  );
}
