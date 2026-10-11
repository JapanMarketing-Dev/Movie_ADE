// Cursor position log for a take (engine uses it for cursor-following zoom): 30 Hz samples of
// screen.getCursorScreenPoint(), normalized to the captured display (or to the recording region when the take
// is cropped to one, so the coordinates match the recorded frame), appended to media/takes/<id>/cursor.jsonl
// as {t_ms, x, y}. t_ms is on the take clock (ms since the take started, same epoch as take.json).
// TODO: clicks and key presses need a global input hook (uiohook / CGEventTap); not recorded yet.
import { screen } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { displayIdOf, normalizeCursor, type Bounds } from '../../shared/analysis';
import { fitRegion, parseRegion, regionScreenBounds, type Region } from '../../shared/region';

export interface CursorInfo {
  file: string;
  hz: number;
  displayId: string | null;
  bounds: Bounds;
  scaleFactor: number;
  window: boolean; // captured a window: coordinates are relative to its display, not the window
  region?: Region; // recorded region (display pixels): x/y are normalized to it
}

const HZ = 30;
const sessions = new Map<string, { timer: NodeJS.Timeout; flush: NodeJS.Timeout; buf: string[]; path: string }>();

export function startCursorLog(takeId: string, takeDir: string, sourceId: string | null, epochStartMs: number, regionIn?: unknown): CursorInfo {
  stopCursorLog(takeId);
  const id = displayIdOf(sourceId);
  const display = (id && screen.getAllDisplays().find((d) => String(d.id) === id)) || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const info = { id: String(display.id), bounds: display.bounds, scaleFactor: display.scaleFactor };
  const parsed = parseRegion(regionIn);
  const region = id && parsed ? fitRegion(parsed, info) : null;
  const b = region ? regionScreenBounds(region, info) : display.bounds;
  const bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  const path = join(takeDir, 'cursor.jsonl');
  writeFileSync(path, '');
  const s = { buf: [] as string[], path, timer: null as unknown as NodeJS.Timeout, flush: null as unknown as NodeJS.Timeout };
  let last = '';
  s.timer = setInterval(() => {
    const t = Math.round(performance.timeOrigin + performance.now() - epochStartMs);
    const p = normalizeCursor(screen.getCursorScreenPoint(), bounds);
    const key = `${p.x},${p.y}`;
    // keep the file small while the cursor rests, but write a sample at least once per second
    if (key === last && t % 1000 >= 1000 / HZ) return;
    last = key;
    s.buf.push(JSON.stringify({ t_ms: t, x: p.x, y: p.y }));
  }, 1000 / HZ);
  s.flush = setInterval(() => flush(s), 1000);
  sessions.set(takeId, s);
  return { file: 'cursor.jsonl', hz: HZ, displayId: id ?? String(display.id), bounds, scaleFactor: display.scaleFactor, window: !id, ...(region ? { region } : {}) };
}

function flush(s: { buf: string[]; path: string }): void {
  if (s.buf.length === 0) return;
  const lines = s.buf.splice(0).join('\n') + '\n';
  try {
    appendFileSync(s.path, lines);
  } catch {
    /* disk full / removed: drop */
  }
}

export function stopCursorLog(takeId: string): void {
  const s = sessions.get(takeId);
  if (!s) return;
  clearInterval(s.timer);
  clearInterval(s.flush);
  flush(s);
  sessions.delete(takeId);
}

export function stopAllCursorLogs(): void {
  for (const id of [...sessions.keys()]) stopCursorLog(id);
}
