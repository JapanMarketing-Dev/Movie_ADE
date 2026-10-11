import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

/**
 * Keeps a render failure inside one region (ported from Ferret src/renderer/ui/ErrorBoundary.tsx). Without it a
 * throw anywhere unmounts the whole tree and the window goes black. Texts come in as props (no hooks in a class).
 */
export class ErrorBoundary extends Component<
  {
    name: string;
    children: ReactNode;
    text: { title: string; description: string; retry: string; reload: string };
    className?: string;
  },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] ${this.props.name} failed to render`, error, info.componentStack);
  }

  private readonly retry = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { text } = this.props;
    return (
      <div className={['error-boundary', this.props.className ?? ''].filter(Boolean).join(' ')} data-testid={`error-boundary-${this.props.name}`}>
        <EmptyState
          size="sm"
          title={text.title}
          description={
            <>
              <span>{text.description}</span>
              <code className="error-boundary__detail">{error.message}</code>
            </>
          }
          actions={
            <>
              <Button onClick={this.retry}>{text.retry}</Button>
              <Button variant="ghost" onClick={() => window.location.reload()}>
                {text.reload}
              </Button>
            </>
          }
        />
      </div>
    );
  }
}
