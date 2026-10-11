// Video feedback (docs/04 「動画フィードバック」): the renderer records the mic and pen events while the user
// plays the preview; we store them in feedback/inbox/<id>/ and `solocut feedback import` turns them into
// feedback/<fb id>/{items.json, feedback.md, NN.png}.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliResult, FeedbackImport, FeedbackItem, FeedbackSession } from '../../shared/types';
import { applyItemEdits, feedbackMarkdown, parseFeedbackShow } from '../../shared/feedback';
import { formatFrames } from '../../shared/project';
import { runCli } from './cli';
import { readProject } from './project';
import { beginSession, endTake, newTakeId } from './recorder';

const INBOX_ID = /^fb_[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function beginFeedback(projectDir: string): { id: string; dir: string } {
  let id = newTakeId().replace(/^take_/, 'fb_');
  let dir = join(projectDir, 'feedback', 'inbox', id);
  for (let i = 2; existsSync(dir); i++) {
    id = `${newTakeId().replace(/^take_/, 'fb_')}-${i}`;
    dir = join(projectDir, 'feedback', 'inbox', id);
  }
  beginSession(id, dir);
  return { id, dir };
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function timecodeFor(projectDir: string, variant?: string): (f: number) => string {
  try {
    const tlPath = variant ? join(projectDir, 'variants', variant, 'timeline.json') : join(projectDir, 'timeline.json');
    const tl = JSON.parse(readFileSync(tlPath, 'utf8')) as { canvas?: { fps?: { num?: number; den?: number } } };
    const num = tl.canvas?.fps?.num ?? 30;
    const den = tl.canvas?.fps?.den ?? 1;
    return (f) => formatFrames(f, num, den);
  } catch {
    return (f) => formatFrames(f, 30, 1);
  }
}

const variantArgs = (v?: string) => (v ? ['--variant', v] : []);

export async function showFeedback(projectDir: string, id: string, variant?: string): Promise<CliResult<FeedbackImport>> {
  const r = await runCli(['feedback', 'show', id, ...variantArgs(variant)], { cwd: projectDir });
  const data = r.ok ? parseFeedbackShow(r.data, timecodeFor(projectDir, variant)) : null;
  return data ? { ...r, data } : { ...r, ok: false, data: undefined, error: r.error ?? 'feedback show returned nothing' };
}

export async function finishFeedback(projectDir: string, inboxId: string, session: FeedbackSession, variant?: string): Promise<CliResult<FeedbackImport>> {
  if (!INBOX_ID.test(inboxId)) throw new Error(`invalid feedback id: ${inboxId}`);
  const dir = join(projectDir, 'feedback', 'inbox', inboxId);
  endTake(inboxId);
  writeAtomic(join(dir, 'session.json'), JSON.stringify(session, null, 2) + '\n');
  const r = await runCli(['feedback', 'import', `feedback/inbox/${inboxId}`, '--id', inboxId, '--organize', 'auto', ...variantArgs(variant)], {
    cwd: projectDir,
    timeoutMs: 20 * 60_000,
  });
  if (!r.ok) return { ...r, data: undefined };
  const id = (r.data as { id?: unknown } | undefined)?.id;
  const shown = await showFeedback(projectDir, typeof id === 'string' ? id : inboxId, variant);
  // the CLI copied session.json and the voice into feedback/<id>/; the inbox folder is no longer needed
  if (shown.ok) await rm(dir, { recursive: true, force: true });
  return shown;
}

/**
 * Saves edited / deleted items. Prefers `solocut feedback set`; with a CLI that lacks it, rewrites items.json and a
 * plain feedback.md in place (images keep their original numbers).
 */
export async function updateFeedback(projectDir: string, id: string, items: FeedbackItem[], variant?: string): Promise<CliResult<FeedbackImport>> {
  if (!INBOX_ID.test(id)) throw new Error(`invalid feedback id: ${id}`);
  const fbDir = join(projectDir, 'feedback', id);
  const itemsPath = join(fbDir, 'items.json');
  const raw = JSON.parse(readFileSync(itemsPath, 'utf8')) as { items?: unknown[] } & Record<string, unknown>;
  const edited = applyItemEdits(Array.isArray(raw.items) ? raw.items : [], items);
  const file = join(tmpdir(), `solocut-feedback-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(edited));
  try {
    const r = await runCli(['feedback', 'set', id, '--items', file, ...variantArgs(variant)], { cwd: projectDir });
    if (r.ok) return showFeedback(projectDir, id, variant);
    const code = (r.data as { error?: { code?: string } } | undefined)?.error?.code;
    if (code !== 'usage') return { ...r, data: undefined };
  } finally {
    await rm(file, { force: true });
  }
  // fallback for CLIs without `feedback set`: keep image numbers (the PNGs are named by the original index)
  const kept = items.map((it, i) => ({ ...it, n: i + 1, image: it.image }));
  writeAtomic(itemsPath, JSON.stringify({ ...raw, items: edited }, null, 2));
  const lang = readProject(projectDir).language ?? 'ja';
  const md = feedbackMarkdown(id, kept, lang).replace(/\.\/(\d\d)\.png/g, (_m, nn: string) => {
    const it = kept[Number(nn) - 1];
    return it?.image ? `./${it.image.split('/').pop()}` : `./${nn}.png`;
  });
  writeAtomic(join(fbDir, 'feedback.md'), md);
  return { ok: true, code: 0, stdout: '', stderr: '', data: { id, dir: `feedback/${id}`, items: kept } };
}
