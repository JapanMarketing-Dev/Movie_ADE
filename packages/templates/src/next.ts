import type { StepId } from './schema.js';
import type { Template } from './load.js';

// `solocut next`: from status.json and each step's pass condition, return exactly one next thing to do
// (docs/04 「solocut next の動き」, docs/13 autopilot).

/** A base step, or a per-variant step of docs/18: derive:<v>, check:<v>, final:<v>, and publish. */
export type PipelineStep = StepId | `derive:${string}` | `check:${string}` | `final:${string}` | 'publish';

export interface StepState {
  step: PipelineStep;
  state: 'todo' | 'running' | 'done' | 'needs-human' | 'skipped';
  note?: string;
  at?: string;
}

export interface NextStep {
  step: PipelineStep | 'done';
  state: 'ready' | 'needs-human' | 'done';
  why: string;
  do: string;
  commands: string[];
  /** Absolute path of the template prompt to follow in this step. */
  prompt?: string;
  /** Ids a human has to decide before this step passes. */
  blocking?: string[];
  /** While waiting for a human: a later step that can already be done. */
  meanwhile?: PipelineStep;
  /** The variant this step works on (docs/18). */
  variant?: string;
}

export interface NextContext {
  hasTakes: boolean;
  hasTranscript: boolean;
  /** Open review items (decisions, checks, feedback) — rough-cut passes only at 0. */
  openItems: number;
  /** Failed items in the last check — check passes only at 0. */
  lastCheckFailed: number;
  openItemRefs?: string[];
  /** docs/13: take the most likely answer instead of waiting (except low-confidence sync and stopBefore). */
  autopilot?: boolean;
  /** Steps where autopilot always stops (settings.autopilot.stopBefore). */
  stopBefore?: string[];
  lang?: 'ja' | 'en';
  /** Derived variants (docs/18): whether each exists, is stale against the main timeline, and its last check. */
  variants?: Record<string, { exists: boolean; stale: boolean; lastCheckFailed: number }>;
  /** Camera sources in the project: with fewer than 2 there is nothing to switch, so multicam passes. */
  cameras?: number;
}

/** Steps a step needs (only those present in the pipeline count). */
export const STEP_DEPS: Record<StepId, StepId[]> = {
  ingest: [],
  sync: ['ingest'],
  analyze: ['ingest', 'sync'],
  transcribe: ['ingest'],
  'rough-cut': ['transcribe', 'sync'],
  multicam: ['rough-cut', 'sync', 'analyze'],
  captions: ['transcribe'],
  sfx: ['rough-cut', 'captions'],
  layout: ['rough-cut', 'analyze'],
  masks: ['rough-cut', 'analyze'],
  preview: ['rough-cut', 'multicam', 'captions', 'sfx', 'layout', 'masks'],
  check: ['preview'],
  review: ['check'],
  final: ['review', 'check'],
  thumbnail: ['rough-cut'],
  metadata: ['rough-cut'],
};

