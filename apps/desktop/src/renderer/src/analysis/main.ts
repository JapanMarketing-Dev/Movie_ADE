// Hidden analysis window (see main/services/analysis.ts): pulls jobs from main, seeks through the source video and
// runs MediaPipe face detection (cameras, 5 fps) or tesseract.js OCR + PII patterns (screens, 1 fps, changed
// frames only). Results go back to main, which writes derived/analysis/*.json.
import { FaceDetector } from '@mediapipe/tasks-vision';
import { createWorker, type Worker as TessWorker } from 'tesseract.js';
import visionLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import visionWasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import tessWorkerUrl from 'tesseract.js/dist/worker.min.js?url';
import tessCoreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import type { AnalysisJob } from '@shared/types';
import { mediaUrl } from '@shared/ipc';
import { findPii, frameDiff, sampleTimes, toGray, toPiiBoxes, type FacesFile, type OcrWord, type PiiBox, type PiiFile } from '@shared/analysis';

const api = window.solocut;
const CHANGE_THRESHOLD = 0.012;

/** Asset URL usable from workers / fetch: in the packaged app (file://) go through solocut-media://. */
function loadable(u: string): string {
  const abs = new URL(u, location.href);
  if (abs.protocol !== 'file:') return abs.toString();
  let p = decodeURIComponent(abs.pathname);
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows drive paths
  return mediaUrl(p);
}

function openVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error(`cannot open video (${v.error?.message ?? v.error?.code ?? 'unknown'})`));
    v.src = url;
  });
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) return resolve();
    const done = () => {
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

function canvasFor(v: HTMLVideoElement, maxW: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const scale = Math.min(1, maxW / (v.videoWidth || maxW));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((v.videoWidth || 1280) * scale));
  c.height = Math.max(1, Math.round((v.videoHeight || 720) * scale));
  return { c, g: c.getContext('2d', { willReadFrequently: true })! };
}

let faceDetector: FaceDetector | null = null;
async function faces(job: AnalysisJob): Promise<FacesFile> {
  if (!job.model) throw new Error('face model missing');
  faceDetector ??= await FaceDetector.createFromOptions(
    { wasmLoaderPath: loadable(visionLoaderUrl), wasmBinaryPath: loadable(visionWasmUrl) },
    { baseOptions: { modelAssetBuffer: job.model, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 },
  );
  const v = await openVideo(job.url);
  const { c, g } = canvasFor(v, 640);
  const times = sampleTimes(v.duration, job.sampleFps);
  const out: FacesFile = { schema: 1, source: job.sourceId, fps: job.sampleFps, sourceFps: job.sourceFps, width: job.width, height: job.height, frames: [] };
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    await seek(v, t);
    g.drawImage(v, 0, 0, c.width, c.height);
    const res = faceDetector.detect(c);
    const r = (n: number) => Math.round(n * 10000) / 10000;
    out.frames.push({
      f: Math.round(t * job.sourceFps),
      t,
      faces: res.detections
        .filter((d) => d.boundingBox)
        .map((d) => {
          const b = d.boundingBox!;
          return { x: r(b.originX / c.width), y: r(b.originY / c.height), w: r(b.width / c.width), h: r(b.height / c.height), score: r(d.categories[0]?.score ?? 0) };
        }),
    });
    if (i % 5 === 0) api.send('analysis:progress', job.id, (i + 1) / times.length);
  }
  return out;
}

let tess: TessWorker | null = null;
async function ocr(job: AnalysisJob): Promise<PiiFile> {
  tess ??= await createWorker(job.langs ?? ['jpn', 'eng'], 1, {
    workerPath: loadable(tessWorkerUrl),
    corePath: loadable(tessCoreUrl),
    langPath: job.langPath,
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: true,
  });
  const v = await openVideo(job.url);
  const { c, g } = canvasFor(v, 1920);
  const thumb = document.createElement('canvas');
  thumb.width = 64;
  thumb.height = 36;
  const tg = thumb.getContext('2d', { willReadFrequently: true })!;
  const times = sampleTimes(v.duration, job.sampleFps);
  const out: PiiFile = { schema: 1, source: job.sourceId, fps: job.sampleFps, sourceFps: job.sourceFps, width: job.width, height: job.height, frames: [] };
  let lastGray: Uint8Array | null = null;
  let lastBoxes: PiiBox[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    await seek(v, t);
    tg.drawImage(v, 0, 0, thumb.width, thumb.height);
    const gray = toGray(tg.getImageData(0, 0, thumb.width, thumb.height).data);
    const changed = !lastGray || frameDiff(gray, lastGray) > CHANGE_THRESHOLD;
    if (changed) {
      g.drawImage(v, 0, 0, c.width, c.height);
      const { data } = await tess.recognize(c, {}, { blocks: true, text: false });
      const lines: OcrWord[][] = [];
      for (const b of data.blocks ?? []) {
        for (const p of b.paragraphs) {
          for (const l of p.lines) {
            lines.push(
              l.words.map((w) => ({
                text: w.text,
                confidence: w.confidence,
                box: { x: w.bbox.x0 / c.width, y: w.bbox.y0 / c.height, w: (w.bbox.x1 - w.bbox.x0) / c.width, h: (w.bbox.y1 - w.bbox.y0) / c.height },
              })),
            );
          }
        }
      }
      lastBoxes = toPiiBoxes(findPii(lines));
      lastGray = gray;
    }
    out.frames.push({ f: Math.round(t * job.sourceFps), t, changed, boxes: lastBoxes });
    api.send('analysis:progress', job.id, (i + 1) / times.length);
  }
  return out;
}

async function loop(): Promise<void> {
  for (;;) {
    const job = await api.invoke('analysis:nextJob');
    if (!job) break;
    try {
      const result = job.kind === 'faces' ? await faces(job) : await ocr(job);
      await api.invoke('analysis:result', job.id, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : e instanceof Event ? `${e.type} on ${(e.target as { src?: string } | null)?.src ?? 'resource'}` : String(e);
      console.error(`analysis ${job.id}:`, msg);
      await api.invoke('analysis:fail', job.id, msg);
    }
  }
  await tess?.terminate().catch(() => undefined);
  faceDetector?.close();
}

void loop();
