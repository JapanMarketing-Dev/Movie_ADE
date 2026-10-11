import type { ReactNode } from 'react';

/** A small outlined square holding one monochrome icon (ported from Ferret src/renderer/ui/IconTile.tsx). */
export function IconTile({ size = 'md', children }: { size?: 'sm' | 'md' | 'lg'; children: ReactNode }) {
  return (
    <span className={`icon-tile icon-tile--${size}`} aria-hidden="true">
      {children}
    </span>
  );
}
