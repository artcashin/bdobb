import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError } from "../lib/logger";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of children when a descendant throws. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Prefix for the logged message, so the failing surface is identifiable. */
  label?: string;
  /**
   * Changing this value clears the error state. Pass something that varies
   * with the content being rendered so a card can recover on the next
   * successful fetch instead of staying broken until remount.
   */
  resetKey?: unknown;
  /**
   * Called (in addition to resetting the boundary's own error state) when
   * the user clicks the default fallback's Retry button -- lets the caller
   * also trigger a fresh data fetch, not just a re-render of the same bad
   * data (desk dc4664b). Only consulted by the default fallback; a custom
   * `fallback` gets `reset` directly and can wire retry however it likes.
   */
  onRetry?(): void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * The spec requires that each failure surface degrade without blocking the
 * others. Without a boundary, one throwing renderer unmounts the whole React
 * tree — the dashboard, the rail, and the chat pane all go with it.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(
      `${this.props.label ?? "ErrorBoundary"}: ${error.message}\n${info.componentStack ?? ""}`
    );
  }

  reset = () => this.setState({ error: null });

  private handleRetry = () => {
    this.reset();
    this.props.onRetry?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="error-box">
        <p>{this.props.label ? `${this.props.label} failed to render` : "Failed to render"}</p>
        <pre className="renderer-error-detail">{error.message}</pre>
        <button onClick={this.handleRetry}>Retry</button>
      </div>
    );
  }
}