type L = { ja: string; en: string };
const STEP_TEXT: Record<StepId, { do: L; commands: string[] }> = {
  ingest: {
    do: { ja: '収録したテイクを素材として登録し、一覧を確認する', en: 'Register the recorded takes as sources and check the list' },
    commands: ['solocut ingest --json', 'solocut takes --json'],
  },
  sync: {
    do: { ja: 'トラック間（カメラ・マイク・画面）の同期を取る', en: 'Sync the tracks (cameras, mic, screen)' },
    commands: ['solocut sync --json'],
  },
  analyze: {
    do: {
      ja: '素材を解析する（無音・音量・黒画面・静止）。顔・カーソル・個人情報の解析ファイルはアプリが derived/analysis/ に書く',
      en: 'Analyze the media (silence, loudness, black/frozen frames). The app writes face/cursor/PII analysis to derived/analysis/',
    },
    commands: ['solocut analyze --json'],
  },
  masks: {
    do: {
      ja: '画面に映った個人情報（メール・APIキーなど）にモザイクを入れ、残りは確認に回す',
      en: 'Mask private text on screen (emails, API keys…) and leave the masks for review',
    },
    commands: ['solocut masks from-analysis --json', 'solocut step masks done'],
  },
  transcribe: {
    do: { ja: 'マイクの音声を文字起こしする（単語単位の時刻つき）', en: 'Transcribe the mic track with word timestamps' },
    commands: ['solocut transcribe --json'],
  },
  'rough-cut': {
    do: {
      ja: 'カットの候補を作り、prompts/rough-cut.md に沿って残す・切るを決める。直しは solocut edit で、理由を --reason に書く。確認したら solocut step rough-cut done',
      en: 'Propose cuts, then decide keep/cut following prompts/rough-cut.md. Fix with solocut edit and give a --reason. When checked, run solocut step rough-cut done',
    },
    commands: ['solocut propose cuts --json', 'solocut tl summary --json', 'solocut edit <op> ... --reason "<why>"', 'solocut step rough-cut done'],
  },
  multicam: {
    do: { ja: 'prompts/multicam.md に沿って区間ごとのカメラを決める', en: 'Choose the camera per segment following prompts/multicam.md' },
    commands: [
      'solocut multicam material --json', 'solocut edit split-for-switch --segment <segment> --at <sourceFrame,…> --reason "<why>"',
      'solocut edit setCamera --id <segment> --camera <source> --reason "<why>"', 'solocut step multicam done',
    ],
  },
  captions: {
    do: { ja: '字幕を作り、prompts/captions.md に沿って直す', en: 'Build captions and polish them following prompts/captions.md' },
    commands: ['solocut captions build --json', 'solocut edit updateCaption --id <caption> --patch \'{"text":"…"}\''],
  },
  sfx: {
    do: { ja: 'prompts/sfx.md に沿って効果音・BGM を入れる', en: 'Add sound effects and BGM following prompts/sfx.md' },
    commands: ['solocut sfx apply --json', 'solocut edit addSfx --sfx \'{…}\' --reason "<why>"', 'solocut step sfx done'],
  },
  layout: {
    do: { ja: '区間ごとのレイアウト（ワイプ・全画面など）を決める', en: 'Set the layout of each segment (wipe, full screen…)' },
    commands: ['solocut tracks apply --json', 'solocut edit setVideo --id <segment> --video \'{"layout":"…"}\' --reason "<why>"', 'solocut step layout done'],
  },
  preview: {
    do: { ja: 'プレビューを書き出す', en: 'Render the preview' },
    commands: ['solocut render --preview --json'],
  },
  check: {
    do: { ja: '機械的チェックを実行し、不合格を直す', en: 'Run the machine checks and fix failures' },
    commands: ['solocut check --json'],
  },
  review: {
    do: { ja: '人の確認とフィードバックを待つ', en: 'Wait for the human review and feedback' },
    commands: ['solocut step review done'],
  },
  final: {
    do: { ja: '出力先ごとに本番の書き出しをする', en: 'Render the final output for each target' },
    commands: ['solocut render --final --json'],
  },
  thumbnail: {
    do: { ja: 'prompts/thumbnail.md に沿ってサムネイルの候補を作る', en: 'Make thumbnail candidates following prompts/thumbnail.md' },
    commands: ['solocut frame --at <frame> --json', 'solocut step thumbnail done'],
  },
  metadata: {
    do: { ja: 'タイトル・説明文・チャプターを renders/<target>/metadata.md に書く', en: 'Write title, description and chapters to renders/<target>/metadata.md' },
    commands: ['solocut tl summary --json', 'solocut step metadata done'],
  },
};

