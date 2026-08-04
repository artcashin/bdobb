import { memo } from "react";
import ErrorBoundary from "../ErrorBoundary";
import type { ChatMessage } from "../../lib/agent/types";
import ArtifactView from "./ArtifactView";

interface ChatMessagesProps {
  messages: ChatMessage[];
}

function ChatMessagesComponent({ messages }: ChatMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="chat-messages-empty">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="chat-messages-empty-icon"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
          />
        </svg>
        <p>Start a conversation with Rita</p>
      </div>
    );
  }

  return (
    <ErrorBoundary label="Chat messages">
      <div className="chat-messages" role="log" aria-live="polite">
        {messages
          .filter(
            // Tool results and function-call echoes are protocol history, not
            // conversation; rendering them produces empty bubbles.
            (m) =>
              m.role === "human" ||
              (m.role === "ai" && (typeof m.content === "string" || Array.isArray(m.content)))
          )
          .map((message, index) => (
          <div
            key={index}
            className={`chat-message ${message.role === "human" ? "human" : "ai"}`}
          >
            <div
              className={`chat-message-content ${message.role === "human" ? "human" : "ai"}`}
            >
              {message.role === "ai" && Array.isArray(message.content) ? (
                <ArtifactView artifacts={message.content} />
              ) : message.role === "ai" && typeof message.content === "string" ? (
                <div className="chat-message-text">{message.content}</div>
              ) : message.role === "human" ? (
                <div className="chat-message-text">{message.content}</div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ErrorBoundary>
  );
}

const ChatMessages = memo(ChatMessagesComponent);
export default ChatMessages;
