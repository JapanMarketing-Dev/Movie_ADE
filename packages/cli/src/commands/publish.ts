import type { Output, Target } from '@solocut/core';
import { CliError, emit, opts, t, type Ctx } from '../ctx.js';
import { VARIANTS, applyEdit, openProject, readTimeline, setStep, variantExists, type Project, type Variant } from '../project.js';
import { allTimelines } from './media.js';
import { emptyOutput, TARGETS } from './meta.js';

// The app uploads; the CLI records the result on outputs[].publish (docs/14, docs/18).

const STATUSES = ['draft', 'scheduled', 'published', 'failed'] as const;

/** Done when every video's targets are published or scheduled. */
export function updatePublishStep(p: Project): { pending: string[] } {
  const pending: string[] = [];
  for (const x of allTimelines(p)) {
    const tl = readTimeline(x);
    for (const target of x.variant ? [x.variant] : tl.meta.targets) {
      const st = tl.outputs.find((o) => o.target === target)?.publish?.status;
      if (st !== 'published' && st !== 'scheduled') pending.push(target);
    }
  }
  setStep(p, 'publish', pending.length ? 'needs-human' : 'done', pending.length ? `pending: ${pending.join(', ')}` : undefined);
  return { pending };
}

export async function cmdPublish(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== 'record') throw new CliError('usage', 'usage: solocut publish record --target youtube|tiktok|youtube-shorts --status published|scheduled|failed|draft [--url <url>] [--at ISO] [--variant v]');
  const { values } = opts(rest, { target: { type: 'string' }, status: { type: 'string' }, url: { type: 'string' }, at: { type: 'string' } }, { max: 0 });
  const target = values.target as Target | undefined;
  if (!target || !(TARGETS as readonly string[]).includes(target)) throw new CliError('usage', `--target must be one of ${TARGETS.join(', ')}`);
  const status = values.status as (typeof STATUSES)[number] | undefined;
  if (!status || !(STATUSES as readonly string[]).includes(status)) throw new CliError('usage', `--status must be one of ${STATUSES.join(', ')}`);
  if ((status === 'published' || status === 'scheduled') && !values.url) throw new CliError('usage', '--url is required for published / scheduled');
  if (values.url && !/^https?:\/\/\S+$/.test(values.url)) throw new CliError('usage', `invalid --url: ${values.url}`);
  if (values.at && Number.isNaN(Date.parse(values.at))) throw new CliError('usage', `invalid --at (ISO time): ${values.at}`);
  const p0 = openProject(ctx);
  // without --variant, a TikTok / Shorts target is recorded on its derived variant when it exists
  const p: Project = p0.variant
    ? p0
    : { ...p0, variant: (VARIANTS as readonly string[]).includes(target) && variantExists(p0.dir, target as Variant) ? (target as Variant) : null };
  if (p.variant && p.variant !== target) throw new CliError('usage', `variant ${p.variant} only has the ${p.variant} output`);
  const tl = readTimeline(p);
  const base: Output = tl.outputs.find((o) => o.target === target) ?? emptyOutput(tl, target);
  const publish = { status, ...(values.url ? { url: values.url } : {}), at: values.at ?? new Date().toISOString() };
  await applyEdit(p, [{ op: 'setOutput', output: { ...base, publish } }], { by: 'human', note: `publish ${target}` });
  const { pending } = updatePublishStep(p);
  emit(ctx, { variant: p.variant ?? 'main', target, publish, pending }, () => [
    t(ctx, `${target} を ${status} として記録しました${values.url ? `: ${values.url}` : ''}`, `recorded ${target} as ${status}${values.url ? `: ${values.url}` : ''}`),
    ...(pending.length ? [t(ctx, `未投稿: ${pending.join(', ')}`, `not yet published: ${pending.join(', ')}`)] : []),
  ]);
}
