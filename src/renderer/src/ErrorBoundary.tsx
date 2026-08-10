import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * A workspace holding several live agent sessions should not vanish because one
 * pane threw. Without this, an uncaught error anywhere in the tree — including
 * in an unmount cleanup — leaves a blank window and takes every attached
 * terminal with it.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[rippon] unhandled error:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash-screen">
        <h1>Rippon hit an error</h1>
        <p className="modal-note">
          Your tmux sessions are untouched and still running on the host — reloading reattaches to
          them.
        </p>
        <pre>{error.stack ?? String(error)}</pre>
        <div className="modal-actions">
          <button className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
