import { useCallback, useMemo, useRef, useState } from 'react';

export function useToast(): { msg: string | null; show: (m: string) => void } {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 4000);
  }, []);
  return useMemo(() => ({ msg, show }), [msg, show]);
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div className="toast">{msg}</div> : null;
}
