import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClockRenderer from "./ClockRenderer";

describe("ClockRenderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T15:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("lists every zone with its city, time, offset and zone label", () => {
    render(<ClockRenderer zones={["America/New_York", "Asia/Tokyo"]} />);

    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(screen.getByText("Tokyo")).toBeInTheDocument();
    // 15:30 UTC is 11:30 in New York (EDT) and 00:30 next day in Tokyo.
    const times = Array.from(document.querySelectorAll(".clock-time")).map((e) => e.textContent);
    expect(times).toEqual(["11:30", "00:30"]);
    expect(screen.getByText("GMT-4")).toBeInTheDocument();
    expect(screen.getByText("GMT+9")).toBeInTheDocument();
    expect(screen.getByText("US/Eastern")).toBeInTheDocument();
    expect(screen.getByText("Japan")).toBeInTheDocument();
  });

  it("drops the padded hour and the zero minutes from the offset", () => {
    // Intl yields "GMT-04:00"; the compact form is "GMT-4".
    render(<ClockRenderer zones={["America/New_York"]} />);
    expect(screen.getByText("GMT-4")).toBeInTheDocument();
    expect(screen.queryByText(/GMT-04:00/)).not.toBeInTheDocument();
  });

  it("keeps a two-digit hour, and the minutes on a half-hour zone", () => {
    // India is GMT+5:30 — trimming minutes unconditionally would show "GMT+5".
    render(<ClockRenderer zones={["Pacific/Honolulu", "Asia/Kolkata"]} />);
    expect(screen.getByText("GMT-10")).toBeInTheDocument();
    expect(screen.getByText("GMT+5:30")).toBeInTheDocument();
  });

  it("puts the city, meta block and time in one row, in that order", () => {
    // The layout the card depends on: city and time flanking a stacked
    // offset-over-zone column.
    const { container } = render(<ClockRenderer zones={["America/New_York"]} />);
    const row = container.querySelector(".clock-row")!;
    expect(row.children).toHaveLength(3);
    expect(row.children[0]).toHaveClass("clock-city");
    expect(row.children[1]).toHaveClass("clock-meta");
    expect(row.children[2]).toHaveClass("clock-time");
    // Offset above zone within the meta block.
    expect(row.children[1].children[0]).toHaveClass("clock-offset");
    expect(row.children[1].children[1]).toHaveClass("clock-zone");
  });

  it("defaults to 24-hour", () => {
    const { container } = render(<ClockRenderer zones={["America/New_York"]} />);
    expect(container.querySelector(".clock-time")!.textContent).toBe("11:30");
    expect(container.querySelector(".clock-meridiem")).toBeNull();
  });

  it("suffixes a bare A or P in 12-hour, not AM/PM", () => {
    // The two extra glyphs cost more width than the row can spare.
    const { container, unmount } = render(
      <ClockRenderer zones={["America/New_York"]} hour12 />
    );
    expect(container.querySelector(".clock-meridiem")!.textContent).toBe("A");
    expect(container.querySelector(".clock-time")!.textContent).toBe("11:30A");
    unmount();

    // 15:30 UTC is 00:30 in Tokyo — the next morning, so also A.
    const { container: c2 } = render(<ClockRenderer zones={["Asia/Shanghai"]} hour12 />);
    expect(c2.querySelector(".clock-meridiem")!.textContent).toBe("P");
  });

  it("keeps the colon in its own element so it can be tightened", () => {
    // The face is monospaced; without pulling the colon in it leaves a gap
    // wide enough on both sides to read as a word break.
    const { container } = render(<ClockRenderer zones={["UTC"]} />);
    expect(container.querySelector(".clock-colon")!.textContent).toBe(":");
  });

  it("switches typeface on request", () => {
    const { container, unmount } = render(<ClockRenderer zones={["UTC"]} />);
    expect(container.querySelector(".clock-time")).not.toHaveClass("solid");
    unmount();

    const { container: c2 } = render(<ClockRenderer zones={["UTC"]} face="solid" />);
    expect(c2.querySelector(".clock-time")).toHaveClass("solid");
  });

  it("uses the legacy alias where there is one, and the IANA name otherwise", () => {
    // Intl offers "Pacific Time" or "PDT", neither of which is the requested
    // "US/Pacific" form; that only exists as the legacy alias.
    render(<ClockRenderer zones={["America/Los_Angeles", "Europe/Malta"]} />);
    expect(screen.getByText("US/Pacific")).toBeInTheDocument();
    // Unlisted zones fall back to the IANA name, which is already the right shape.
    expect(screen.getByText("Europe/Malta")).toBeInTheDocument();
  });

  it("ticks", async () => {
    const { container } = render(<ClockRenderer zones={["UTC"]} />);
    const t = () => container.querySelector(".clock-time")!.textContent;
    expect(t()).toBe("15:30");
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(t()).toBe("15:31");
  });

  it("skips an unknown zone and names it, rather than throwing", () => {
    // The field is free text, so a typo is expected. A RangeError from
    // DateTimeFormat during render would escape the card's error boundary.
    expect(() =>
      render(<ClockRenderer zones={["America/New_York", "Mars/Olympus"]} />)
    ).not.toThrow();
    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(screen.getByText(/Unknown time zone: Mars\/Olympus/)).toBeInTheDocument();
  });

  it("says so when nothing is usable instead of rendering an empty card", () => {
    render(<ClockRenderer zones={["Mars/Olympus"]} />);
    expect(screen.getByText(/No valid time zones/)).toBeInTheDocument();
  });

  it("defaults to the vertical digital list", () => {
    const { container } = render(<ClockRenderer zones={["UTC"]} />);
    expect(container.querySelector(".clock-list")).toBeInTheDocument();
    expect(container.querySelector(".clock-gallery")).toBeNull();
  });

  it("horizontal layout renders one analog tile per zone instead of digital rows", () => {
    const { container } = render(
      <ClockRenderer zones={["America/New_York", "Asia/Tokyo"]} layout="horizontal" />
    );
    expect(container.querySelectorAll(".clock-tile")).toHaveLength(2);
    expect(container.querySelector(".clock-time")).toBeNull();
    expect(container.querySelector(".clock-list")).toBeNull();
    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(screen.getByText("US/Eastern")).toBeInTheDocument();
    expect(screen.getByText("GMT-4")).toBeInTheDocument();
  });

  it("horizontal layout labels each tile with the spoken time for screen readers", () => {
    // 15:30 UTC, per the fixed system time this suite sets in beforeEach.
    const { container } = render(<ClockRenderer zones={["UTC"]} layout="horizontal" />);
    expect(container.querySelector(".clock-tile")).toHaveAttribute(
      "aria-label",
      "UTC, 15:30, UTC, GMT+0"
    );
  });

  it("horizontal layout still reports an invalid zone", () => {
    const { container } = render(
      <ClockRenderer zones={["America/New_York", "Mars/Olympus"]} layout="horizontal" />
    );
    expect(container.querySelectorAll(".clock-tile")).toHaveLength(1);
    expect(container.querySelector(".clock-invalid")).toHaveTextContent(
      "Unknown time zone: Mars/Olympus"
    );
  });
});
