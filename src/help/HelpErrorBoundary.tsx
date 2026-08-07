import { Component, type ErrorInfo, type ReactNode } from "react";

interface HelpErrorBoundaryProps {
  children: ReactNode;
}

interface HelpErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches throws from anywhere in the Help window's render tree (loadPage,
 * loadAssetUrl, and the version-mismatch case in loadContent.ts all throw)
 * and shows a readable message instead of the blank white window an
 * uncaught render error otherwise produces. Error boundaries require
 * lifecycle methods React hooks don't support, hence the class component.
 */
export default class HelpErrorBoundary extends Component<
  HelpErrorBoundaryProps,
  HelpErrorBoundaryState
> {
  state: HelpErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): HelpErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Help window render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <div className="help-error">Help content unavailable — {this.state.error.message}</div>;
    }
    return this.props.children;
  }
}
