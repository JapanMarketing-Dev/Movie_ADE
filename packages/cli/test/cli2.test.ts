import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { progress, progressDone, type Ctx } from '../src/ctx.js';
import { main } from '../src/index.js';
import { createMcpServer } from '../src/mcp.js';
import { Sandbox } from './helpers.js';

let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  const r = await sb.run(['init', dir, '--template', 'talk-youtube', '--title', '設定のコツ', '--no-git', '--json']);
  expect(r.code).toBe(0);
});
afterEach(() => sb.dispose());

const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const decided = { by: 'agent', reason: 't' };
const cam = { kind: 'camera', path: 'media/a.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 };
const bgmAsset = { kind: 'asset', path: 'assets/bgm.mp3', assetId: 'maou-1', license: { id: 'maou', credit: '音楽: 魔王魂' } };
const sfxAsset = { kind: 'asset', path: 'assets/pop.wav', assetId: 'oto-1', license: { id: 'OtoLogic-CC-BY-4.0', credit: '効果音: OtoLogic' } };
const seg = (id: string, from: number, to: number, chapter = 'ch_1') => ({ id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter, role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided });

/** 3 chapters of 20 s each, a BGM and an sfx with credits. */
async function seed() {
  const ops = [
    { op: 'addSource', id: 'cam', source: cam },
    { op: 'addSource', id: 'bgm1', source: bgmAsset },
    { op: 'addSource', id: 'pop', source: sfxAsset },
    { op: 'setOutline', outline: [
      { id: 'ch_1', title: 'はじめに', start: 0, end: 600, points: [], importance: 'core' },
      { id: 'ch_2', title: '設定ファイル', start: 600, end: 1200, points: [], importance: 'core' },
      { id: 'ch_3', title: 'まとめ', start: 1200, end: 1800, points: [], importance: 'core' },
    ] },
    { op: 'addSegment', segment: seg('seg_1', 0, 600) },
    { op: 'addSegment', segment: seg('seg_2', 600, 1200, 'ch_2') },
    { op: 'addSegment', segment: seg('seg_3', 1200, 1800, 'ch_3') },
    { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'bgm1', range: { start: 0, end: 1800 }, gainDb: -24, duckDb: -12, fadeIn: 0, fadeOut: 0, decided }] },
    { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 600, gainDb: -12, trigger: 'section', decided } },
    { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'big-number', version: '1' }, range: { start: 900, end: 960 }, slots: { value: { kind: 'number', value: 3 } }, decided } },
  ];
  const r = await run(['edit', '--ops', JSON.stringify(ops)]);
  expect(r.json, r.stdout).toMatchObject({ ok: true });
}

describe('meta', () => {
  it('sets metadata, writes metadata.md with chapters and credits, and credits.txt', async () => {
    await seed();
    const r = await run(['meta', 'set', '--title', '設定は3つだけ', '--description', 'Claude Code の設定のコツ。', '--tags', '#claude, 設定 ,AI', '--candidates', '案A', '--candidates', '案B']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, targets: ['youtube'] });
    const out = timeline().outputs[0];
    expect(out.metadata).toEqual({ title: '設定は3つだけ', titleCandidates: ['案A', '案B'], description: 'Claude Code の設定のコツ。', tags: ['claude', '設定', 'AI'], chapters: true });
    const md = readFileSync(join(dir, 'renders', 'youtube', 'metadata.md'), 'utf8');
    expect(md).toContain('# 設定は3つだけ');
    expect(md).toContain('00:00 はじめに\n00:20 設定ファイル\n00:40 まとめ');
    expect(md).toContain('クレジット:\n音楽: 魔王魂\n効果音: OtoLogic');
    expect(readFileSync(join(dir, 'renders', 'youtube', 'credits.txt'), 'utf8')).toBe('音楽: 魔王魂\n効果音: OtoLogic\n');
    const st = JSON.parse(readFileSync(join(dir, '.solocut', 'status.json'), 'utf8'));
    expect(st.find((s: { step: string }) => s.step === 'metadata').state).toBe('done');
    // partial update keeps the rest
    await run(['meta', 'set', '--description', '新しい説明']);
    expect(timeline().outputs[0].metadata).toMatchObject({ title: '設定は3つだけ', description: '新しい説明' });
    const show = await run(['meta', 'show']);
    expect(show.json.chapters.text).toContain('00:40 まとめ');
    expect(show.json.credits).toEqual(['音楽: 魔王魂', '効果音: OtoLogic']);
  });

  it('per-target file input, vertical canvas, invalid values', async () => {
    await seed();
    writeFileSync(join(sb.root, 'm.json'), JSON.stringify({ youtube: { title: 'Y' }, tiktok: { title: 'T', tags: ['x'] } }));
    const r = await run(['meta', 'set', '--target', 'youtube', '--target', 'tiktok', '--file', join(sb.root, 'm.json')]);
    expect(r.json, r.stdout).toMatchObject({ ok: true });
    const tk = timeline().outputs.find((o: { target: string }) => o.target === 'tiktok');
    expect(tk.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(tk.metadata).toMatchObject({ title: 'T', tags: ['x'], chapters: false });
    expect(existsSync(join(dir, 'renders', 'tiktok', 'metadata.md'))).toBe(true);
    expect((await run(['meta', 'set', '--title', 'x'.repeat(101)])).code).toBe(2);
    expect((await run(['meta', 'set', '--target', 'myspace', '--title', 'x'])).code).toBe(2);
    writeFileSync(join(sb.root, 'bad.json'), JSON.stringify({ title: 3 }));
    expect((await run(['meta', 'set', '--file', join(sb.root, 'bad.json')])).code).toBe(2);
    expect((await run(['meta', 'set', '--file', join(sb.root, 'nope.json')])).json.error.code).toBe('not-found');
  });

  it('omits chapters YouTube would reject', async () => {
    await run(['edit', '--ops', JSON.stringify([{ op: 'addSource', id: 'cam', source: cam }, { op: 'setOutline', outline: [{ id: 'ch_1', title: 'a', start: 0, end: 300, points: [], importance: 'core' }] }, { op: 'addSegment', segment: seg('seg_1', 0, 300) }])]);
    await run(['meta', 'set', '--title', 'x']);
    const md = readFileSync(join(dir, 'renders', 'youtube', 'metadata.md'), 'utf8');
    expect(md).toContain('チャプターを付けられません: YouTube needs at least 3 chapters');
    expect(readFileSync(join(dir, 'renders', 'youtube', 'credits.txt'), 'utf8')).toBe('');
  });
});

