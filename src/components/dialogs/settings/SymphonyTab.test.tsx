import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SymphonyTab from "./SymphonyTab";
import { DEFAULT_SETTINGS } from "../../../lib/persistence";

const baseSettings = {
  ...DEFAULT_SETTINGS,
  symphonyPodUrl: "https://my-pod.symphony.com",
  symphonyPartnerId: "partner-9",
  symphonyBridgeUrl: "http://localhost:9100",
};

function renderTab(over: Partial<typeof baseSettings> = {}) {
  const onChange = vi.fn();
  render(
    <SymphonyTab settings={{ ...baseSettings, ...over }} onChange={onChange} fieldIds="t" />
  );
  return { onChange };
}

describe("SymphonyTab", () => {
  it("renders the three Symphony fields with their current values", () => {
    renderTab();
    expect(screen.getByLabelText("Pod URL")).toHaveValue("https://my-pod.symphony.com");
    expect(screen.getByLabelText("Partner ID")).toHaveValue("partner-9");
    expect(screen.getByLabelText("Bridge URL")).toHaveValue("http://localhost:9100");
  });

  it("reports a pod URL edit via onChange", () => {
    const { onChange } = renderTab();
    fireEvent.change(screen.getByLabelText("Pod URL"), {
      target: { value: "https://other-pod.symphony.com" },
    });
    expect(onChange).toHaveBeenCalledWith({ symphonyPodUrl: "https://other-pod.symphony.com" });
  });

  it("reports a partner ID edit via onChange", () => {
    const { onChange } = renderTab();
    fireEvent.change(screen.getByLabelText("Partner ID"), {
      target: { value: "partner-42" },
    });
    expect(onChange).toHaveBeenCalledWith({ symphonyPartnerId: "partner-42" });
  });

  it("reports a bridge URL edit via onChange", () => {
    const { onChange } = renderTab();
    fireEvent.change(screen.getByLabelText("Bridge URL"), {
      target: { value: "http://localhost:9200" },
    });
    expect(onChange).toHaveBeenCalledWith({ symphonyBridgeUrl: "http://localhost:9200" });
  });
});
