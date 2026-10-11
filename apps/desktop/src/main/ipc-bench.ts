// IPC handlers of the reference videos (channels in shared/ipc-bench.ts). `handle` and `emit` are passed in like
// ipc-accounts.ts. Arguments come from the renderer and are checked here.
import { dialog, type BrowserWindow } from 'electron';
import { isAbsolute } from 'node:path';
import { normalizeRange, type BenchScope } from '../shared/benchmark';
import type { BenchEventChannel, BenchEventMap, BenchInvokeChannel, BenchInvokeMap } from '../shared/ipc-bench';
import * as bench from './services/benchmark';
import { armCapture, closeReference, openReference, playerSample } from './services/benchWindow';

export type BenchHandle = <C extends BenchInvokeChannel>(
  channel: C,
  fn: (...args: BenchInvokeMap[C]['args']) => BenchInvokeMap[C]['result'] | Promise<BenchInvokeMap[C]['result']>,
) => void;
export type BenchEmit = <C extends BenchEventChannel>(channel: C, ...args: BenchEventMap[C]) => void;

const MAX_CHUNK = 64 * 1024 * 1024;

const dirArg = (v: unknown): string | undefined => (typeof v === 'string' && isAbsolute(v) ? v : undefined);

export function registerBenchIpc(o: {
  handle: BenchHandle;
  emit: BenchEmit;
  run: bench.RunCli;
  window: () => BrowserWindow | null;
  isProject: (dir: string) => boolean;
  templateOf: (dir: string | undefined) => string;
}): void {
  const { handle, emit } = o;
  const project = (v: unknown) => {
    const d = dirArg(v);
    return d && o.isProject(d) ? d : undefined;
  };
  handle('bench:list', (dir) => bench.benchState(project(dir)));
  handle('bench:chooseFile', async () => {
    const w = o.window();
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('bench:open', (url) => (typeof url === 'string' ? openReference(url, () => emit('bench:closed')) : { ok: false, error: 'invalid' }));
  handle('bench:close', () => closeReference());
  handle('bench:player', () => playerSample());
  handle('bench:captureArm', () => armCapture());
  handle('bench:captureBegin', () => bench.captureBegin());
  handle('bench:captureAppend', (id, data) => {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_CHUNK) throw new Error('bad chunk');
    return bench.captureAppend(id, data);
  });
  handle('bench:captureEnd', (id) => bench.captureEnd(id));
  handle('bench:captureDiscard', (id) => bench.captureDiscard(id));
  handle('bench:analyze', (req) => {
    const r = req && typeof req === 'object' ? req : {};
    return bench.analyze(
      {
        ...(typeof r.captureId === 'string' ? { captureId: r.captureId } : {}),
        ...(typeof r.file === 'string' ? { file: r.file } : {}),
        ...(typeof r.url === 'string' && /^https:\/\//.test(r.url) ? { url: r.url } : {}),
        ...(r.range && typeof r.range === 'object' ? { range: normalizeRange(r.range) } : {}),
      },
      o.run,
      (f, label) => emit('bench:progress', f, label),
    );
  });
  handle('bench:apply', (id, scope, dir) => {
    if (typeof id !== 'string' || (scope !== 'project' && scope !== 'global')) return { ok: false, error: 'invalid' };
    const d = project(dir);
    return bench.apply({ id, scope: scope as BenchScope, ...(d ? { projectDir: d } : {}), template: o.templateOf(scope === 'project' ? d : undefined) }, o.run);
  });
  handle('bench:unapply', (scope, dir) => {
    if (scope !== 'project' && scope !== 'global') return { ok: false, error: 'invalid' };
    const d = project(dir);
    return bench.unapply({ scope, ...(d ? { projectDir: d } : {}), template: o.templateOf(scope === 'project' ? d : undefined) }, o.run);
  });
}
