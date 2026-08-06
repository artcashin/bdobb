import type { Settings } from "../../../lib/types";

export interface SymphonyTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  fieldIds: string;
}

export default function SymphonyTab({ settings, onChange, fieldIds }: SymphonyTabProps) {
  return (
    <>
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
              placeholder="https://pod.symphony.com"
            />
            <p className="settings-hint">
              The URL of the Symphony pod to connect to.
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
              placeholder="Your partner ID"
            />
            <p className="settings-hint">
              Your Symphony partner ID for authentication.
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
              placeholder="https://bridge.symphony.com"
            />
            <p className="settings-hint">
              The URL of the Symphony bridge service.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
