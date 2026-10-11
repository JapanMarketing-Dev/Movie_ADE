import type { ReactNode } from 'react';

/**
 * Empty state (ported from Ferret src/renderer/ui/EmptyState.tsx). An empty screen is a guide to the next step,
 * so the title names what you can do now. Short text and buttons only.
 */
export function EmptyState({
  title,
  description,
  actions,
  hints,
  size = 'md',
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  hints?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={['empty-state', `empty-state--${size}`, className ?? ''].filter(Boolean).join(' ')}>
      <div className="empty-state__inner">
        <h2 className="empty-state__title">{title}</h2>
        {description != null && <p className="empty-state__description">{description}</p>}
        {actions != null && <div className="empty-state__actions">{actions}</div>}
        {hints != null && <div className="empty-state__hints">{hints}</div>}
      </div>
    </div>
  );
}

/** A key cap, e.g. <Kbd>⌘K</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
