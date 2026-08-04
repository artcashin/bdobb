import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import BackendsDialog from "./BackendsDialog";
import * as backendsStore from "../../stores/backendsStore";
import * as registryStore from "../../stores/registryStore";

vi.mock("../Modal", () => ({
  default: ({ isOpen, onClose, title, children, footer }: any) =>
    isOpen ? (
      <div data-testid="mock-modal">
        <h2>{title}</h2>
        <div>{children}</div>
        {footer && <div data-testid="mock-footer">{footer}</div>}
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

vi.mock("../../lib/logger", () => ({ logError: vi.fn() }));

vi.mock("../../stores/backendsStore", () => {
  const addBackend = vi.fn();
  const removeBackend = vi.fn();
  const updateBackend = vi.fn();
  const state = {
    backends: [{ id: "backend-1", name: "Backend 1", baseUrl: "http://localhost:8001" }],
    addBackend,
    removeBackend,
    updateBackend,
    setBackends: vi.fn(),
    load: vi.fn(),
  };
  // A zustand store is callable AND carries getState. Mocking only the callable
  // half made rediscover() reject with "getState is not a function" — outside
  // any assertion, so every test still passed while vitest counted two
  // unhandled rejections and CI failed the run.
  const useBackendsStore = Object.assign(
    vi.fn((selector) => selector(state)),
    { getState: () => state }
  );
  return { useBackendsStore, __esModule: true };
});

vi.mock("../../stores/registryStore", () => {
  const refresh = vi.fn(async () => {});
  const state = { status: { "backend-1": "offline" }, loading: false, widgets: [], refresh };
  const useRegistryStore = Object.assign(
    vi.fn((selector) => selector(state)),
    { getState: () => state }
  );
  return { useRegistryStore, __esModule: true };
});

describe("BackendsDialog", () => {
  let addBackend: any;
  let removeBackend: any;
  let updateBackend: any;
  let refresh: any;

  beforeEach(() => {
    addBackend = vi.fn().mockResolvedValue(undefined);
    removeBackend = vi.fn().mockResolvedValue(undefined);
    updateBackend = vi.fn().mockResolvedValue(undefined);
    refresh = vi.fn().mockResolvedValue(undefined);

    vi.mocked(backendsStore.useBackendsStore).mockImplementation((selector) =>
      selector({
        backends: [
          { id: "backend-1", name: "Backend 1", baseUrl: "http://localhost:8001" },
        ],
        addBackend,
        removeBackend,
        updateBackend,
        setBackends: vi.fn(),
        load: vi.fn(),
      })
    );
    (backendsStore.useBackendsStore as any).getState = () => ({
      backends: [{ id: "backend-1", name: "Backend 1", baseUrl: "http://localhost:8001" }],
    });

    vi.mocked(registryStore.useRegistryStore).mockImplementation((selector) =>
      selector({
        status: { "backend-1": "offline" },
        loading: false,
        widgets: [],
        refresh,
        setWidgets: vi.fn(),
        addWidget: vi.fn(),
        removeWidget: vi.fn(),
        clearWidgets: vi.fn(),
        find: vi.fn(),
        loadFromBackend: vi.fn(async () => {}),
      })
    );
    (registryStore.useRegistryStore as any).getState = () => ({ refresh });

    vi.stubGlobal("confirm", () => true);
  });

  it("renders dialog when open", () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    expect(screen.getByText("Backends")).toBeInTheDocument();
    expect(screen.getByText("Backend 1")).toBeInTheDocument();
  });

  it("shows each backend's connection status", () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("renders empty state when no backends", async () => {
    vi.mocked(backendsStore.useBackendsStore).mockImplementation((selector) =>
      selector({
        backends: [],
        addBackend,
        removeBackend,
        updateBackend,
        setBackends: vi.fn(),
        load: vi.fn(),
      })
    );

    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    expect(screen.getByText(/No backends configured/i)).toBeInTheDocument();
  });

  it("shows form when editing a backend", async () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    const editButtons = screen.getAllByTitle("Edit");
    fireEvent.click(editButtons[0]);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Backend 1")).toBeInTheDocument();
    });
  });

  it("validates URL format on save", async () => {
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    const editButtons = screen.getAllByTitle("Edit");
    fireEvent.click(editButtons[0]);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Backend 1")).toBeInTheDocument();
    });

    const urlInput = screen.getByDisplayValue("http://localhost:8001");
    fireEvent.change(urlInput, { target: { value: "invalid-url" } });

    const saveButton = screen.getByText("Save");
    fireEvent.click(saveButton);

    expect(alertMock).toHaveBeenCalledWith("Please enter a valid URL");
    alertMock.mockRestore();
  });

  it("rejects a non-http(s) scheme as an invalid URL instead of accepting it", async () => {
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add Backend"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByText("Save"));
    expect(alertMock).toHaveBeenCalledWith("Please enter a valid URL");
    alertMock.mockRestore();
  });

  it("calls removeBackend when delete button clicked", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockImplementation(() => true);
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    const deleteButton = screen.getAllByTitle("Delete")[0];
    fireEvent.click(deleteButton);

    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() => expect(removeBackend).toHaveBeenCalledWith("backend-1"));
    confirmMock.mockRestore();
  });

  it("calls updateBackend when editing backend", async () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    const editButtons = screen.getAllByTitle("Edit");
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Backend 1")).toBeInTheDocument();
    });

    const nameInput = screen.getByDisplayValue("Backend 1");
    fireEvent.change(nameInput, { target: { value: "Updated" } });

    const saveButton = screen.getByText("Save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateBackend).toHaveBeenCalledWith("backend-1", expect.any(Object));
    });
  });

  // --- desk dialogs.test.tsx cases, ported and adapted to qwen's
  // add/edit-form architecture (desk has no separate edit form). ---

  it("masks the auth header value input and never renders it in plain text", () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add Backend"));
    const headerValueInput = screen.getByLabelText(/Header Value/i);
    expect(headerValueInput).toHaveAttribute("type", "password");
  });

  it("never renders an existing backend's secret headerValue as plain text anywhere in the list", () => {
    vi.mocked(backendsStore.useBackendsStore).mockImplementation((selector) =>
      selector({
        backends: [
          {
            id: "backend-1",
            name: "Backend 1",
            baseUrl: "http://localhost:8001",
            headerName: "Authorization",
            headerValue: "super-secret-token-xyz",
          },
        ],
        addBackend,
        removeBackend,
        updateBackend,
        setBackends: vi.fn(),
        load: vi.fn(),
      })
    );
    const { container } = render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    expect(screen.queryByText("super-secret-token-xyz")).not.toBeInTheDocument();
    // Belt and suspenders: catches the secret leaking split across nodes or
    // inside an attribute-adjacent text node that queryByText would miss.
    expect(container.textContent).not.toContain("super-secret-token-xyz");
    // The masked marker is still there, so the header IS configured -- this
    // isn't a test that just weakened the assertion into a false pass.
    expect(screen.getByText("Auth")).toBeInTheDocument();
  });

  it("warns instead of silently dropping when a header value is entered without a header name", () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add Backend"));
    fireEvent.change(screen.getByLabelText(/Header Value/i), {
      target: { value: "some-secret" },
    });
    expect(screen.getByText(/header value.*without a header name/i)).toBeInTheDocument();
  });

  it("warns instead of silently dropping when a header name is entered without a value", () => {
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add Backend"));
    fireEvent.change(screen.getByLabelText(/Header Name/i), {
      target: { value: "Authorization" },
    });
    expect(screen.getByText(/header name.*without a value/i)).toBeInTheDocument();
  });

  it("surfaces a save failure instead of swallowing it", async () => {
    addBackend.mockRejectedValueOnce(new Error("disk full"));
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Add Backend"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test" } });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://localhost:9000" },
    });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/Failed to save.*disk full/i)).toBeInTheDocument());
  });

  it("surfaces a delete failure instead of swallowing it", async () => {
    removeBackend.mockRejectedValueOnce(new Error("disk full"));
    render(<BackendsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getAllByTitle("Delete")[0]);
    await waitFor(() => expect(screen.getByText(/Failed to save.*disk full/i)).toBeInTheDocument());
  });
});
