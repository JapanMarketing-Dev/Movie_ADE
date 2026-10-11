// Thumbnails (docs/10): the agent makes them (Codex / Gemini CLI inside the user's subscription) and saves them under
// <project>/thumbnails/. The app only lists them; picking one writes publish.json (publish/publish.ts).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ThumbFile } from '../../shared/publish';

export const THUMBS_DIR = 'thumbnails';

/** Images under thumbnails/ (one level of subfolders), newest first. */
export function listThumbnails(dir: string): ThumbFile[] {
  const out: ThumbFile[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < 1) walk(r, depth + 1);
      } else if (/\.(png|jpe?g)$/i.test(e.name)) {
        try {
          out.push({ path: join(dir, r), rel: r, mtimeMs: statSync(join(dir, r)).mtimeMs });
        } catch {
          /* removed meanwhile */
        }
      }
    }
  };
  walk(THUMBS_DIR, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
}
