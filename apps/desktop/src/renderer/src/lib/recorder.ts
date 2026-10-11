// Recording engine. Lives at module level (not in React) so a take keeps running while the user switches
// screens. Every source gets its own MediaRecorder / AudioWorklet and its own file; chunks go to main every
// second and are appended to disk immediately (crash-safe). take.json is rewritten on start, on every marker
// and on stop.
import type { TakeMarker, TakeMeta, TakeTrackMeta } from '@shared/types';
import { pickVideoMime } from '@shared/pcm';
import { api } from './api';
import { SAMPLE_RATE, ensureWorklet, startPcmCapture } from './pcm-capture';

export interface CameraChoice {
  deviceId: string;
  label: string;
  width: number;
  height: number;
  fps: number;
}

export interface Sources {
  screen: MediaStream | null;
  screenSourceId: string | null; // desktopCapturer id, for the cursor log's display
  screenFps: number;
  cameras: { choice: CameraChoice; stream: MediaStream }[];
  mic: { deviceId: string; label: string; stream: MediaStream } | null;
}

export type RecState = 'idle' | 'recording' | 'stopping';
export interface RecStatus {
  state: RecState;
  takeId?: string;
  startedAtMs?: number;
  markers: TakeMarker[];
  bytes: number;
  error?: string;
  lastTakeDir?: string;
}

type Listener = (s: RecStatus) => void;

const CHUNK_MS = 1000;

interface Writer {
  file: string;
  queue: Promise<unknown>;
  meta: TakeTrackMeta;
  stop: () => Promise<void>;
}

class Recorder {
  private status: RecStatus = { state: 'idle', markers: [], bytes: 0 };
  private listeners = new Set<Listener>();
  private writers: Writer[] = [];
  private meta: TakeMeta | null = null;
  private audioCtx: AudioContext | null = null;
  private metaTimer: number | null = null;

