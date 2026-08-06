import type { Settings } from "../../../lib/types";

export interface AppearanceTabProps {
  settings: Settings;
}

// `settings` is accepted (rather than taking no props) to match the other
// tabs' shape and because a future theme option will read it; today's
// Appearance section is hardcoded to the only supported theme.
export default function AppearanceTab(_props: AppearanceTabProps) {
  return (
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
  );
}
