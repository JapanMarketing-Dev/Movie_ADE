import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { IconButton } from './Button';

/**
 * Toasts (ported from Ferret src/renderer/ui/Toast.tsx). Results are reported without stopping the screen.
 * Solocut has no native browser view over the DOM, so the placement logic of Ferret is not needed: toasts stack at
 * the top right below the title bar. The host is a popover so it also shows above open <dialog>s.
 */
export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  tone?: ToastTone;
  /** one line */
  message: string;
  /** cause or next step */
  detail?: string;
  /** ms; 0 keeps it until closed */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<(o: ToastOptions) => void>(() => {});

export function useToast(): (o: ToastOptions) => void {
  return useContext(ToastContext);
}

const ICONS: Record<ToastTone, ReactNode> = {
  info: <Info size={16} />,
  success: <CircleCheck size={16} />,
  warning: <TriangleAlert size={16} />,
  danger: <CircleX size={16} />,
};

export function ToastProvider({ closeLabel, children }: { closeLabel: string; children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (o: ToastOptions) => {
      const id = ++seq.current;
      setItems((prev) => [...prev.slice(-3), { ...o, id }]);
      const duration = o.duration ?? (o.tone === 'danger' ? 7000 : 4200);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);

  // Re-show the popover each time so it sits above modal dialogs (the top layer).
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || items.length === 0 || typeof host.showPopover !== 'function') return;
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  }, [items]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div ref={hostRef} popover="manual" className="toast-host" role="status" aria-live="polite" data-testid="toast-host">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone ?? 'info'}`}>
            <span className="toast__icon">{ICONS[item.tone ?? 'info']}</span>
            <div className="toast__body">
              <span className="toast__message">{item.message}</span>
              {item.detail != null && <span className="toast__detail">{item.detail}</span>}
            </div>
            <IconButton label={closeLabel} size="sm" icon={<X size={14} />} onClick={() => dismiss(item.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
