import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichSync } from '@solocut/toolchain';
import { Sandbox } from './helpers.js';

// Synthetic media via ffmpeg lavfi. Skipped when ffmpeg is not installed (CI installs it).
const ffmpeg = process.env.SOLOCUT_FFMPEG ?? whichSync('ffmpeg');
const hasFfmpeg = !!ffmpeg && !!(process.env.SOLOCUT_FFPROBE ?? whichSync('ffprobe'));
if (!hasFfmpeg) console.warn('[solocut] ffmpeg/ffprobe not found: skipping CLI media pipeline tests');

// speech-like tone in [0.5,3], [4.5,7], [8,9.5]; silence elsewhere (10 s)
const VOICE = "if(between(t,0.5,3)+between(t,4.5,7)+between(t,8,9.5),0.4*sin(2*PI*330*t)*(0.6+0.4*sin(2*PI*3*t)),0)";

function makeClip(out: string, o: { audio: boolean; dur?: number; size?: string }) {
  const dur = String(o.dur ?? 10);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${o.size ?? '640x360'}:rate=30:duration=${dur}`];
  if (o.audio) args.push('-f', 'lavfi', '-i', `aevalsrc='${VOICE}':s=48000:d=${dur}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30');
  if (o.audio) args.push('-c:a', 'aac', '-shortest');
  args.push(out);
  execFileSync(ffmpeg!, args);
}

function makeWav(out: string, delaySec: number) {
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${VOICE.replace(/t\b/g, `(t+${delaySec})`)}':s=48000:d=${10 - delaySec}`, '-c:a', 'pcm_s16le', out]);
}

