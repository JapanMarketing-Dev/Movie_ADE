// Main-process side of recording: creates media/takes/<takeId>/, appends chunks as they arrive (every ~1s)
// with fsync-free appends, keeps WAV headers valid after every append and writes take.json. If the app
// crashes mid-take, everything up to the last chunk is on disk and playable.
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync, renameSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { TakeMeta, TrackOpen } from '../../shared/types';
import { WAV_HEADER_BYTES, wavHeader, wavSizePatches } from './wav';

interface Track {
  fd: number;
  bytes: number; // payload bytes (excluding WAV header)
  wav: boolean;
}
interface Take {
  dir: string;
  tracks: Map<string, Track>;
}

const takes = new Map<string, Take>();

export function newTakeId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `take_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

const SAFE_FILE = /^(screen|camera-\d+|mic-\d+|system)\.(mp4|webm|wav)$/;

export function beginTake(projectDir: string): { takeId: string; takeDir: string } {
  let takeId = newTakeId();
  let dir = join(projectDir, 'media', 'takes', takeId);
  for (let i = 2; existsSync(dir); i++) {
    takeId = `${newTakeId()}-${i}`;
    dir = join(projectDir, 'media', 'takes', takeId);
  }
  mkdirSync(dir, { recursive: true });
  takes.set(takeId, { dir, tracks: new Map() });
  return { takeId, takeDir: dir };
}

function take(id: string): Take {
  const t = takes.get(id);
  if (!t) throw new Error(`unknown take ${id}`);
  return t;
}

export function openTrack(o: TrackOpen): void {
  const t = take(o.takeId);
  if (!SAFE_FILE.test(o.file) || basename(o.file) !== o.file) throw new Error(`bad track file name: ${o.file}`);
  if (t.tracks.has(o.file)) throw new Error(`track already open: ${o.file}`);
  const fd = openSync(join(t.dir, o.file), 'w');
  const wav = o.file.endsWith('.wav');
  if (wav) {
    const wo = o.wav ?? { sampleRate: 48000, channels: 1 };
    writeSync(fd, wavHeader({ sampleRate: wo.sampleRate, channels: wo.channels, bitsPerSample: 16, dataBytes: 0 }), 0, WAV_HEADER_BYTES, 0);
  }
  t.tracks.set(o.file, { fd, bytes: 0, wav });
}

export function appendTrack(takeId: string, file: string, data: Uint8Array): number {
  const tr = take(takeId).tracks.get(file);
  if (!tr) throw new Error(`track not open: ${file}`);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const pos = (tr.wav ? WAV_HEADER_BYTES : 0) + tr.bytes;
  let off = 0;
  while (off < buf.length) off += writeSync(tr.fd, buf, off, buf.length - off, pos + off);
  tr.bytes += buf.length;
  if (tr.wav) {
    const b = Buffer.alloc(4);
    for (const [at, v] of wavSizePatches(tr.bytes)) {
      b.writeUInt32LE(v, 0);
      writeSync(tr.fd, b, 0, 4, at);
    }
  }
  return tr.bytes;
}

export function closeTrack(takeId: string, file: string): number {
  const t = take(takeId);
  const tr = t.tracks.get(file);
  if (!tr) return 0;
  try {
    fsyncSync(tr.fd);
  } catch {
    /* best effort */
  }
  closeSync(tr.fd);
  t.tracks.delete(file);
  return tr.bytes;
}

export function writeTakeMeta(takeId: string, meta: TakeMeta): void {
  const t = take(takeId);
  const p = join(t.dir, 'take.json');
  writeFileSync(`${p}.tmp`, JSON.stringify(meta, null, 2) + '\n');
  renameSync(`${p}.tmp`, p);
}

export function endTake(takeId: string): void {
  const t = takes.get(takeId);
  if (!t) return;
  for (const file of [...t.tracks.keys()]) closeTrack(takeId, file);
  takes.delete(takeId);
}

export function activeTakes(): number {
  return takes.size;
}

export function endAll(): void {
  for (const id of [...takes.keys()]) endTake(id);
}
