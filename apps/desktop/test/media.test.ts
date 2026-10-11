import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentTypeFor, parseRange } from '../src/main/services/range';
import { WAV_HEADER_BYTES, wavHeader, wavSizePatches } from '../src/main/services/wav';
import { activeTakes, appendTrack, beginTake, closeTrack, endTake, newTakeId, openTrack, writeTakeMeta } from '../src/main/services/recorder';
import { scrubDeep, scrubString } from '../src/main/services/scrub';
import { pickVideoMime, toInt16Interleaved } from '../src/shared/pcm';

describe('parseRange', () => {
  it('full when no/unsupported header', () => {
    expect(parseRange(null, 100)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'full' });
  });
  it('explicit, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-0', 100)).toEqual({ kind: 'partial', start: 0, end: 0 });
    expect(parseRange('bytes=10-', 100)).toEqual({ kind: 'partial', start: 10, end: 99 });
    expect(parseRange('bytes=90-1000', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
  });
  it('invalid ranges', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'invalid' });
    expect(parseRange('bytes=5-4', 100)).toEqual({ kind: 'invalid' });
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'invalid' });
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'invalid' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'invalid' });
  });
  it('content types', () => {
    expect(contentTypeFor('/a/B.MP4')).toBe('video/mp4');
    expect(contentTypeFor('x.webm')).toBe('video/webm');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
});

describe('wav', () => {
  it('writes a valid 44-byte PCM header', () => {
    const h = wavHeader({ sampleRate: 48000, channels: 2, bitsPerSample: 16, dataBytes: 1000 });
    expect(h.length).toBe(WAV_HEADER_BYTES);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(1036);
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(h.readUInt16LE(20)).toBe(1);
    expect(h.readUInt16LE(22)).toBe(2);
    expect(h.readUInt32LE(24)).toBe(48000);
    expect(h.readUInt32LE(28)).toBe(192000);
    expect(h.readUInt16LE(32)).toBe(4);
    expect(h.readUInt32LE(40)).toBe(1000);
  });
  it('float format and size clamping', () => {
    expect(wavHeader({ sampleRate: 8000, channels: 1, bitsPerSample: 32, float: true, dataBytes: 0 }).readUInt16LE(20)).toBe(3);
    expect(wavSizePatches(0xffffffff)).toEqual([[4, 0xffffffff], [40, 0xffffffff]]);
  });
});

