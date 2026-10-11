// Raw PCM capture via AudioWorklet (no compression, no browser processing). Used by the take recorder and by
// video feedback. Delivers interleaved Int16 chunks about once per second.
import { toInt16Interleaved } from '@shared/pcm';
import { contextTimeToPerfMs } from '@shared/audioClock';
import workletSource from './pcm-worklet.js?raw';

export const SAMPLE_RATE = 48000;
const loaded = new WeakSet<AudioContext>();

export async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (loaded.has(ctx)) return;
  // Loaded from a blob URL: worklet module fetches from file:// are not reliable in packaged apps.
  const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    loaded.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface PcmCapture {
  channels: number;
  sampleRate: number;
  /** performance.now() of the first sample, once known */
  firstSampleMs: () => number | undefined;
  stop: () => void;
}

export async function startPcmCapture(
  ctx: AudioContext,
  track: MediaStreamTrack,
  onChunk: (pcm: Uint8Array) => void,
  o: { maxChannels?: number; flushMs?: number } = {},
): Promise<PcmCapture> {
  await ensureWorklet(ctx);
  const channels = Math.min(o.maxChannels ?? 2, Math.max(1, track.getSettings().channelCount ?? 1));
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: channels, channelCountMode: 'explicit' });
  // keep the node pulled by the graph without making it audible
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute).connect(ctx.destination);
  let first: number | undefined;
  let pending: Uint8Array[] = [];
  let bytes = 0;
  const flush = () => {
    if (bytes === 0) return;
    const out = new Uint8Array(bytes);
    let off = 0;
    for (const p of pending) {
      out.set(p, off);
      off += p.byteLength;
    }
    pending = [];
    bytes = 0;
    onChunk(out);
  };
  node.port.onmessage = (ev: MessageEvent<{ first?: boolean; t?: number; data?: Float32Array[] }>) => {
    const m = ev.data;
    if (m.first && m.t !== undefined) {
      first = contextTimeToPerfMs(m.t, ctx.getOutputTimestamp(), performance.now(), ctx.currentTime);
      return;
    }
    if (m.data && m.data.length > 0) {
      const pcm = toInt16Interleaved(m.data.slice(0, channels));
      pending.push(pcm);
      bytes += pcm.byteLength;
    }
  };
  const timer = window.setInterval(flush, o.flushMs ?? 1000);
  return {
    channels,
    sampleRate: ctx.sampleRate,
    firstSampleMs: () => first,
    stop: () => {
      window.clearInterval(timer);
      src.disconnect();
      node.disconnect();
      mute.disconnect();
      node.port.onmessage = null;
      flush();
    },
  };
}
