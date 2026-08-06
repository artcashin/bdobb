import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import LogsTab from "./LogsTab";
import { readLogTail } from "../../../lib/logger";

vi.mock("../../../lib/logger", () => ({
  logError: vi.fn(),
  getLogPath: vi.fn(async () => "/Users/test/Library/logs/bdobb.log"),
  readLogTail: vi.fn(async () => ["2026-08-04T00:00:00Z [INFO] sample line"]),
}));

describe("LogsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readLogTail).mockResolvedValue(["2026-08-04T00:00:00Z [INFO] sample line"]);
  });

  // Renamed from "shows the log path and tail when opened": that name
  // described the pre-split dialog, which loaded the log when the whole
  // dialog opened. Now the log loads when this tab mounts, not on any
  // "open" event.
  it("shows the log path and tail on mount", async () => {
    render(<LogsTab />);
    await waitFor(() => expect(screen.getByText(/sample line/)).toBeInTheDocument());
    expect(screen.getByText("/Users/test/Library/logs/bdobb.log")).toBeInTheDocument();
  });

  it("surfaces a log-read failure instead of swallowing it", async () => {
    vi.mocked(readLogTail).mockRejectedValueOnce(new Error("no such file or directory"));
    render(<LogsTab />);
    await waitFor(() =>
      expect(screen.getByText(/Failed to read log.*no such file/i)).toBeInTheDocument()
    );
  });

  it("reloads the log on demand", async () => {
    render(<LogsTab />);
    await waitFor(() => expect(readLogTail).toHaveBeenCalledTimes(1));
    vi.mocked(readLogTail).mockResolvedValueOnce(["a fresh line"]);
    fireEvent.click(screen.getByText("Reload log"));
    await waitFor(() => expect(screen.getByText(/a fresh line/)).toBeInTheDocument());
  });
});
