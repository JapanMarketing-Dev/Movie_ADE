import { useRef, useState, type ReactNode } from 'react';

/**
 * Tooltip (ported from Ferret src/renderer/ui/Tooltip.tsx). Opens after a short delay; `side` picks the direction
 * (title bar → bottom, status bar → top).
 */
export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  align = 'center',
  children,
}: {
  label: string;
  /** shortcut text from formatShortcut() */
  shortcut?: string;
  side?: 'top' | 'bottom';
  /** keep tooltips near a window edge inside the window */
  align?: 'center' | 'start' | 'end';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, 320);
  };
  const hide = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setOpen(false);
  };

  return (
    <span className="tooltip-anchor" onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide} onFocusCapture={show} onBlurCapture={hide}>
      {children}
      <span className={`tooltip tooltip--${side} tooltip--${align}${open ? ' is-open' : ''}`} role="tooltip">
        {label}
        {shortcut != null && <kbd className="tooltip__key">{shortcut}</kbd>}
      </span>
    </span>
  );
}
