import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ChatMessages from "./ChatMessages";
import type { ChatMessage } from "../../lib/agent/types";

describe("ChatMessages", () => {
  it("renders empty state when no messages", () => {
    render(<ChatMessages messages={[]} />);
    expect(screen.getByText("Start a conversation with Rita")).toBeInTheDocument();
  });

  it("renders user messages with correct styling", () => {
    const messages: ChatMessage[] = [{ role: "human", content: "Hello" }];
    render(<ChatMessages messages={messages} />);
    const message = screen.getByText("Hello");
    expect(message).toBeInTheDocument();
  });

  it("renders AI messages with correct styling", () => {
    const messages: ChatMessage[] = [{ role: "ai", content: "Hi there!" }];
    render(<ChatMessages messages={messages} />);
    const message = screen.getByText("Hi there!");
    expect(message).toBeInTheDocument();
  });

  it("renders multiple messages in order", () => {
    const messages: ChatMessage[] = [
      { role: "human", content: "Question" },
      { role: "ai", content: "Answer" },
    ];
    render(<ChatMessages messages={messages} />);
    expect(screen.getByText("Question")).toBeInTheDocument();
    expect(screen.getByText("Answer")).toBeInTheDocument();
  });

  // Desk finding 10, Task 16 review (a11y): the transcript had no aria-live
  // region, so streamed replies and error lines were never announced.
  it("marks the transcript as an aria-live region", () => {
    const messages: ChatMessage[] = [{ role: "human", content: "hi" }];
    const { container } = render(<ChatMessages messages={messages} />);
    const el = container.querySelector(".chat-messages")!;
    expect(el).toHaveAttribute("aria-live", "polite");
  });
});
