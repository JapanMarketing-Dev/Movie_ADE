// Publish screen data (docs/14): publish.json (parsed, with issues), the files it points at, the hand-off request
// and result, and the upload log. Picking a thumbnail writes publish.json (unknown fields are kept).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PUBLISH_FILE, PUBLISH_TARGETS, alreadyPublished, parsePublishJson, safeRelPath, withThumbnail, type PublishView } from '../../shared/publish';
import { readLog, readRequest, readResult, readText, writeJsonAtomic } from './handoff';

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function loadView(dir: string, now = new Date()): PublishView {
  const text = readText(join(dir, PUBLISH_FILE));
  const { spec, issues } = text === null ? { spec: null, issues: [] } : parsePublishJson(text, now);
  const view: PublishView = { exists: text !== null, spec, issues, request: readRequest(dir), result: readResult(dir), log: readLog(dir), published: {} };
  if (spec) {
    const v = resolve(dir, spec.video);
    if (isFile(v)) {
      view.videoPath = v;
      const size = statSync(v).size;
      for (const t of PUBLISH_TARGETS) {
        const e = alreadyPublished(view.log, t, spec.video, size);
        if (e) view.published[t] = e;
      }
    } else issues.push({ level: 'error', field: 'video', code: 'missing', detail: spec.video });
    if (spec.thumbnail) {
      const t = resolve(dir, spec.thumbnail);
      if (isFile(t)) view.thumbnailPath = t;
      else issues.push({ level: 'warning', field: 'thumbnail', code: 'missing', detail: spec.thumbnail });
    }
  }
  return view;
}

/** Project-relative path of a file inside the project ('/' separated), or null. */
export function projectRel(dir: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(dir, path);
  return safeRelPath(relative(resolve(dir), abs));
}

/** Sets (or with null clears) publish.json's thumbnail. Creates publish.json when there is none yet. */
export function setThumbnail(dir: string, path: string | null): { ok: boolean; error?: string } {
  let rel: string | null = null;
  if (path) {
    rel = projectRel(dir, path);
    if (!rel) return { ok: false, error: 'the image must be inside the project' };
    if (!/\.(png|jpe?g)$/i.test(rel)) return { ok: false, error: 'use a PNG or JPEG' };
    if (!existsSync(resolve(dir, rel))) return { ok: false, error: `not found: ${rel}` };
  }
  const file = join(dir, PUBLISH_FILE);
  let original: unknown = {};
  if (existsSync(file)) {
    try {
      original = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return { ok: false, error: 'publish.json is not valid JSON; ask the agent to fix it first' };
    }
  }
  writeJsonAtomic(file, withThumbnail(original, rel));
  return { ok: true };
}
