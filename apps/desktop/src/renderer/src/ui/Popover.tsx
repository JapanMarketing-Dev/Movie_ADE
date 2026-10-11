import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Anchored popover rendered into <body> (ported from Ferret src/renderer/components/StatusPopover.tsx).
 * `above` opens over the status bar, `below` under the title bar. Escape or a click outside closes it.
 */
export function Popover({
  anchor,
  label,
  onClose,
  className,
  placement = 'above',
  align = 'start',
  children,
}: {
  anchor: HTMLElement | null;
  label: string;
  onClose: () => void;
  /** extra class, e.g. sb-pop--wide */
  className?: string;
  placement?: 'above' | 'below';
  /** start: left edges line up; end: right edges line up */
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom?: number; top?: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      if (!anchor || !ref.current) return;
      const a = anchor.getBoundingClientRect();
      const w = ref.current.offsetWidth;
      const want = align === 'end' ? a.right - w : a.left;
      const left = Math.max(8, Math.min(want, window.innerWidth - w - 8));
      if (placement === 'below') return setPos({ left, top: a.bottom + 6 });
      const barTop = anchor.closest('.statusbar')?.getBoundingClientRect().top ?? a.top;
      setPos({ left, bottom: window.innerHeight - barTop + 6 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, placement, align]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        anchor?.focus();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`sb-pop${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label={label}
      style={pos ? { left: pos.left, bottom: pos.bottom, top: pos.top } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
