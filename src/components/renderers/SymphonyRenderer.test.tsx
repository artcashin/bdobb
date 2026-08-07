import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
