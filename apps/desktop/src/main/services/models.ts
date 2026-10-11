// Analysis models, downloaded on demand from their official locations into ~/.solocut/tools/{mediapipe,tesseract}
// with pinned URLs and sha256 (never bundled). A file is used only after its hash matches.
import { net } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { home } from './platform';

export interface ModelFile {
  id: string;
  dir: 'mediapipe' | 'tesseract';
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export const MODELS: Record<'face' | 'jpn' | 'eng', ModelFile> = {
  face: {
    id: 'face',
    dir: 'mediapipe',
    name: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
    size: 229746,
  },
  jpn: {
    id: 'jpn',
    dir: 'tesseract',
    name: 'jpn.traineddata.gz',
    url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz',
    sha256: '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88',
    size: 2030256,
  },
  eng: {
    id: 'eng',
    dir: 'tesseract',
    name: 'eng.traineddata.gz',
    url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    size: 2952873,
  },
};

export function modelDir(dir: ModelFile['dir']): string {
  return join(home(), 'tools', dir);
}

export function modelPath(m: ModelFile): string {
  return join(modelDir(m.dir), m.name);
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const verified = new Set<string>();

/** Returns the local path, downloading and verifying it first if needed. */
export async function ensureModel(m: ModelFile, onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  const path = modelPath(m);
  if (verified.has(path)) return path;
  if (existsSync(path) && (await sha256File(path)) === m.sha256) {
    verified.add(path);
    return path;
  }
  mkdirSync(modelDir(m.dir), { recursive: true });
  const part = `${path}.part`;
  const r = await net.fetch(m.url, signal ? { signal } : {});
  if (!r.ok || !r.body) throw new Error(`${m.name}: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || m.size;
  const h = createHash('sha256');
  const fh = await open(part, 'w');
  let received = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      h.update(value);
      await fh.write(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
  } finally {
    await fh.close();
  }
  if (h.digest('hex') !== m.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${m.name}: sha256 mismatch`);
  }
  renameSync(part, path);
  verified.add(path);
  return path;
}
