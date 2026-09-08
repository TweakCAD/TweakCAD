/**
 * ErrorBoundary — contain render-time exceptions to a fallback panel
 * instead of unmounting the whole React tree.
 *
 * React error boundaries must be class components — function components
 * can't implement `componentDidCatch` / `getDerivedStateFromError`. We
 * wrap with this at two levels in the app:
 *
 *   1. **App-level**, around `<Shell>` in App.tsx — last-resort safety
 *      net so any uncaught render exception shows a recovery panel
 *      instead of a blank page. Without this, a single bad feature
 *      (e.g. a sketch with malformed entities built by an AI agent)
 *      takes the entire editor down.
 *
 *   2. **Component-level**, around individual `<SketchViewer>` mounts —
 *      so a corrupt sketch can't kill the surrounding extrude/revolve
 *      dialog. The fallback in that scope is small (a one-line warning
 *      inside the dialog rather than a full-screen panel).
 *
 * The fallback rendering can be overridden per-mount via the `fallback`
 * prop. The default is a centered card with the error message and a
 * Retry / Reload pair of buttons.
 *
 * `resetKey` lets callers force a reset by changing a sentinel — e.g.
 * after the user closes and reopens the dialog whose contents crashed,
 * pass a new resetKey so the boundary tries again from clean state.
 */

import { Component, type ErrorInfo, type ReactNode, type CSSProperties } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback renderer. Receives the caught error and a reset
   * function (clears the error state and re-renders children). Use
   * this for compact in-dialog fallbacks where the default full panel
   * would be jarring.
   */
  fallback?: ((error: Error, reset: () => void) => ReactNode) | undefined;
  /**
   * Called with the error + React error info when an error is caught.
   * Useful for routing to telemetry. Always also logged to console.
   */
  onError?: ((error: Error, info: ErrorInfo) => void) | undefined;
  /**
   * When this value changes between renders, the boundary auto-resets
   * (clears the captured error). Lets parents force a fresh attempt
   * without unmounting the boundary itself.
   */
  resetKey?: unknown;
  /**
   * Human-readable label for the boundary scope. Shown in the default
   * fallback ("Something went wrong rendering the sketch viewer.").
   * Defaults to "this component" when unset.
   */
  scopeLabel?: string | undefined;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log — the only signal a dev gets when a boundary catches.
     
    console.error(
      `[ErrorBoundary${this.props.scopeLabel ? `:${this.props.scopeLabel}` : ''}]`,
      error,
      info,
    );
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset when the parent signals a fresh attempt is wanted.
    if (this.state.error !== null && this.props.resetKey !== prevProps.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <DefaultFallback
          error={this.state.error}
          reset={this.reset}
          scopeLabel={this.props.scopeLabel}
        />
      );
    }
    return this.props.children;
  }
}

// ---- Default fallback panel ------------------------------------------------

function DefaultFallback(props: {
  error: Error;
  reset: () => void;
  scopeLabel?: string | undefined;
}): ReactNode {
  const scope = props.scopeLabel ?? 'this component';
  return (
    <div style={styles.root}>
      <div style={styles.card}>
        <div style={styles.title}>Something went wrong rendering {scope}.</div>
        <div style={styles.subtitle}>
          The rest of the app is still running. You can retry, or reload the
          page if the problem persists.
        </div>
        <pre style={styles.errorBox}>{formatError(props.error)}</pre>
        <div style={styles.actions}>
          <button style={styles.button} onClick={props.reset}>
            Retry
          </button>
          <button
            style={{ ...styles.button, ...styles.buttonPrimary }}
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}

function formatError(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  // Trim the stack to ~10 frames — full stacks are noisy and the top
  // frames are usually what matters.
  const stack = (error.stack ?? '').split('\n').slice(0, 11).join('\n');
  return stack.startsWith(head) ? stack : `${head}\n${stack}`;
}

// ---- Styles ----------------------------------------------------------------

const styles: Record<string, CSSProperties> = {
  root: {
    width: '100%',
    height: '100%',
    minHeight: 240,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5f5',
    color: '#333',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    padding: 24,
    boxSizing: 'border-box',
  },
  card: {
    maxWidth: 640,
    width: '100%',
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    padding: 24,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 13,
    color: '#666',
    marginBottom: 16,
    lineHeight: 1.5,
  },
  errorBox: {
    background: '#fafafa',
    border: '1px solid #ececec',
    borderRadius: 4,
    padding: 12,
    fontSize: 12,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    overflow: 'auto',
    maxHeight: 200,
    whiteSpace: 'pre-wrap',
    color: '#444',
    margin: 0,
  },
  actions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  button: {
    padding: '8px 14px',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    background: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
  buttonPrimary: {
    background: '#1a73e8',
    border: '1px solid #1a73e8',
    color: '#fff',
  },
};
