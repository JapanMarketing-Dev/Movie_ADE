import { useEffect, useRef, useState } from 'react';
import { dragRect, type Rect } from '@shared/region';
import { useT } from '../i18n';
import { api } from '../lib/api';

/** Drags shorter than this (DIP) are clicks, not selections. */
const MIN_DRAG = 8;

/**
 * Transparent full-display overlay for picking the recording region (main/services/regionPicker.ts): drag a
 * rectangle; the outside is dimmed and the size is shown in display pixels. Mouse-up or Enter confirms, Esc cancels.
 */
export function RegionPicker() {
  const t = useT();
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const done = useRef(false);

  const finish = (r: Rect | null) => {
    if (done.current) return;
    done.current = true;
    void api.invoke('record:regionDone', r);
  };

  useEffect(() => {
    // the shared stylesheet paints the app background; this window must stay see-through
    for (const el of [document.documentElement, document.body, document.getElementById('root')]) if (el) el.style.background = 'transparent';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && rect && rect.width >= MIN_DRAG && rect.height >= MIN_DRAG) finish(rect);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect]);

  const limit = () => ({ width: window.innerWidth, height: window.innerHeight });
  const dpr = window.devicePixelRatio || 1;

  return (
    <div
      className="region-picker"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        setStart({ x: e.clientX, y: e.clientY });
        setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      }}
      onMouseMove={(e) => {
        if (start) setRect(dragRect(start, { x: e.clientX, y: e.clientY }, limit()));
      }}
      onMouseUp={(e) => {
        if (!start) return;
        const r = dragRect(start, { x: e.clientX, y: e.clientY }, limit());
        setStart(null);
        if (r.width >= MIN_DRAG && r.height >= MIN_DRAG) finish(r);
        else setRect(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        finish(null);
      }}
    >
      {rect && rect.width > 0 && rect.height > 0 ? (
        <div className="region-picker__sel" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
          <span className="region-picker__size">
            {Math.round(rect.width * dpr)} × {Math.round(rect.height * dpr)}
          </span>
        </div>
      ) : (
        <div className="region-picker__dim" />
      )}
      {!start && <div className="region-picker__hint">{t('rec.regionHint')}</div>}
    </div>
  );
}
