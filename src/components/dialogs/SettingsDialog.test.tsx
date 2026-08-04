import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/logger", () => ({
  logError: vi.fn(),
  getLogPath: vi.fn(),
  readLogTail: vi.fn(),
}));

import SettingsDialog from "./SettingsDialog";
import { getLogPath, readLogTail } from "../../lib/logger";
import { useSettingsStore } from "../../stores/settingsStore";

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLogPath).mockResolvedValue("/logs/bdobb.log");
    vi.mocked(readLogTail).mockResolvedValue(["line one", "line two"]);
    useSettingsStore.setState({ settings: { theme: "dark" }, loadError: null });
  });

  it("renders nothing readable when closed and does not touch the log", () => {
    render(<SettingsDialog isOpen={false} onClose={() => {}} />);
    expect(readLogTail).not.toHaveBeenCalled();
  });

  it("shows the log path and tail when opened", async () => {
    render(<SettingsDialog isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("/logs/bdobb.log")).toBeInTheDocument());
    expect(screen.getByText(/line one/)).toBeInTheDocument();
  });

  it("surfaces a log read failure instead of pretending the log is empty", async () => {
    vi.mocked(readLogTail).mockRejectedValue(new Error("EACCES"));
    render(<SettingsDialog isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Failed to read log/)).toBeInTheDocument());
  });

  it("explains itself when settings failed to load from disk", async () => {
    useSettingsStore.setState({ loadError: "mkdir failed" });
    render(<SettingsDialog isOpen={true} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("mkdir failed")
    );
  });
});