describe.skipIf(!hasFfmpeg)('media pipeline (ffmpeg)', () => {
  let sb: Sandbox;
  let dir: string;
  const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
  const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));

  beforeAll(async () => {
    sb = new Sandbox();
    dir = join(sb.root, 'p');
    const r = await sb.run(['init', dir, '--template', 'talk-youtube', '--title', 'Pipeline', '--no-git', '--json']);
    expect(r.code).toBe(0);
    makeClip(join(sb.root, 'cam.mp4'), { audio: true });
  }, 60_000);
  afterAll(() => sb?.dispose());

  it('import → propose cuts → render preview → check → frame → final render + archive', async () => {
    const imp = await run(['import', join(sb.root, 'cam.mp4'), '--role', 'front']);
    expect(imp.json, imp.stdout + imp.stderr).toMatchObject({ ok: true, id: 'imp1', take: 'take_imp1', source: { kind: 'camera', role: 'front' } });
    expect(existsSync(join(dir, 'media', 'imports', 'imp1', 'cam.mp4'))).toBe(true);
    expect(timeline().sources.imp1.durationFrames).toBeGreaterThanOrEqual(299);

    const dry = await run(['propose', 'cuts', '--dry-run']);
    expect(dry.json.ok, dry.stdout).toBe(true);
    expect(dry.json.dryRun).toBe(true);
    expect(timeline().segments).toEqual([]);

    const pc = await run(['propose', 'cuts']);
    expect(pc.json, pc.stdout).toMatchObject({ ok: true, segments: 3 });
    expect(pc.json.cutRatio).toBeGreaterThan(0.2);
    expect(pc.json.cutRatio).toBeLessThan(0.5);
    const tl = timeline();
    expect(tl.segments).toHaveLength(3);
    expect(tl.segments[0].src.from).toBeGreaterThanOrEqual(10); // leading silence (0.5 s) removed, minus the pad
    expect(tl.segments[0].removedNeighbors[0]).toMatchObject({ kind: 'silence', decided: { by: 'rule' } });
    expect(tl.segments[2].transitionIn).toEqual({ kind: 'jump-zoom', frames: 0 }); // talk-youtube jumpZoom every 2
    expect(tl.outline).toHaveLength(1);
    expect((await run(['propose', 'cuts'])).json.error.code).toBe('segments-exist');
    expect((await run(['next'])).json.step).toBe('sync'); // ingest was marked done by import
    const st = JSON.parse(readFileSync(join(dir, '.solocut', 'status.json'), 'utf8'));
    expect(st.find((s: { step: string }) => s.step === 'rough-cut').state).toBe('running');

    const rp = await run(['render', '--preview']);
    expect(rp.json, rp.stdout + rp.stderr).toMatchObject({ ok: true, output: 'renders/preview.mp4', quality: 'preview' });
    expect(existsSync(join(dir, 'renders', 'preview.mp4'))).toBe(true);
    const again = await run(['render', '--preview']);
    expect(again.json.rendered).toBe(0); // all chunks reused

    const ck = await run(['check']);
    expect(ck.json, ck.stdout + ck.stderr).toMatchObject({ ok: true });
    expect(ck.json.run).toMatch(/^chk_/);
    expect(existsSync(join(dir, ck.json.report))).toBe(true);
    expect(timeline().review.lastCheck).toMatchObject({ run: ck.json.run });

    const fr = await run(['frame', '--at', '00:00:01:00']);
    expect(fr.json).toMatchObject({ ok: true, frame: 30 });
    expect(existsSync(fr.json.path)).toBe(true);

    const fin = await run(['render', '--final', '--target', 'youtube']);
    expect(fin.json, fin.stdout + fin.stderr).toMatchObject({ ok: true, target: 'youtube' });
    expect(existsSync(join(dir, fin.json.output))).toBe(true);
    expect(timeline().outputs[0]).toMatchObject({ target: 'youtube', render: { path: fin.json.output } });
    const past = await sb.run(['past', 'list', '--json']);
    expect(past.json.entries[0]).toMatchObject({ title: 'Pipeline', reason: 'export' });
  }, 240_000);

  it('ingest reads take.json: clock offsets, roles and NG markers', async () => {
    const d2 = join(sb.root, 'p2');
    await sb.run(['init', d2, '--template', 'talk-youtube', '--no-git', '--json']);
    const take = join(d2, 'media', 'takes', 'take_20261011-120000');
    mkdirSync(take, { recursive: true });
    makeClip(join(take, 'camera-1.mp4'), { audio: false, dur: 4 });
    makeWav(join(take, 'mic-1.wav'), 0.5);
    writeFileSync(join(take, 'take.json'), JSON.stringify({
      schema: 1, id: 'take_20261011-120000', createdAt: '2026-10-11T12:00:00Z', timeOrigin: 0, startedAtMs: 1000,
      tracks: [
        { file: 'camera-1.mp4', kind: 'camera', fps: 30, width: 640, height: 360, firstFrameMs: 1000 },
        { file: 'mic-1.wav', kind: 'mic', sampleRate: 48000, firstFrameMs: 1500 },
        { file: 'system.wav', kind: 'system' },
      ],
      markers: [{ kind: 'ng', atMs: 3000, sinceStartMs: 2000 }],
      app: { version: '0.1.0', os: 'mac' }, complete: true,
    }));
    const r = await sb.run(['ingest', '--json'], { cwd: d2 });
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, markers: 1 });
    expect(r.json.added.sort()).toEqual(['take_20261011-120000.camera-1', 'take_20261011-120000.mic-1']);
    const tl = JSON.parse(readFileSync(join(d2, 'timeline.json'), 'utf8'));
    expect(tl.sources['take_20261011-120000.camera-1']).toMatchObject({ kind: 'camera', role: 'front', offset: 0, take: 'take_20261011-120000', audio: false, sync: { method: 'clock' } });
    expect(tl.sources['take_20261011-120000.mic-1']).toMatchObject({ kind: 'mic', offset: -24000, sampleRate: 48000 });
    expect(tl.markers).toEqual([{ kind: 'ng', at: 60, srcAt: 60, from: 'hotkey' }]);
    // idempotent
    expect((await sb.run(['ingest', '--json'], { cwd: d2 })).json.added).toEqual([]);
    const takes = await sb.run(['takes', '--json'], { cwd: d2 });
    expect(takes.json.takes[0]).toMatchObject({ id: 'take_20261011-120000', ingested: true, markers: 1 });
  }, 120_000);

  it('transcript → propose cuts drops fillers → captions keep every kept word', async () => {
    const d3 = join(sb.root, 'p3');
    await sb.run(['init', d3, '--template', 'talk-youtube', '--no-git', '--json']);
    await sb.run(['import', join(sb.root, 'cam.mp4'), '--json'], { cwd: d3 });
    // speech in [0.5,3], [4.5,7], [8,9.5]; a filler said at the start of the second phrase
    const words = [
      { w: '今日は', start: 0.55, end: 1.4 }, { w: '設定の', start: 1.4, end: 2.2 }, { w: '話です。', start: 2.2, end: 2.95 },
      { w: 'えー', start: 4.5, end: 5.0 }, { w: '次に', start: 5.0, end: 6.0 }, { w: '開きます。', start: 6.0, end: 6.95 },
      { w: '押します。', start: 8.05, end: 9.45 },
    ];
    mkdirSync(join(d3, 'derived', 'transcripts'), { recursive: true });
    writeFileSync(join(d3, 'derived', 'transcripts', 'main.json'), JSON.stringify({ schema: 1, engine: 'whisper.cpp', model: 'test', language: 'ja', take: 'take_imp1', source: 'imp1', words }));
    const pc = await sb.run(['propose', 'cuts', '--json'], { cwd: d3 });
    expect(pc.json, pc.stdout).toMatchObject({ ok: true, removed: { filler: 1 } });
    const tl = JSON.parse(readFileSync(join(d3, 'timeline.json'), 'utf8'));
    expect(tl.segments.map((s: { text: string }) => s.text).join('')).toBe('今日は設定の話です。次に開きます。押します。');
    const cb = await sb.run(['captions', 'build', '--json'], { cwd: d3 });
    expect(cb.json, cb.stdout).toMatchObject({ ok: true });
    const caps = JSON.parse(readFileSync(join(d3, 'timeline.json'), 'utf8')).captions as { text: string; range: { start: number; end: number } }[];
    expect(caps.map((c) => c.text).join('')).toBe('今日は設定の話です。次に開きます。押します。');
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.range.start).toBeGreaterThanOrEqual(caps[i - 1]!.range.end);
    expect(readFileSync(join(d3, 'captions', 'main.srt'), 'utf8')).toContain('次に開きます。');
    expect(existsSync(join(d3, 'captions', 'main.ass'))).toBe(true);
    // rebuilding the cuts clears the now-stale captions and asks for a rebuild
    const again = await sb.run(['propose', 'cuts', '--replace', '--json'], { cwd: d3 });
    expect(again.json.warnings.join(' ')).toContain('captions build');
    expect(JSON.parse(readFileSync(join(d3, 'timeline.json'), 'utf8')).captions).toEqual([]);
  }, 120_000);

  it('import rejects a file without video as camera and cleans up', async () => {
    const wav = join(sb.root, 'voice.wav');
    makeWav(wav, 0);
    const r = await sb.run(['import', wav, '--kind', 'camera', '--json'], { cwd: dir });
    expect(r.json.error.code).toBe('no-video');
    const m = await sb.run(['import', wav, '--kind', 'mic', '--take', 'take_imp1', '--json'], { cwd: dir });
    expect(m.json, m.stdout).toMatchObject({ ok: true, source: { kind: 'mic' }, needsSync: true });
    // the camera's own audio is the same signal: sync finds ~0 s against the mic
    const sy = await sb.run(['sync', '--json'], { cwd: dir });
    expect(sy.json, sy.stdout + sy.stderr).toMatchObject({ ok: true });
    const r0 = sy.json.results.find((x: { source: string }) => x.source === 'imp1');
    expect(r0).toBeDefined();
    expect(Math.abs(r0.offsetSec)).toBeLessThan(0.05);
    expect(existsSync(join(dir, 'derived', 'analysis', 'sync.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')).sources.imp1.sync).toMatchObject({ method: 'xcorr' });
  }, 60_000);
});

