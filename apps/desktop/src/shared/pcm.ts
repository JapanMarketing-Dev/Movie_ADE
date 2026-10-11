// Pure helpers for the recorder (renderer), kept here so they can be unit-tested under Node.

/** Preferred MediaRecorder container/codec: fragmented MP4 (H.264) if supported, else WebM VP9. */
export function pickVideoMime(isSupported: (m: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } {
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.640028', 'video/mp4']) if (isSupported(m)) return { mime: m, ext: 'mp4' };
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (isSupported(m)) return { mime: m, ext: 'webm' };
  return { mime: '', ext: 'webm' };
}

/** Float32 planar channels -> interleaved little-endian Int16 PCM. Clamps to [-1, 1]. */
export function toInt16Interleaved(chs: Float32Array[]): Uint8Array {
  const n = chs[0]?.length ?? 0;
  const c = chs.length;
  const out = new DataView(new ArrayBuffer(n * c * 2));
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      const v = Math.max(-1, Math.min(1, chs[k]![i] ?? 0));
      out.setInt16(o, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
      o += 2;
    }
  }
  return new Uint8Array(out.buffer);
}
