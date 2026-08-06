import { useEffect, useState, useId } from "react";
import Modal from "../Modal";
import { useBackendsStore } from "../../stores/backendsStore";
import { isHttpUrl } from "../../lib/safeUrl";
import { logError } from "../../lib/logger";
import { useRegistryStore } from "../../stores/registryStore";
import type { BackendConfig } from "../../lib/types";

export interface BackendsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function BackendsDialog({ isOpen, onClose }: BackendsDialogProps) {
  // Labels need ids to point at, and the dialog can be mounted more than once,
  // so the prefix comes from useId rather than a hardcoded string.
  const formIds = useId();
  const backends = useBackendsStore((s) => s.backends);
  const addBackend = useBackendsStore((s) => s.addBackend);
  const removeBackend = useBackendsStore((s) => s.removeBackend);
  const updateBackend = useBackendsStore((s) => s.updateBackend);
  const status = useRegistryStore((s) => s.status);
  const discovering = useRegistryStore((s) => s.loading);

  /**
   * Discovery previously ran only at startup, so a backend added here never
   * contributed widgets until the app was restarted. The spec asks for launch
   * *and* manual refresh.
   */
  const rediscover = () =>
    useRegistryStore
      .getState()
      .refresh(useBackendsStore.getState().backends)
      .catch(() => {});

  // formOpen drives visibility; editingBackend only distinguishes edit from
  // add. Gating the form on editingBackend alone made "Add Backend"
  // unreachable, since adding sets it to null.
  const [formOpen, setFormOpen] = useState(false);
  const [editingBackend, setEditingBackend] = useState<BackendConfig | null>(null);
  const [form, setForm] = useState<Partial<BackendConfig>>({});
  // addBackend/updateBackend/removeBackend set state optimistically and then
  // await the disk write with no rollback (backendsStore.ts) -- a rejected
  // save previously vanished into an unhandled promise from these
  // fire-and-forget handlers with no UI feedback at all.
  const [error, setError] = useState<string | null>(null);

  // Reset only when the dialog closes. Resetting while it is open wiped the
  // draft that handleAdd had just populated.
  useEffect(() => {
    if (!isOpen) {
      setFormOpen(false);
      setEditingBackend(null);
      setForm({});
      setError(null);
    }
  }, [isOpen]);

  const headerNameTrimmed = (form.headerName ?? "").trim();
  const headerValueTrimmed = form.headerValue ?? "";
  // A value with no name is silently discarded on Save; a name with no value
  // is stored as `headerValue: ""`, which dataClient.ts's authHeaders() then
  // silently omits from every request. Both are surfaced instead of failing
  // quietly.
  const headerValueWithoutName = headerValueTrimmed !== "" && headerNameTrimmed === "";
  const headerNameWithoutValue = headerNameTrimmed !== "" && headerValueTrimmed === "";

  const handleAdd = () => {
    setEditingBackend(null);
    setFormOpen(true);
    setForm({
      id: `backend-${Date.now()}`,
      name: "",
      baseUrl: "",
    });
  };

  const handleEdit = (backend: BackendConfig) => {
    setEditingBackend(backend);
    setFormOpen(true);
    setForm({ ...backend });
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this backend?")) return;
    setError(null);
    try {
      await removeBackend(id);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logError(`BackendsDialog: delete failed: ${reason}`);
      setError(`Failed to save: ${reason}`);
      return;
    }
    rediscover();
  };

