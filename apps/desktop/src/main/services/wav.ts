// Minimal PCM WAV header writing, used for crash-safe incremental recording: the header is written first with
// sizes for the data so far and patched after every append, so the file is playable at any moment.

export const WAV_HEADER_BYTES = 44;

export function wavHeader(o: { sampleRate: number; channels: number; bitsPerSample: 16 | 32; float?: boolean; dataBytes: number }): Buffer {
  const b = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = (o.channels * o.bitsPerSample) / 8;
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(Math.min(0xffffffff, 36 + o.dataBytes), 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(o.float ? 3 : 1, 20);
  b.writeUInt16LE(o.channels, 22);
  b.writeUInt32LE(o.sampleRate, 24);
  b.writeUInt32LE(o.sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(o.bitsPerSample, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(Math.min(0xffffffff, o.dataBytes), 40);
  return b;
}

/** The two size fields to patch after appending: [offset, value][]. */
export function wavSizePatches(dataBytes: number): [number, number][] {
  return [
    [4, Math.min(0xffffffff, 36 + dataBytes)],
    [40, Math.min(0xffffffff, dataBytes)],
  ];
}
