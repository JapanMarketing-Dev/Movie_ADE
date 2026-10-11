import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_MD, STEP_IDS, TemplateError, builtinTemplatesDir, deepMerge, generateAgentsMd, initialStatus, listTemplates,
  listTemplatesWithErrors, loadTemplate, nextStep, toRational, type NextContext, type StepId, type StepState, type Template,
} from '../src/index.js';

let home: string;
const saved = { home: process.env.SOLOCUT_HOME, tpl: process.env.SOLOCUT_TEMPLATES_DIR };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solocut-tpl-'));
  process.env.SOLOCUT_HOME = home;
  delete process.env.SOLOCUT_TEMPLATES_DIR;
});
afterEach(() => {
  for (const [k, v] of [['SOLOCUT_HOME', saved.home], ['SOLOCUT_TEMPLATES_DIR', saved.tpl]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeTemplate(root: string, id: string, yaml: string, files: Record<string, string> = {}) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'template.yaml'), yaml);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}

describe('built-in templates', () => {
  const BUILTIN = ['shorts-from-long', 'talk-tiktok', 'talk-youtube', 'tech-short', 'tech-tutorial'];

  it('resolves the repo /templates dir', () => {
    expect(builtinTemplatesDir().endsWith('/templates')).toBe(true);
  });

  it('lists all five without errors and hides the abstract bases', () => {
    const r = listTemplatesWithErrors();
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.templates.map((t) => t.id).sort()).toEqual(BUILTIN);
    const all = listTemplatesWithErrors({ includeAbstract: true }).templates.map((t) => t.id);
    expect(all).toContain('base-horizontal');
    expect(all).toContain('base-vertical');
  });

  it.each(BUILTIN)('%s is complete', (id) => {
    const t = loadTemplate(id);
    expect(t.abstract).toBe(false);
    for (const p of ['rough-cut', 'multicam', 'captions', 'sfx', 'thumbnail']) {
      expect(t.prompts[p], `${id} prompts/${p}.md`).toBeTruthy();
      expect(t.prompts[p]!.length).toBeGreaterThan(200);
    }
    expect(t.rules.length).toBeGreaterThan(200);
    expect(t.pipeline[0]).toBe('ingest');
    expect(t.pipeline).toContain('final');
    expect(t.name.ja && t.name.en).toBeTruthy();
    expect(t.canvas.fps).toEqual({ num: 30, den: 1 });
  });

  it('vertical templates inherit 9:16 and horizontal ones 16:9', () => {
    for (const id of ['tech-short', 'talk-tiktok', 'shorts-from-long']) {
      const t = loadTemplate(id);
      expect([t.canvas.width, t.canvas.height]).toEqual([1080, 1920]);
      expect(t.chain.at(-1)).toBe('base-vertical');
    }
    for (const id of ['tech-tutorial', 'talk-youtube']) {
      const t = loadTemplate(id);
      expect([t.canvas.width, t.canvas.height]).toEqual([1920, 1080]);
      expect(t.chain).toEqual([id, 'base-horizontal']);
    }
  });

  it('merges extends: child overrides keys, keeps the rest; arrays replace', () => {
    const t = loadTemplate('talk-youtube');
    expect(t.cut.silence).toEqual({ minMs: 400, padMs: 100, noiseDb: -35 }); // noiseDb from base
    expect(t.cut.fillers).toContain('えっと'); // from base
    expect(t.layouts.allowed).toEqual(['camera-full', 'scene']); // replaced
    expect(t.rules.indexOf('共通の方針')).toBeLessThan(t.rules.indexOf('語り動画（YouTube）の編集方針')); // base first
  });

  it('tech templates enable the tech features', () => {
    const t = loadTemplate('tech-tutorial');
    expect(t.kind).toBe('tech');
    expect(t.features).toMatchObject({ autoZoom: true, keystrokes: true, cursorHighlight: true, piiMask: true });
    expect(t.checks).toContain('pii-on-screen');
  });
});