describe('past reuse', () => {
  it('turns scenes, sfx and caption style of a past video into ops and a template patch', async () => {
    await seed();
    await run(['edit', '--ops', JSON.stringify([{ op: 'setCaptions', captions: [{ id: 'cap_1', range: { start: 0, end: 30 }, text: 'a', spoken: 'a', words: [], lines: ['a'], emphasis: [], style: 'tiktok-bold', position: { anchor: 'bottom', y: 0.9 }, decided }] }])]);
    const id = (await run(['past', 'register'])).json.entry.id as string;
    // a new project with the same take but no scenes/sfx/bgm, different caption style
    const d2 = join(sb.root, 'v2');
    await sb.run(['init', d2, '--template', 'talk-youtube', '--no-git', '--json']);
    const ops2 = [
      { op: 'addSource', id: 'cam', source: cam },
      { op: 'setOutline', outline: [{ id: 'ch_1', title: 'a', start: 0, end: 450, points: [], importance: 'core' }, { id: 'ch_2', title: 'b', start: 450, end: 900, points: [], importance: 'core' }] },
      { op: 'addSegment', segment: seg('seg_1', 0, 450) },
      { op: 'addSegment', segment: seg('seg_2', 450, 900, 'ch_2') },
      { op: 'setCaptions', captions: [{ id: 'cap_1', range: { start: 0, end: 30 }, text: 'b', spoken: 'b', words: [], lines: ['b'], emphasis: [], style: 'youtube-clean', position: { anchor: 'bottom', y: 0.9 }, decided }] },
    ];
    await sb.run(['edit', '--ops', JSON.stringify(ops2), '--json'], { cwd: d2 });
    const dry = await sb.run(['past', 'reuse', id, '--what', 'scenes,sfx,captions,pacing,thumbnail-style', '--json'], { cwd: d2 });
    expect(dry.json, dry.stdout).toMatchObject({ ok: true, applied: false, templatePatch: { captions: { style: 'tiktok-bold' } } });
    const opNames = dry.json.ops.map((o: { op: string }) => o.op);
    expect(opNames, JSON.stringify(dry.json.ops.filter((o: { op: string }) => o.op === 'addSfx'))).toEqual(['addSource', 'setMeta', 'addScene', 'updateCaption', 'addSfx']);
    const scene = dry.json.ops.find((o: { op: string }) => o.op === 'addScene').scene;
    expect(scene.range).toEqual({ start: 450, end: 510 }); // same relative position (50 %)
    expect(scene.decided.needsReview).toBe(true);
    expect(dry.json.ops.filter((o: { op: string }) => o.op === 'addSfx').map((o: { sfx: { at: number } }) => o.sfx.at)).toEqual([0]); // past: 1 section sfx per 3 chapters → every 3rd chapter
    const before = readFileSync(join(d2, 'timeline.json'), 'utf8');
    expect(readFileSync(join(d2, 'timeline.json'), 'utf8')).toBe(before);
    const ap = await sb.run(['past', 'reuse', id, '--what', 'scenes,sfx,captions', '--apply', '--json'], { cwd: d2 });
    expect(ap.json, ap.stdout).toMatchObject({ ok: true, applied: true, templateFile: 'templates/talk-youtube/template.yaml' });
    const t2 = JSON.parse(readFileSync(join(d2, 'timeline.json'), 'utf8'));
    expect(t2.meta.references[0]).toMatchObject({ archive: id, use: ['scenes', 'sfx', 'captions'] });
    expect(t2.sources.pop.kind).toBe('asset');
    expect(t2.captions[0].style).toBe('tiktok-bold');
    // the project template override is used by the CLI
    const tpl = await sb.run(['next', '--json'], { cwd: d2 });
    expect(tpl.json.ok).toBe(true);
    expect(readFileSync(join(d2, 'templates', 'talk-youtube', 'template.yaml'), 'utf8')).toContain('"extends": "talk-youtube"');
    expect((await sb.run(['past', 'reuse', id, '--what', 'colors', '--json'], { cwd: d2 })).code).toBe(2);
    expect((await sb.run(['past', 'reuse', 'arc_nope', '--json'], { cwd: d2 })).json.error.code).toBe('archive');
  });
});