  constructor() {
    api.on('record:hotkey', (kind) => this.mark(kind));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.status);
    return () => this.listeners.delete(l);
  }

  get(): RecStatus {
    return this.status;
  }

  private set(p: Partial<RecStatus>): void {
    this.status = { ...this.status, ...p };
    for (const l of this.listeners) l(this.status);
  }

  async start(projectDir: string, src: Sources, systemAudio: boolean, appVersion: string, os: string): Promise<void> {
    if (this.status.state !== 'idle') return;
    const { takeId, takeDir } = await api.invoke('record:begin', projectDir);
    const now = performance.now();
    this.meta = {
      schema: 1,
      id: takeId,
      createdAt: new Date().toISOString(),
      timeOrigin: performance.timeOrigin,
      startedAtMs: now,
      tracks: [],
      markers: [],
      app: { version: appVersion, os },
      complete: false,
    };
    this.writers = [];
    this.set({ state: 'recording', takeId, startedAtMs: now, markers: [], bytes: 0, error: undefined, lastTakeDir: takeDir });
    try {
      if (src.screen) {
        // cursor.jsonl at 30 Hz on the take clock (epoch of timeOrigin + startedAtMs)
        this.meta.cursor = await api.invoke('record:cursorStart', takeId, src.screenSourceId, performance.timeOrigin + now);
      }
      const { mime, ext } = pickVideoMime((m) => MediaRecorder.isTypeSupported(m));
      if (src.screen) {
        const v = src.screen.getVideoTracks()[0];
        if (v) await this.startVideo(takeId, `screen.${ext}`, 'screen', new MediaStream([v]), mime, { fps: src.screenFps });
        const a = src.screen.getAudioTracks()[0];
        if (a && systemAudio) await this.startAudio(takeId, 'system.wav', 'system', new MediaStream([a]), 'system');
      }
      let i = 1;
      for (const cam of src.cameras) {
        const v = cam.stream.getVideoTracks()[0];
        if (!v) continue;
        await this.startVideo(takeId, `camera-${i}.${ext}`, 'camera', new MediaStream([v]), mime, {
          device: cam.choice.deviceId,
          label: cam.choice.label,
          fps: cam.choice.fps,
        });
        i++;
      }
      if (src.mic) await this.startAudio(takeId, 'mic-1.wav', 'mic', src.mic.stream, src.mic.label, src.mic.deviceId);
      if (this.writers.length === 0) throw new Error('no sources selected');
      await this.writeMeta();
      this.metaTimer = window.setInterval(() => void this.writeMeta(), 5000);
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
      await this.stop();
      throw e;
    }
  }

  private append(w: Writer, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const takeId = this.status.takeId!;
    w.queue = w.queue
      .then(() => api.invoke('record:append', takeId, w.file, data))
      .then((bytes) => {
        w.meta.bytes = bytes;
        this.set({ bytes: this.writers.reduce((s, x) => s + (x.meta.bytes ?? 0), 0) });
      })
      .catch((e: unknown) => this.set({ error: e instanceof Error ? e.message : String(e) }));
  }

  private async startVideo(
    takeId: string,
    file: string,
    kind: 'screen' | 'camera',
    stream: MediaStream,
    mime: string,
    extra: { device?: string; label?: string; fps?: number },
  ): Promise<void> {
    await api.invoke('record:openTrack', { takeId, file, kind });
    const track = stream.getVideoTracks()[0]!;
    const s = track.getSettings();
    const meta: TakeTrackMeta = { file, kind, mimeType: mime || undefined, width: s.width, height: s.height, fps: s.frameRate ?? extra.fps };
    if (extra.device) meta.device = extra.device;
    if (extra.label) meta.label = extra.label;
    const rec = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: kind === 'screen' ? 12_000_000 : 10_000_000,
    });
    const w: Writer = { file, queue: Promise.resolve(), meta, stop: async () => undefined };
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) void ev.data.arrayBuffer().then((b) => this.append(w, new Uint8Array(b)));
    };
    const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
    rec.onstart = () => (meta.recorderStartMs = performance.now());
    w.stop = async () => {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      // the last dataavailable fires before stop; let its arrayBuffer() resolve and queue the append
      await new Promise((r) => setTimeout(r, 50));
      await w.queue;
      await api.invoke('record:closeTrack', takeId, file);
    };
    this.writers.push(w);
    this.meta!.tracks.push(meta);
    void firstFrameTime(track).then((t) => {
      if (t) {
        meta.firstFrameMs = t.perfMs;
        if (t.timestampUs !== undefined) meta.firstFrameTimestampUs = t.timestampUs;
      }
    });
    rec.start(CHUNK_MS);
  }

  private async startAudio(takeId: string, file: string, kind: 'mic' | 'system', stream: MediaStream, label: string, device?: string): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const ctx = (this.audioCtx ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }));
    await ensureWorklet(ctx);
    const channels = Math.min(2, Math.max(1, track.getSettings().channelCount ?? 1));
    await api.invoke('record:openTrack', { takeId, file, kind, wav: { sampleRate: ctx.sampleRate, channels } });
    const meta: TakeTrackMeta = { file, kind, label, sampleRate: ctx.sampleRate, channels };
    if (device) meta.device = device;
    const w: Writer = { file, queue: Promise.resolve(), meta, stop: async () => undefined };
    meta.recorderStartMs = performance.now();
    const cap = await startPcmCapture(ctx, track, (pcm) => this.append(w, pcm), { maxChannels: channels });
    w.stop = async () => {
      cap.stop();
      const f = cap.firstSampleMs();
      if (f !== undefined) meta.firstFrameMs = f;
      await w.queue;
      await api.invoke('record:closeTrack', takeId, file);
    };
    this.writers.push(w);
    this.meta!.tracks.push(meta);
  }

  mark(kind: 'ng' | 'important'): void {
    if (this.status.state !== 'recording' || !this.meta) return;
    const at = performance.now();
    const m: TakeMarker = { kind, atMs: at, sinceStartMs: at - this.meta.startedAtMs };
    this.meta.markers.push(m);
    this.set({ markers: [...this.meta.markers] });
    void this.writeMeta();
  }

  private async writeMeta(): Promise<void> {
    if (!this.meta || !this.status.takeId) return;
    try {
      await api.invoke('record:writeMeta', this.status.takeId, this.meta);
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  async stop(): Promise<void> {
    if (this.status.state !== 'recording') return;
    this.set({ state: 'stopping' });
    if (this.metaTimer !== null) window.clearInterval(this.metaTimer);
    this.metaTimer = null;
    await Promise.allSettled(this.writers.map((w) => w.stop()));
    if (this.meta) {
      this.meta.stoppedAtMs = performance.now();
      this.meta.complete = true;
      await this.writeMeta();
    }
    if (this.status.takeId) await api.invoke('record:end', this.status.takeId).catch(() => undefined);
    if (this.audioCtx) {
      await this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.writers = [];
    this.meta = null;
    this.set({ state: 'idle' });
  }
}

/** First frame time on the performance.now() clock, via MediaStreamTrackProcessor when available. */
async function firstFrameTime(track: MediaStreamTrack): Promise<{ perfMs: number; timestampUs?: number } | null> {
  const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } })
    .MediaStreamTrackProcessor;
  if (!MSTP) return { perfMs: performance.now() };
  const clone = track.clone();
  try {
    const reader = new MSTP({ track: clone }).readable.getReader();
    const r = await reader.read();
    const perfMs = performance.now();
    const ts = r.value?.timestamp;
    r.value?.close();
    void reader.cancel();
    return ts !== undefined && ts !== null ? { perfMs, timestampUs: ts } : { perfMs };
  } catch {
    return { perfMs: performance.now() };
  } finally {
    clone.stop();
  }
}

export const recorder = new Recorder();