describe('loader errors and overrides', () => {
  it('rejects unknown and malformed ids', () => {
    expect(() => loadTemplate('nope-nothing')).toThrow(/not found/);
    expect(() => loadTemplate('../etc')).toThrow(/invalid template id/);
  });

  it('reports schema errors with paths', () => {
    process.env.SOLOCUT_TEMPLATES_DIR = join(home, 'tpl');
    writeTemplate(join(home, 'tpl'), 'bad', 'id: bad\nversion: 1\nname: { ja: x, en: x }\nkind: video\n');
    try {
      loadTemplate('bad');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      const paths = (e as TemplateError).issues.map((i) => i.path);
      expect(paths).toContain('kind');
      expect(paths).toContain('pipeline');
    }
    expect(listTemplatesWithErrors().errors).toHaveLength(1);
    expect(listTemplates()).toEqual([]);
  });

  it('rejects invalid YAML, non-mapping YAML and id/folder mismatch', () => {
    process.env.SOLOCUT_TEMPLATES_DIR = join(home, 'tpl');
    writeTemplate(join(home, 'tpl'), 'a', 'id: [unclosed');
    writeTemplate(join(home, 'tpl'), 'b', '- 1\n- 2\n');
    writeTemplate(join(home, 'tpl'), 'c', 'id: other\nextends: talk-youtube\n');
    expect(() => loadTemplate('a')).toThrow(/cannot read/);
    expect(() => loadTemplate('b')).toThrow(/mapping/);
    expect(() => loadTemplate('c')).toThrow(/extends unknown|must match/);
  });

  it('detects extends cycles and unknown parents', () => {
    const root = join(home, 'templates');
    writeTemplate(root, 'x', 'id: x\nextends: y\n');
    writeTemplate(root, 'y', 'id: y\nextends: x\n');
    writeTemplate(root, 'z', 'id: z\nextends: does-not-exist\n');
    expect(() => loadTemplate('x')).toThrow(/cycle/);
    expect(() => loadTemplate('z')).toThrow(/unknown template "does-not-exist"/);
  });

  it('a user template extends a built-in and overrides prompts', () => {
    const root = join(home, 'templates');
    const dir = writeTemplate(root, 'my-talk', 'id: my-talk\nversion: 2\nextends: talk-youtube\nname: { ja: 自分用, en: Mine }\ncaptions: { maxCharsPerLine: 18 }\n', {
      'rules.md': '自分のルール',
      'prompts/captions.md': '自分の字幕ルール',
    });
    const t = loadTemplate('my-talk');
    expect(t.dir).toBe(dir);
    expect(t.version).toBe('2');
    expect(t.captions.maxCharsPerLine).toBe(18);
    expect(t.captions.maxLines).toBe(2);
    expect(t.prompts.captions).toBe('自分の字幕ルール');
    expect(t.promptFiles.captions).toBe(join(dir, 'prompts', 'captions.md'));
    expect(t.prompts['rough-cut']).toContain('粗カット'); // inherited
    expect(t.rules.endsWith('自分のルール')).toBe(true);
    expect(t.chain).toEqual(['my-talk', 'talk-youtube', 'base-horizontal']);
    expect(listTemplates().map((x) => x.id)).toContain('my-talk');
  });

  it('a user template with a built-in id shadows it and may extend it', () => {
    writeTemplate(join(home, 'templates'), 'talk-youtube', 'id: talk-youtube\nextends: talk-youtube\nversion: 9\n');
    const t = loadTemplate('talk-youtube');
    expect(t.version).toBe('9');
    expect(t.chain).toEqual(['talk-youtube', 'talk-youtube', 'base-horizontal']);
    expect(listTemplates().filter((x) => x.id === 'talk-youtube')).toHaveLength(1);
  });

  it('extra dirs (project templates) come first', () => {
    const proj = join(home, 'proj-templates');
    writeTemplate(proj, 'talk-youtube', 'id: talk-youtube\nextends: talk-youtube\nversion: p\n');
    expect(loadTemplate('talk-youtube', { extraDirs: [proj] }).version).toBe('p');
  });

  it('validates semantic rules: default layout allowed, thresholds ordered, unique pipeline', () => {
    const root = join(home, 'templates');
    writeTemplate(root, 'l', 'id: l\nextends: talk-youtube\nlayouts: { default: split-v, allowed: [camera-full] }\n');
    writeTemplate(root, 'd', 'id: d\nextends: talk-youtube\ndecisions: { cutKeep: { autoAbove: 0.2, autoBelow: 0.8 } }\n');
    writeTemplate(root, 'p', 'id: p\nextends: talk-youtube\npipeline: [ingest, ingest]\n');
    expect(() => loadTemplate('l')).toThrow(/layouts.default/);
    expect(() => loadTemplate('d')).toThrow(/autoBelow/);
    expect(() => loadTemplate('p')).toThrow(/duplicate/);
  });

  it('fps notation', () => {
    expect(toRational(30)).toEqual({ num: 30, den: 1 });
    expect(toRational(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(toRational(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(toRational(12.5)).toEqual({ num: 12500, den: 1000 });
  });

  it('deepMerge', () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] }, d: 1 })).toEqual({ a: { b: 1, c: [2] }, d: 1 });
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe('generateAgentsMd', () => {
  const t = () => loadTemplate('talk-youtube');

  it('Japanese: role, first commands, rules, rules.md, cheat sheet, handoff', () => {
    const md = generateAgentsMd(t(), { dir: '/p', title: '設定の3つのコツ', lang: 'ja' });
    expect(md).toContain('# 設定の3つのコツ — エージェントへの指示書');
    expect(md).toContain('あなたはこのプロジェクトの動画編集者です');
    expect(md).toContain('`talk-youtube`');
    expect(md).toMatch(/solocut status --json\nsolocut next --json/);
    expect(md).toContain('`media/` の中は変更しない');
    expect(md).toContain('solocut validate');
    expect(md).toContain('.solocut/questions.md');
    expect(md).toContain('語り動画（YouTube）の編集方針'); // rules.md text
    expect(md).toContain('共通の方針（横型）'); // base rules too
    expect(md).toContain('| `solocut edit --ops ops.json` |');
    expect(md).toContain('"state": "needs-human"');
    expect(md).toContain('.solocut/handoff.md');
    expect(md).toContain('prompts/rough-cut.md');
    // every pipeline step is listed in order
    let last = -1;
    for (const s of t().pipeline) {
      const i = md.indexOf(`**${s}**`);
      expect(i, s).toBeGreaterThan(last);
      last = i;
    }
    // pipes inside commands are escaped so the table does not break
    expect(md).toContain('solocut past list\\|search\\|show\\|timeline');
  });

  it('English output when the project language is en', () => {
    const md = generateAgentsMd(t(), { dir: '/p', title: 'Three tips', lang: 'en' });
    expect(md).toContain('You are the video editor of this project');
    expect(md).toContain('Never modify anything in `media/`');
    expect(md).toContain('Never publish');
    expect(md).not.toContain('あなたは');
  });

  it('CLAUDE.md only imports AGENTS.md', () => {
    expect(CLAUDE_MD).toBe('@AGENTS.md\n');
  });
});

describe('nextStep', () => {
  const tpl = (): Template => loadTemplate('talk-youtube');
  const ctx = (o: Partial<NextContext> = {}): NextContext => ({ hasTakes: true, hasTranscript: true, openItems: 0, lastCheckFailed: 0, ...o });
  const status = (t: Template, done: StepId[], extra: Partial<Record<StepId, StepState['state']>> = {}): StepState[] =>
    t.pipeline.map((step) => ({ step, state: extra[step] ?? (done.includes(step) ? 'done' : 'todo') }));
  const upTo = (t: Template, step: StepId): StepId[] => t.pipeline.slice(0, t.pipeline.indexOf(step));

  it('initialStatus is all todo', () => {
    expect(initialStatus(tpl()).every((s) => s.state === 'todo')).toBe(true);
  });

  it('no takes → ingest needs a human', () => {
    const n = nextStep(tpl(), initialStatus(tpl()), ctx({ hasTakes: false }));
    expect(n).toMatchObject({ step: 'ingest', state: 'needs-human' });
    expect(n.commands[0]).toContain('solocut import');
  });

  it('takes but nothing done → ingest ready', () => {
    expect(nextStep(tpl(), initialStatus(tpl()), ctx({ hasTranscript: false }))).toMatchObject({ step: 'ingest', state: 'ready' });
  });

  it('walks the pipeline in order, one step at a time', () => {
    const t = tpl();
    for (const step of t.pipeline) {
      if (step === 'review') continue;
      const n = nextStep(t, status(t, upTo(t, step)), ctx());
      expect(n.step, `after ${upTo(t, step).at(-1)}`).toBe(step);
      expect(n.state).toBe('ready');
      expect(n.commands.length).toBeGreaterThan(0);
    }
  });

  it('includes the template prompt for steps that have one', () => {
    const t = tpl();
    expect(nextStep(t, status(t, upTo(t, 'rough-cut')), ctx()).prompt).toBe(t.promptFiles['rough-cut']);
    expect(nextStep(t, status(t, upTo(t, 'preview')), ctx()).prompt).toBeUndefined();
  });

  it('transcribe marked done without a transcript → transcribe again', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'rough-cut')), ctx({ hasTranscript: false }));
    expect(n).toMatchObject({ step: 'transcribe', state: 'ready' });
  });

  it('rough-cut todo without transcript (pipeline without transcribe) → transcribe', () => {
    const t = { ...tpl(), pipeline: ['ingest', 'rough-cut'] as StepId[] };
    expect(nextStep(t, status(t, ['ingest']), ctx({ hasTranscript: false })).step).toBe('transcribe');
  });

  it('rough-cut needs-human → wait, but offer captions meanwhile with blocking ids', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'rough-cut'), { 'rough-cut': 'needs-human' }), ctx({ openItems: 2, openItemRefs: ['seg_14', 'seg_22'] }));
    expect(n).toMatchObject({ step: 'rough-cut', state: 'needs-human', meanwhile: 'captions', blocking: ['seg_14', 'seg_22'] });
    expect(n.commands).toEqual(['solocut captions build --json', expect.any(String)]);
  });

  it('rough-cut done with open items still blocks; 0 open items passes', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'multicam'));
    expect(nextStep(t, st, ctx({ openItems: 1 })).state).toBe('needs-human');
    expect(nextStep(t, st, ctx({ openItems: 0 })).step).toBe('multicam');
  });

  it('autopilot proceeds past undecided rough-cut but not past sync', () => {
    const t = tpl();
    const rc = nextStep(t, status(t, upTo(t, 'rough-cut'), { 'rough-cut': 'needs-human' }), ctx({ autopilot: true, openItems: 3 }));
    expect(rc.step).toBe('multicam');
    const sync = nextStep(t, status(t, ['ingest'], { sync: 'needs-human' }), ctx({ autopilot: true }));
    expect(sync).toMatchObject({ step: 'sync', state: 'needs-human' });
    // meanwhile transcription can run (it does not depend on sync)
    expect(sync.meanwhile).toBe('transcribe');
  });

  it('check failed → check again with preview first; 0 failures passes', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'review'));
    const n = nextStep(t, st, ctx({ lastCheckFailed: 2 }));
    expect(n).toMatchObject({ step: 'check', state: 'ready' });
    expect(n.commands).toContain('solocut check --json');
    expect(nextStep(t, st, ctx({ lastCheckFailed: 0 }))).toMatchObject({ step: 'review', state: 'needs-human' });
  });

  it('review waits for a human; autopilot skips to final; done review → final per target', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'review'));
    expect(nextStep(t, st, ctx()).state).toBe('needs-human');
    const ap = nextStep(t, st, ctx({ autopilot: true }));
    expect(ap.step).toBe('final');
    expect(ap.commands).toEqual(['solocut render --final --target youtube --json']);
    expect(nextStep(t, status(t, upTo(t, 'final')), ctx()).step).toBe('final');
  });

  it('autopilot stops before steps listed in stopBefore', () => {
    const t = tpl();
    const n = nextStep(t, status(t, upTo(t, 'final')), ctx({ autopilot: true, stopBefore: ['final'] }));
    expect(n).toMatchObject({ step: 'final', state: 'needs-human' });
  });

  it('running steps are resumed', () => {
    const t = tpl();
    const n = nextStep(t, status(t, ['ingest'], { sync: 'running' }), ctx());
    expect(n).toMatchObject({ step: 'sync', state: 'ready' });
  });

  it('skipped counts as passed', () => {
    const t = tpl();
    const st = status(t, upTo(t, 'captions'), { multicam: 'skipped' });
    expect(nextStep(t, st, ctx()).step).toBe('captions');
  });

  it('everything done → done; English text', () => {
    const t = tpl();
    const n = nextStep(t, status(t, [...t.pipeline]), ctx({ lang: 'en' }));
    expect(n).toMatchObject({ step: 'done', state: 'done', commands: [] });
    expect(n.why).toMatch(/All template steps/);
  });

  it('a needs-human step note becomes the reason', () => {
    const t = tpl();
    const st = status(t, ['ingest']);
    st[1] = { step: 'sync', state: 'needs-human', note: '同期の信頼度が 0.41' };
    expect(nextStep(t, st, ctx()).why).toBe('同期の信頼度が 0.41');
  });

  it('missing status entries count as todo; unknown steps are ignored', () => {
    expect(nextStep(tpl(), [{ step: 'ingest', state: 'done' }], ctx()).step).toBe('sync');
    expect(STEP_IDS.length).toBe(14);
  });
});
