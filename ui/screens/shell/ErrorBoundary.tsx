import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Section label for the message. */
  name: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
  attempt: number;
}

/** First line of an error message, bounded: it is rendered as text, never as markup. */
export function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw.split("\n", 1)[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Contains a crash in one section so the rest of the app (nav, status bar, other sections) keeps working. */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[shell] ${this.props.name} crashed:`, error, info.componentStack);
  }

  private reset = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="sh-panel" role="alert">
          <h2 className="sh-panel-title">{this.props.name} stopped working</h2>
          <p className="sh-panel-text">{describeError(this.state.error)}</p>
          <p className="sh-panel-text sh-muted">The rest of the app is unaffected. Reloading this section discards its unsaved view state.</p>
          <button type="button" className="sh-button" onClick={this.reset}>
            Reload {this.props.name}
          </button>
        </div>
      );
    }
    // `attempt` in the key remounts the subtree after a reset.
    return <div key={this.state.attempt} className="sh-fill">{this.props.children}</div>;
  }
}
