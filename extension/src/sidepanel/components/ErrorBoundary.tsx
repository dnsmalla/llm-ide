import React, { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  error: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[LLM IDE] Unhandled error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <h2>Something went wrong</h2>
          <p className="error-boundary-message">{this.state.error}</p>
          <button
            type="button"
            className="btn btn-start"
            onClick={() => this.setState({ hasError: false, error: '' })}
            aria-label="Try again"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