describe('recorder files (crash-safe appends)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solocut-rec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('take ids are sortable timestamps', () => {
    expect(newTakeId(new Date(2026, 9, 11, 9, 5, 7))).toBe('take_20261011-090507');
  });

  it('appends video chunks and keeps the WAV header valid after every append', () => {
    const { takeId, takeDir } = beginTake(dir);
    expect(takeDir.startsWith(join(dir, 'media', 'takes'))).toBe(true);
    openTrack({ takeId, file: 'screen.mp4', kind: 'screen' });
    openTrack({ takeId, file: 'mic-1.wav', kind: 'mic', wav: { sampleRate: 48000, channels: 1 } });
    expect(appendTrack(takeId, 'screen.mp4', new Uint8Array([1, 2, 3]))).toBe(3);
    expect(appendTrack(takeId, 'screen.mp4', new Uint8Array([4]))).toBe(4);
    appendTrack(takeId, 'mic-1.wav', new Uint8Array(960));
    // "crash" here: file must already be a consistent WAV
    let wav = readFileSync(join(takeDir, 'mic-1.wav'));
    expect(wav.length).toBe(44 + 960);
    expect(wav.readUInt32LE(40)).toBe(960);
    expect(wav.readUInt32LE(4)).toBe(36 + 960);
    appendTrack(takeId, 'mic-1.wav', new Uint8Array(40));
    wav = readFileSync(join(takeDir, 'mic-1.wav'));
    expect(wav.readUInt32LE(40)).toBe(1000);
    expect([...readFileSync(join(takeDir, 'screen.mp4'))]).toEqual([1, 2, 3, 4]);
    writeTakeMeta(takeId, { schema: 1, id: takeId, createdAt: 'x', timeOrigin: 1, startedAtMs: 2, tracks: [], markers: [], app: { version: '0', os: 'mac' }, complete: false });
    expect(JSON.parse(readFileSync(join(takeDir, 'take.json'), 'utf8')).id).toBe(takeId);
    expect(closeTrack(takeId, 'screen.mp4')).toBe(4);
    endTake(takeId);
    expect(activeTakes()).toBe(0);
  });

  it('handles subarray views (byteOffset) correctly', () => {
    const { takeId, takeDir } = beginTake(dir);
    openTrack({ takeId, file: 'camera-1.webm', kind: 'camera' });
    const big = new Uint8Array([9, 9, 1, 2, 9]);
    appendTrack(takeId, 'camera-1.webm', big.subarray(2, 4));
    endTake(takeId);
    expect([...readFileSync(join(takeDir, 'camera-1.webm'))]).toEqual([1, 2]);
  });

  it('rejects unsafe or duplicate track names and unknown takes', () => {
    const { takeId } = beginTake(dir);
    for (const bad of ['../x.mp4', 'screen.exe', 'a/screen.mp4', 'camera-x.webm', 'take.json']) {
      expect(() => openTrack({ takeId, file: bad, kind: 'screen' })).toThrow();
    }
    openTrack({ takeId, file: 'system.wav', kind: 'system' });
    expect(() => openTrack({ takeId, file: 'system.wav', kind: 'system' })).toThrow(/already/);
    expect(() => appendTrack(takeId, 'screen.mp4', new Uint8Array(1))).toThrow(/not open/);
    expect(() => appendTrack('take_nope', 'screen.mp4', new Uint8Array(1))).toThrow(/unknown take/);
    endTake(takeId);
    expect(existsSync(join(dir, 'media', 'takes', takeId, '..', '..', 'x.mp4'))).toBe(false);
  });

  it('two takes in the same second get distinct folders', () => {
    const a = beginTake(dir);
    const b = beginTake(dir);
    expect(a.takeDir).not.toBe(b.takeDir);
    endTake(a.takeId);
    endTake(b.takeId);
  });
});

describe('pcm helpers', () => {
  it('prefers mp4/avc1, then webm vp9', () => {
    expect(pickVideoMime(() => true)).toEqual({ mime: 'video/mp4;codecs=avc1', ext: 'mp4' });
    expect(pickVideoMime((m) => m.startsWith('video/webm;codecs=vp9'))).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' });
    expect(pickVideoMime(() => false)).toEqual({ mime: '', ext: 'webm' });
  });
  it('interleaves and clamps to int16', () => {
    const out = toInt16Interleaved([new Float32Array([0, 1, -1, 2]), new Float32Array([0.5, -0.5, 0, -2])]);
    const v = new DataView(out.buffer);
    const s = Array.from({ length: 8 }, (_, i) => v.getInt16(i * 2, true));
    expect(s).toEqual([0, 16384, 32767, -16384, -32768, 0, 32767, -32768]);
    expect(toInt16Interleaved([]).byteLength).toBe(0);
  });
});

describe('crash report scrubbing', () => {
  it('replaces the home dir and absolute paths', () => {
    expect(scrubString('ENOENT /Users/taro/Movies/secret-project/timeline.json', '/Users/taro')).toBe('ENOENT <path>/timeline.json');
    expect(scrubString('at C:\\Users\\taro\\AppData\\x\\main.js:1', 'C:\\Users\\taro')).not.toMatch(/taro/);
    expect(scrubString('open /home/u/a/b.mp4 failed', '/nothome')).toBe('open <path>/b.mp4 failed');
    expect(scrubString('plain message', '/Users/taro')).toBe('plain message');
  });
  it('deep-scrubs nested events', () => {
    const ev = { message: '/Users/taro/x/y.mp4', extra: { list: ['/Users/taro/z'] }, n: 1 };
    const out = scrubDeep(ev, '/Users/taro');
    expect(JSON.stringify(out)).not.toMatch(/taro/);
    expect(out.n).toBe(1);
  });
});