// Real transcription needs whisper-cli and a model; set SOLOCUT_WHISPER_MODEL to run it.
const hasWhisper = hasFfmpeg && !!process.env.SOLOCUT_WHISPER_MODEL && !!(process.env.SOLOCUT_WHISPER_CLI ?? whichSync('whisper-cli'));
describe.skipIf(!hasWhisper)('transcribe (whisper.cpp)', () => {
  it('writes derived/transcripts/main.json in take time', async () => {
    const sb = new Sandbox();
    try {
      const dir = join(sb.root, 'w');
      await sb.run(['init', dir, '--template', 'talk-youtube', '--no-git', '--json']);
      makeClip(join(sb.root, 'cam.mp4'), { audio: true, dur: 4 });
      await sb.run(['import', join(sb.root, 'cam.mp4'), '--json'], { cwd: dir });
      const r = await sb.run(['transcribe', '--json'], { cwd: dir });
      expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, path: 'derived/transcripts/main.json' });
      expect(JSON.parse(readFileSync(join(dir, 'derived', 'transcripts', 'main.json'), 'utf8'))).toMatchObject({ schema: 1, engine: 'whisper.cpp', take: 'take_imp1' });
      expect(JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')).transcript).toMatchObject({ path: 'derived/transcripts/main.json', engine: 'whisper.cpp' });
    } finally {
      sb.dispose();
    }
  }, 300_000);
});
