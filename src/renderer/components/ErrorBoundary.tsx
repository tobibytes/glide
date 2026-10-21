import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** rendered instead of the children after a render error */
  fallback?: (error: Error) => ReactNode;
  onError?: (error: Error) => void;
}

/** Keeps one broken feature view/window from taking down the launcher. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Glide view crashed:", error, info.componentStack);
    this.props.onError?.(error);
  }

  render() {
    const { error } = this.state;
    if (error) return this.props.fallback ? this.props.fallback(error) : <div className="launcher__empty">Something went wrong: {error.message}</div>;
    return this.props.children;
  }
}