describe('mcp end to end', () => {
  it('serves real CLI commands for a project', async () => {
    await seed();
    const server = createMcpServer(async (argv) => {
      let stdout = '';
      let stderr = '';
      const code = await main(argv, { cwd: sb.root, env: { ...process.env, SOLOCUT_HOME: sb.home }, stdout: (x) => (stdout += x), stderr: (x) => (stderr += x) });
      return { code, stdout, stderr };
    }, { defaultProject: dir });
    const next = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'next', arguments: {} } })) as { result: { content: { text: string }[]; isError: boolean } };
    if (next.result.isError) throw new Error(next.result.content[0]!.text);
    expect(JSON.parse(next.result.content[0]!.text).step).toBe('ingest');
    const show = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tl_show', arguments: { id: 'seg_2' } } })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(show.result.content[0]!.text).element.id).toBe('seg_2');
    const edit = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'edit', arguments: { ops: [{ op: 'setMeta', patch: { goal: 'MCP から' } }] } } })) as { result: { isError: boolean } };
    expect(edit.result.isError).toBe(false);
    expect(timeline().meta.goal).toBe('MCP から');
    // an edit that would leave the BGM past the end is rejected and reported as a tool error
    const bad = (await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'edit', arguments: { ops: [{ op: 'removeSegment', id: 'seg_3', decided: { by: 'agent', reason: 'x' } }] } } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0]!.text).error.code).toBe('invalid-result');
  });

  it('`solocut mcp` reads JSON-RPC lines from stdin', async () => {
    let out = '';
    async function* lines() {
      yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      yield JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
    }
    const code = await main(['mcp', '--project', dir], { cwd: sb.root, env: { ...process.env, SOLOCUT_HOME: sb.home }, stdout: (x) => (out += x), stderr: () => {}, stdinLines: lines });
    expect(code).toBe(0);
    const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].result.serverInfo.name).toBe('solocut');
    expect(JSON.parse(msgs[1].result.content[0].text).steps).toHaveLength(21);
  });
});

describe('progress output', () => {
  const ctx = (isTTY: boolean, json = false) => {
    let err = '';
    const c = { io: { cwd: '/', env: {}, stdout: () => {}, stderr: (s: string) => (err += s), isTTY }, json, lang: 'ja', by: 'human' } as unknown as Ctx;
    return { c, err: () => err };
  };
  it('non-TTY: at most one line per 10 %', () => {
    const { c, err } = ctx(false);
    for (let i = 0; i <= 100; i++) progress(c, 'k', i / 100, 'dl');
    progressDone(c, 'k');
    const lines = err().trim().split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('dl 0%');
    expect(lines.at(-1)).toBe('dl 100%');
    expect(err()).not.toContain('\r');
  });
  it('TTY: redraws one line; --json: silent', () => {
    const t = ctx(true);
    progress(t.c, 'k', 0.5, 'dl');
    progressDone(t.c, 'k');
    expect(t.err()).toMatch(/^\rdl \[#{12}\.{12}\] 50% {3}\n$/);
    const j = ctx(false, true);
    progress(j.c, 'k', 0.5, 'dl');
    expect(j.err()).toBe('');
  });
});
