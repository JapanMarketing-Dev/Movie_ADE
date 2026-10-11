// Video feedback (docs/04 「動画フィードバック」): the renderer records the mic and pen events while the user
// plays the preview; we store them in feedback/inbox/<id>/ and let `solocut feedback import` split them into items.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { CliResult, FeedbackImport, FeedbackItem } from '../../shared/types';
import { parseFeedbackImport } from '../../shared/feedback';
import { runCli } from './cli';
import { beginSession, endTake, newTakeId } from './recorder';

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

export async function finishFeedback(projectDir: string, id: string, session: unknown): Promise<CliResult<FeedbackImport>> {
  const dir = join(projectDir, 'feedback', 'inbox', id);
  endTake(id);
  const p = join(dir, 'session.json');
  writeFileSync(`${p}.tmp`, JSON.stringify(session, null, 2) + '\n');
  renameSync(`${p}.tmp`, p);
  const r = await runCli(['feedback', 'import', `feedback/inbox/${id}`], { cwd: projectDir, timeoutMs: 15 * 60_000 });
  const data = r.ok ? parseFeedbackImport(r.data) : undefined;
  return data ? { ...r, data } : { ...r, ok: false, data: undefined, error: r.error ?? 'feedback import returned no items' };
}

/** Saves edited / deleted items; the CLI rewrites feedback/<id>/feedback.md from them. */
export async function updateFeedback(projectDir: string, id: string, items: FeedbackItem[]): Promise<CliResult<FeedbackImport>> {
  const file = join(tmpdir(), `solocut-feedback-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(items));
  try {
    const r = await runCli(['feedback', 'update', id, '--items', file], { cwd: projectDir });
    const data = r.ok ? parseFeedbackImport(r.data) : undefined;
    return data ? { ...r, data } : r as CliResult<FeedbackImport>;
  } finally {
    await rm(file, { force: true });
  }
}

export function readFeedbackMd(projectDir: string, id: string): string | null {
  const p = join(projectDir, 'feedback', id, 'feedback.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
