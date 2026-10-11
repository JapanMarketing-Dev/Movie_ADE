import type { ReactNode } from 'react';

/**
 * Badges (ported from Ferret src/renderer/ui/Badge.tsx).
 *   neutral … default
 *   brand   … selected / ours (accent red)
 *   success / warning / danger … results
 *   record  … recording
 */
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'record';

export function Badge({ tone = 'neutral', icon, children, className, title }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={['badge', `badge--${tone}`, className ?? ''].filter(Boolean).join(' ')} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** A small round count, e.g. on a tab. Hidden at 0. */
export function CountBadge({ count, tone = 'brand' }: { count: number; tone?: BadgeTone }) {
  if (count <= 0) return null;
  return <span className={`count-badge count-badge--${tone}`}>{count > 99 ? '99+' : count}</span>;
}