/** Variants a template derives (outputs with `derive`, enabled), in a stable order. */
export function derivedTargets(t: Pick<Template, 'outputs'>): string[] {
  const order = ['tiktok', 'youtube-shorts', 'instagram-reels', 'youtube'];
  return Object.entries(t.outputs ?? {})
    .filter(([, o]) => o && o.enabled !== false && o.derive)
    .map(([k]) => k)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** The template pipeline with per-variant steps: derive:v and check:v after check, final:v after final, then publish. */
export function expandPipeline(t: Pick<Template, 'pipeline' | 'outputs'>): PipelineStep[] {
  const vs = derivedTargets(t);
  if (!vs.length) return [...t.pipeline];
  const out: PipelineStep[] = [];
  const afterCheck = t.pipeline.includes('check') ? 'check' : t.pipeline.includes('preview') ? 'preview' : null;
  for (const s of t.pipeline) {
    out.push(s);
    if (s === afterCheck) for (const v of vs) out.push(`derive:${v}`, `check:${v}`);
    if (s === 'final') for (const v of vs) out.push(`final:${v}`);
  }
  if (!afterCheck) for (const v of vs) out.push(`derive:${v}`, `check:${v}`);
  if (!t.pipeline.includes('final')) for (const v of vs) out.push(`final:${v}`);
  out.push('publish');
  return out;
}

export function splitStep(step: string): { base: string; variant?: string } {
  const i = step.indexOf(':');
  return i < 0 ? { base: step } : { base: step.slice(0, i), variant: step.slice(i + 1) };
}

function depsOf(step: PipelineStep, pipeline: PipelineStep[]): PipelineStep[] {
  const { base, variant } = splitStep(step);
  if (variant) {
    if (base === 'derive') return ['check'];
    if (base === 'check') return [`derive:${variant}`];
    if (base === 'final') return [`check:${variant}`, 'review'];
  }
  if (step === 'publish') return pipeline.filter((p) => p === 'final' || p.startsWith('final:'));
  return STEP_DEPS[step as StepId] ?? [];
}

const VARIANT_TEXT: Record<'derive' | 'check' | 'final', { do: L; commands: (v: string) => string[] }> = {
  derive: {
    do: { ja: '本編から縦型の版を作る（見どころを選び、9:16 に組み替え、字幕を作り直す）。prompts/vertical.md に従う', en: 'Derive the vertical version from the main video (pick highlights, reframe to 9:16, rebuild captions) following prompts/vertical.md' },
    commands: (v) => [`solocut derive --target ${v} --json`, `solocut tl summary --variant ${v} --json`],
  },
  check: {
    do: { ja: '縦型の版のプレビューを書き出し、チェックして直す', en: 'Render the vertical preview, check it and fix failures' },
    commands: (v) => [`solocut render --preview --variant ${v} --json`, `solocut check --variant ${v} --json`],
  },
  final: {
    do: { ja: '縦型の版を本番の画質で書き出す', en: 'Render the vertical version at final quality' },
    commands: (v) => [`solocut render --final --variant ${v} --json`],
  },
};

export function stepText(step: PipelineStep, lang: 'ja' | 'en' = 'ja', variants: string[] = []): { do: string; commands: string[] } {
  const { base, variant } = splitStep(step);
  if (variant && (base === 'derive' || base === 'check' || base === 'final')) {
    const vt = VARIANT_TEXT[base];
    return { do: `${vt.do[lang]}（${variant}）`, commands: vt.commands(variant) };
  }
  if (step === 'publish') {
    return lang === 'ja'
      ? { do: '投稿は人が承認してから。アプリの「投稿」画面で3本の内容を確認・承認してもらう', commands: [] }
      : { do: 'Publishing needs a human: they review and approve all posts in the app\'s Publish screen', commands: [] };
  }
  const t = STEP_TEXT[step as StepId];
  const commands = [...t.commands];
  // thumbnails and post text are made for every video (docs/18)
  if (variants.length && step === 'thumbnail') commands.push(...variants.map((v) => `solocut thumb gen --variant ${v} --title "<${lang === 'ja' ? '見出し' : 'headline'}>" --json`));
  if (variants.length && step === 'metadata') commands.push(...variants.map((v) => `solocut meta set --variant ${v} --title "…" --description "…" --tags a,b --json`));
  return { do: t.do[lang], commands };
}

export function initialStatus(t: Pick<Template, 'pipeline' | 'outputs'>): StepState[] {
  return expandPipeline(t).map((step) => ({ step, state: 'todo' }));
}

export function nextStep(template: Template, status: StepState[], ctx: NextContext): NextStep {
  const lang = ctx.lang ?? 'ja';
  const ja = lang === 'ja';
  const pipeline = expandPipeline(template);
  const variants = derivedTargets(template);
  const stateOf = (s: PipelineStep) => status.find((x) => x.step === s)?.state ?? 'todo';
  /** multicam with one camera (or none) has nothing to decide. */
  const notNeeded = (s: PipelineStep) => s === 'multicam' && ctx.cameras !== undefined && ctx.cameras < 2;
  const isPassed = (s: PipelineStep) => !pipeline.includes(s) || notNeeded(s) || stateOf(s) === 'done' || stateOf(s) === 'skipped';

  const make = (step: PipelineStep, state: NextStep['state'], why: string, extra: Partial<NextStep> = {}): NextStep => {
    const txt = stepText(step, lang, variants);
    const out: NextStep = { step, state, why, do: txt.do, commands: txt.commands, ...extra };
    const { base, variant } = splitStep(step);
    if (variant) out.variant = variant;
    const prompt = template.promptFiles?.[base === 'derive' ? 'vertical' : step];
    if (prompt && !out.prompt) out.prompt = prompt;
    if (step === 'final' && !extra.commands) out.commands = template.targets.map((t) => `solocut render --final --target ${t} --json`);
    return out;
  };

  /** A later step whose dependencies are all passed (to do while a human decides). */
  const meanwhile = (blocked: PipelineStep): PipelineStep | undefined => {
    const i = pipeline.indexOf(blocked);
    return pipeline.slice(i + 1).find((s) => {
      const st = stateOf(s);
      return s !== 'publish' && (st === 'todo' || st === 'running') && depsOf(s, pipeline).every((d) => d !== blocked && isPassed(d));
    });
  };

  const waitFor = (step: PipelineStep, why: string, blocking?: string[]): NextStep => {
    const m = meanwhile(step);
    const base = ja ? '人の確認を待ってください。アプリの「確認」画面に表示されます。' : 'Wait for a human to decide; it is shown in the app\'s Review screen.';
    const extra: Partial<NextStep> = { do: base, commands: [] };
    if (m) {
      extra.meanwhile = m;
      extra.do = ja ? `${base}待つ間に ${m} の手順へ進めます` : `${base} Meanwhile you can do ${m}.`;
      extra.commands = stepText(m, lang, variants).commands;
    }
    if (blocking?.length) extra.blocking = blocking;
    return make(step, 'needs-human', why, extra);
  };

  for (const step of pipeline) {
    const st = stateOf(step);
    const note = status.find((x) => x.step === step)?.note;

    if (ctx.autopilot && ctx.stopBefore?.includes(step) && st !== 'done' && st !== 'skipped') {
      return waitFor(step, ja ? `設定で ${step} の前に必ず止まるようになっています` : `Settings stop autopilot before ${step}`);
    }

    // pass conditions are re-checked even for steps marked done
    if (step === 'ingest' && !ctx.hasTakes) {
      return make(step, 'needs-human', ja ? 'テイクも取り込んだ素材もありません' : 'There are no takes or imported media', {
        do: ja ? '撮影するか、`solocut import <ファイル>` で素材を取り込んでください' : 'Record a take or import media with `solocut import <file>`',
        commands: ['solocut import <file> --kind camera --role front'],
      });
    }
    if (step === 'transcribe' && (st === 'done' || st === 'skipped') && !ctx.hasTranscript) {
      return make(step, 'ready', ja ? '文字起こしのファイルがありません（derived/transcripts/main.json）' : 'The transcript file is missing (derived/transcripts/main.json)');
    }
    if (step === 'rough-cut' && st === 'done' && ctx.openItems > 0 && !ctx.autopilot) {
      return waitFor(step, ja ? `要確認の項目が ${ctx.openItems} 件あります` : `${ctx.openItems} open review item(s)`, ctx.openItemRefs);
    }
    if (step === 'check' && st === 'done' && ctx.lastCheckFailed > 0) {
      return make(step, 'ready', ja ? `前回のチェックで ${ctx.lastCheckFailed} 件が不合格でした` : `${ctx.lastCheckFailed} item(s) failed in the last check`, {
        do: ja ? 'checks/<run>/report.md を読んで直し、もう一度チェックする' : 'Read checks/<run>/report.md, fix the failures and check again',
        commands: ['solocut render --preview --json', 'solocut check --json'],
      });
    }
    {
      const { base, variant } = splitStep(step);
      const vs = variant ? ctx.variants?.[variant] : undefined;
      if (base === 'derive' && variant && st === 'done' && vs && (!vs.exists || vs.stale)) {
        return make(step, 'ready', vs.exists
          ? (ja ? `本編が変わりました。${variant} の版を作り直してください（人が直した部分は保たれます）` : `The main video changed; re-derive ${variant} (human edits are kept)`)
          : (ja ? `${variant} の版がありません` : `The ${variant} version is missing`));
      }
      if (base === 'check' && variant && st === 'done' && vs && vs.lastCheckFailed > 0) {
        return make(step, 'ready', ja ? `${variant} の前回のチェックで ${vs.lastCheckFailed} 件が不合格でした` : `${vs.lastCheckFailed} item(s) failed in the last ${variant} check`);
      }
      if (step === 'publish' && st !== 'done' && st !== 'skipped') {
        return waitFor(step, ja ? '3本の動画がそろいました。投稿は人の承認が必要です' : 'All videos are ready; publishing needs a human approval');
      }
    }
    if (st === 'done' || st === 'skipped' || notNeeded(step)) continue;

    if (st === 'needs-human') {
      // autopilot proceeds with the most likely answer, except sync (a wrong sync breaks everything) and review
      if (ctx.autopilot && step !== 'sync' && step !== 'review' && step !== 'publish') continue;
      const why = note ?? (ja ? 'この手順は人の判断を待っています' : 'This step is waiting for a human');
      return waitFor(step, why, step === 'rough-cut' ? ctx.openItemRefs : undefined);
    }
    if (st === 'running') {
      return make(step, 'ready', note ?? (ja ? 'この手順は途中です。続きから進めてください' : 'This step is in progress; continue it'));
    }

    // todo
    if (step === 'rough-cut' && !ctx.hasTranscript) {
      return make('transcribe', 'ready', ja ? 'カットの前に文字起こしが必要です' : 'A transcript is needed before cutting');
    }
    if (step === 'review') {
      if (ctx.autopilot) continue; // autopilot finishes first; the human reviews the finished video
      return waitFor(step, ja ? 'プレビューとチェックが済みました。人の確認とフィードバックを待ちます' : 'Preview and checks are done; waiting for the human review');
    }
    const why = note ?? (ja ? `テンプレート ${template.id} の次の手順です` : `Next step of template ${template.id}`);
    return make(step, 'ready', why);
  }

  return {
    step: 'done',
    state: 'done',
    why: ja ? 'テンプレートの手順がすべて終わりました' : 'All template steps are done',
    do: ja ? '.solocut/handoff.md に、やったこと・残っていること・次の一手を書いてください' : 'Write what you did, what remains and the next move to .solocut/handoff.md',
    commands: [],
  };
}
