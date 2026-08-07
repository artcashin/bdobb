import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mockOpenUrl }));

// The Rust framing preflight. Defaults to "allowed" so tests that don't care
// about it render exactly as before.
const mockInvoke = vi.hoisted(() =>
  vi.fn(async () => ({ frameable: true, reason: "" }))
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

const mockLogError = vi.hoisted(() => vi.fn());
vi.mock("../../lib/logger", () => ({ logError: mockLogError }));

import SymphonyRenderer from "./SymphonyRenderer";

/**
 * jsdom has no IntersectionObserver. This stub captures the callback per
 * instance so tests can fire it manually, and records observe/disconnect
 * calls so the "only when visible" behaviour is verifiable rather than
 * assumed.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

const baseParams = {
  pod: "my-pod.symphony.com",
  id: "stream-123",
  partnerId: "",
  mode: "focus",
  theme: "dark",
};

describe("SymphonyRenderer", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    mockInvoke.mockClear();
    mockInvoke.mockImplementation(async () => ({ frameable: true, reason: "" }));
    mockOpenUrl.mockClear();
    mockLogError.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not create the iframe before the card becomes visible", () => {
    render(<SymphonyRenderer params={baseParams} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it("creates the iframe once the observer reports intersection", () => {
    render(<SymphonyRenderer params={baseParams} />);
    const observer = FakeIntersectionObserver.instances[0];
    act(() => observer.fire(true));
    expect(screen.getByTitle("Symphony")).toBeInTheDocument();
  });

  it("stops observing once visible, and does not unmount the iframe again on a later non-intersecting report", () => {
    render(<SymphonyRenderer params={baseParams} />);
    const observer = FakeIntersectionObserver.instances[0];
    act(() => observer.fire(true));
    expect(observer.disconnected).toBe(true);
    expect(screen.getByTitle("Symphony")).toBeInTheDocument();

    act(() => observer.fire(false));
    expect(screen.getByTitle("Symphony")).toBeInTheDocument();
  });

  it("builds the embed URL from all five params, in the documented order", () => {
    render(
      <SymphonyRenderer
        params={{
          pod: "my-pod.symphony.com",
          id: "stream-123",
          partnerId: "partner-9",
          mode: "focus",
          theme: "dark",
        }}
      />
    );
    act(() => FakeIntersectionObserver.instances[0].fire(true));
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      "https://my-pod.symphony.com/embed/index.html?streamId=stream-123&partnerId=partner-9&mode=focus&theme=dark&condensed=true"
    );
  });

  it("sends partnerId as an empty string verbatim, rather than inventing a source for it", () => {
    render(<SymphonyRenderer params={baseParams} />);
    act(() => FakeIntersectionObserver.instances[0].fire(true));
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      "https://my-pod.symphony.com/embed/index.html?streamId=stream-123&partnerId=&mode=focus&theme=dark&condensed=true"
    );
  });

  it("keeps mode and theme as separate query params, never collapsed or hardcoded", () => {
    render(
      <SymphonyRenderer
        params={{ ...baseParams, mode: "split", theme: "light" }}
      />
    );
    act(() => FakeIntersectionObserver.instances[0].fire(true));
    const src = screen.getByTitle("Symphony").getAttribute("src") ?? "";
    expect(src).toContain("mode=split");
    expect(src).toContain("theme=light");
    expect(src).not.toContain("mode=dark");
  });

  it("applies the Symphony sandbox policy, including allow-same-origin", () => {
    render(<SymphonyRenderer params={baseParams} />);
    act(() => FakeIntersectionObserver.instances[0].fire(true));
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups"
    );
  });

  it("shows a hint instead of a broken iframe when pod or id is unset", () => {
    render(<SymphonyRenderer params={{ ...baseParams, pod: "" }} />);
    expect(screen.getByText(/Set a pod and stream ID/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("still gates on visibility once a previously-unconfigured card gets a pod and id", () => {
    // The container div (and its ref) does not exist while the hint is
    // showing. A naive "no ref yet => no observer support" fallback would
    // treat that as reason to skip straight to visible=true, so once the
    // card became configured the iframe would appear immediately instead of
    // waiting for intersection.
    const { rerender } = render(
      <SymphonyRenderer params={{ ...baseParams, pod: "" }} />
    );
    expect(document.querySelector("iframe")).toBeNull();

    rerender(<SymphonyRenderer params={baseParams} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);

    act(() => FakeIntersectionObserver.instances[0].fire(true));
    expect(screen.getByTitle("Symphony")).toBeInTheDocument();
  });

  describe("framing preflight", () => {
    it("checks the exact embed URL once the card becomes visible", async () => {
      render(<SymphonyRenderer params={baseParams} />);
      expect(mockInvoke).not.toHaveBeenCalled();

      act(() => FakeIntersectionObserver.instances[0].fire(true));
      expect(mockInvoke).toHaveBeenCalledWith("check_frame_options", {
        url: "https://my-pod.symphony.com/embed/index.html?streamId=stream-123&partnerId=&mode=focus&theme=dark&condensed=true",
      });
    });

    it("replaces the frame with an explanation when the pod refuses framing", async () => {
      mockInvoke.mockImplementation(async () => ({
        frameable: false,
        reason: "X-Frame-Options: DENY",
      }));
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));

      expect(await screen.findByText(/refuses to be embedded/i)).toBeInTheDocument();
      expect(screen.getByText("X-Frame-Options: DENY")).toBeInTheDocument();
      expect(screen.queryByTitle("Symphony")).not.toBeInTheDocument();
    });

    it("offers an external escape hatch to the exact embed URL when refused", async () => {
      mockInvoke.mockImplementation(async () => ({
        frameable: false,
        reason: "X-Frame-Options: DENY",
      }));
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));

      await screen.findByText(/refuses to be embedded/i);
      screen.getByRole("button", { name: /Open externally/ }).click();
      expect(mockOpenUrl).toHaveBeenCalledWith(
        "https://my-pod.symphony.com/embed/index.html?streamId=stream-123&partnerId=&mode=focus&theme=dark&condensed=true"
      );
    });

    it("keeps the iframe when the preflight itself fails, since that is not evidence of refusal", async () => {
      mockInvoke.mockImplementation(async () => {
        throw new Error("network unreachable");
      });
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));

      // Let the rejected promise settle.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTitle("Symphony")).toBeInTheDocument();
      expect(screen.queryByText(/refuses to be embedded/i)).not.toBeInTheDocument();
    });

    it("logs the preflight failure instead of swallowing it silently", async () => {
      mockInvoke.mockImplementation(async () => {
        throw new Error("network unreachable");
      });
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("check_frame_options failed for")
      );
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("network unreachable")
      );
    });

    it("does not re-check on a later non-intersecting report", async () => {
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      act(() => FakeIntersectionObserver.instances[0].fire(false));
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it("shows no footer once the preflight positively confirms the pod is frameable", async () => {
      // The default mock resolves { frameable: true }. A healthy pod's card
      // is a fixed-layout chat client where the bottom strip is the primary
      // interaction target (the compose box), so once framing is confirmed
      // the footer must not sit over it.
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByTitle("Symphony")).toBeInTheDocument();
      expect(screen.queryByText(/may refuse to be embedded/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Open externally/ })
      ).not.toBeInTheDocument();
    });

    it("keeps the escape hatch usable when the preflight cannot determine an answer", async () => {
      // `refusal` and `frameable` both stay at their not-yet-confirmed
      // defaults when the check errors (blocked HEAD, VPN-gated pod,
      // unreachable server) — there is no cross-origin signal to distinguish
      // that from "confirmed frameable" other than the preflight's own
      // answer, so the footer must stay present until that answer is positive.
      mockInvoke.mockImplementation(async () => {
        throw new Error("timed out");
      });
      render(<SymphonyRenderer params={baseParams} />);
      act(() => FakeIntersectionObserver.instances[0].fire(true));
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByTitle("Symphony")).toBeInTheDocument();
      expect(screen.getByText(/may refuse to be embedded/i)).toBeInTheDocument();
      screen.getByRole("button", { name: /Open externally/ }).click();
      expect(mockOpenUrl).toHaveBeenCalledWith(
        "https://my-pod.symphony.com/embed/index.html?streamId=stream-123&partnerId=&mode=focus&theme=dark&condensed=true"
      );
    });
  });
});