  const handleSave = async () => {
    if (!form.name?.trim()) {
      alert("Backend name is required");
      return;
    }

    if (!form.baseUrl?.trim() || !isHttpUrl(form.baseUrl)) {
      alert("Please enter a valid URL");
      return;
    }

    setError(null);
    try {
      if (editingBackend) {
        await updateBackend(editingBackend.id, {
          name: form.name,
          baseUrl: form.baseUrl,
          headerName: form.headerName,
          headerValue: form.headerValue,
        });
      } else {
        await addBackend({
          id: form.id || `backend-${Date.now()}`,
          name: form.name,
          baseUrl: form.baseUrl,
          headerName: form.headerName,
          headerValue: form.headerValue,
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logError(`BackendsDialog: save failed: ${reason}`);
      setError(`Failed to save: ${reason}`);
      return;
    }

    setEditingBackend(null);
    setFormOpen(false);
    setForm({});
    rediscover();
  };

  const handleCancel = () => {
    setEditingBackend(null);
    setFormOpen(false);
    setForm({});
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Backends"
      footer={
        <>
          {formOpen && (
            <>
              <button
                onClick={handleCancel}
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
                Save
              </button>
            </>
          )}
        </>
      }
    >
      <div>
        <div className="backends-header">
          <h3 className="backends-title">Configured Backends</h3>
          <button onClick={rediscover} className="backends-add-btn" disabled={discovering}>
            {discovering ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={handleAdd}
            className="backends-add-btn"
          >
            Add Backend
          </button>
        </div>

        <div className="backends-list">
          {backends.map((backend) => (
            <div
              key={backend.id}
              className="backend-item"
            >
              <div className="backend-item-info">
                <div className="backend-item-name">
                  {backend.name}
                  {backend.headerName && (
                    <span className="backend-item-auth-badge">Auth</span>
                  )}
                  <span
                    className={`backend-status ${status[backend.id] ?? "unknown"}`}
                    title={
                      status[backend.id] === "online" ? "Widgets discovered"
                      : status[backend.id] === "offline" ? "Discovery failed"
                      : "Not yet contacted"
                    }
                  >
                    {status[backend.id] ?? "unknown"}
                  </span>
                </div>
                <div className="backend-item-url">{backend.baseUrl}</div>
                {backend.headerName && (
                  <div className="backend-item-url">Header: {backend.headerName}</div>
                )}
              </div>
              <div className="backend-item-actions">
                <button
                  onClick={() => handleEdit(backend)}
                  className="backend-btn edit"
                  title="Edit"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(backend.id)}
                  className="backend-btn delete"
                  title="Delete"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}

          {backends.length === 0 && (
            <div className="backend-empty">
              <p>No backends configured</p>
              <p className="hint">Click "Add Backend" to get started</p>
            </div>
          )}
        </div>

        {formOpen && (
          <div className="backend-form-section">
            <h4 className="backend-form-title">
              {editingBackend ? "Edit Backend" : "Add Backend"}
            </h4>
            <div>
              <div className="backend-form-field">
                <label className="backend-form-label" htmlFor={`${formIds}-name`}>
                  Name
                </label>
                <input
                  id={`${formIds}-name`}
                  type="text"
                  value={form.name || ""}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="backend-form-input"
                  placeholder="Backend name"
                />
              </div>
              <div className="backend-form-field">
                <label className="backend-form-label" htmlFor={`${formIds}-baseUrl`}>
                  Base URL
                </label>
                <input
                  id={`${formIds}-baseUrl`}
                  type="text"
                  value={form.baseUrl || ""}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  className="backend-form-input"
                  placeholder="https://api.example.com"
                />
                {form.baseUrl?.trim() && !isHttpUrl(form.baseUrl) && (
                  <span className="backend-form-warn" role="status">
                    Not a valid URL.
                  </span>
                )}
              </div>
              <div className="backend-form-field">
                <label className="backend-form-label" htmlFor={`${formIds}-headerName`}>
                  Header Name (optional)
                </label>
                <input
                  id={`${formIds}-headerName`}
                  type="text"
                  value={form.headerName || ""}
                  onChange={(e) => setForm({ ...form, headerName: e.target.value })}
                  className="backend-form-input"
                  placeholder="Authorization"
                />
                {headerNameWithoutValue && (
                  <span className="backend-form-warn" role="status">
                    A header name was entered without a value — the header
                    will be silently omitted from every request.
                  </span>
                )}
              </div>
              <div className="backend-form-field">
                <label className="backend-form-label" htmlFor={`${formIds}-headerValue`}>
                  Header Value (optional)
                </label>
                <input
                  id={`${formIds}-headerValue`}
                  type="password"
                  autoComplete="off"
                  value={form.headerValue || ""}
                  onChange={(e) => setForm({ ...form, headerValue: e.target.value })}
                  className="backend-form-input"
                  placeholder="Bearer token..."
                />
                {headerValueWithoutName && (
                  <span className="backend-form-warn" role="status">
                    A header value was entered without a header name — it
                    will be discarded.
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="error-box" role="status">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
