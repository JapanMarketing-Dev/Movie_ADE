// Feedback findings for the review mode (pure, unit-tested). `solocut feedback show <id> --json` returns `view`, the
// app shape of the items (FeedbackItem); anything else is dropped.
import type { FeedbackItem, FeedbackTarget } from '@shared/types';

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseFindings(data: unknown): FeedbackItem[] {
  const list = obj(data)?.view;
  if (!Array.isArray(list)) return [];
  const out: FeedbackItem[] = [];
  for (const x of list) {
    const o = obj(x);
    if (!o || typeof o.n !== 'number' || typeof o.frame !== 'number') continue;
    const targets: FeedbackTarget[] = Array.isArray(o.targets)
      ? o.targets.flatMap((t) => {
          const tt = obj(t);
          if (!tt || typeof tt.kind !== 'string' || typeof tt.id !== 'string') return [];
          return [{ kind: tt.kind, id: tt.id, ...(typeof tt.label === 'string' ? { label: tt.label } : {}) }];
        })
      : [];
    const item: FeedbackItem = {
      n: o.n,
      frame: o.frame,
      timecode: typeof o.timecode === 'string' ? o.timecode : '',
      spoken: typeof o.spoken === 'string' ? o.spoken : '',
      request: typeof o.request === 'string' ? o.request : '',
      notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string') : [],
      targets,
    };
    if (typeof o.image === 'string') item.image = o.image;
    if (typeof o.title === 'string' && o.title) item.title = o.title;
    out.push(item);
  }
  return out;
}

/** "00:00:05:12" → "00:05" for the image badge (drops hours when 0 and the frame part). */
export function shortTimecode(tc: string): string {
  const parts = tc.split(':');
  if (parts.length < 3) return tc;
  const [h, m, s] = parts.length === 4 ? parts : ['00', ...parts];
  return h === '00' ? `${m}:${s}` : `${h}:${m}:${s}`;
}

/** Absolute path for an item image stored project-relative (feedback/<id>/NN.png). */
export function itemImagePath(dir: string, image: string): string {
  return /^([A-Za-z]:)?[\\/]/.test(image) ? image : `${dir.replace(/[\\/]+$/, '')}/${image}`;
}

/** Title shown on a card: the organized title, else the first line of the request, else the speech. */
export function findingTitle(it: FeedbackItem): string {
  const firstLine = (s: string) => s.split(/\r?\n/)[0]!.trim();
  return it.title?.trim() || firstLine(it.request) || firstLine(it.spoken) || '';
}
