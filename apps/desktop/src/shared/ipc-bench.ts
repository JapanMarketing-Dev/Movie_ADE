// IPC channels of the reference videos ("お手本動画", docs/09). Same shape as shared/ipc.ts; merged into the registry
// there (BenchInvokeMap into InvokeMap, BenchEventMap into EventMap, the names into the `invoke` / `events` records).
import type { BenchEntry, BenchRange, BenchScope, BenchState, PlayerSample } from './benchmark';

export interface BenchAnalyzeRequest {
  /** a local video the user picked */
  file?: string;
  /** a recording of the reference window (bench:captureBegin) */
  captureId?: string;
  url?: string;
  range?: BenchRange;
}

/** renderer -> main (ipcRenderer.invoke) */
export interface BenchInvokeMap {
  /** saved profiles and which one is applied (globally / to the project `dir`) */
  'bench:list': { args: [dir?: string]; result: BenchState };
  /** file dialog for a local reference video */
  'bench:chooseFile': { args: []; result: string | null };
  /** opens the reference window (in-app browser, the platform's own player; the user plays it) */
  'bench:open': { args: [url: string]; result: { ok: boolean; error?: string } };
  'bench:close': { args: []; result: void };
  /** the reference player's position (null when the window is closed or no video is found) */
  'bench:player': { args: []; result: PlayerSample | null };
  /** the next getDisplayMedia() of the app window captures the reference window (video + its audio) */
  'bench:captureArm': { args: []; result: { ok: boolean; error?: string } };
  /** a temp file for the recording; removed after analysis or by bench:captureDiscard */
  'bench:captureBegin': { args: []; result: { id: string } };
  'bench:captureAppend': { args: [id: string, data: Uint8Array]; result: number };
  'bench:captureEnd': { args: [id: string]; result: { bytes: number } };
  'bench:captureDiscard': { args: [id: string]; result: void };
  /** `solocut bench analyze` (progress on bench:progress); a capture's temp file is deleted afterwards */
  'bench:analyze': { args: [req: BenchAnalyzeRequest]; result: { ok: boolean; entry?: BenchEntry; error?: string } };
  /** `solocut bench apply` to this video's template or to every video's */
  'bench:apply': { args: [id: string, scope: BenchScope, dir?: string]; result: { ok: boolean; error?: string; state?: BenchState } };
  /** `solocut bench unapply`: stop using the reference for this video or for every video */
  'bench:unapply': { args: [scope: BenchScope, dir?: string]; result: { ok: boolean; error?: string; state?: BenchState } };
}

/** main -> renderer events */
export interface BenchEventMap {
  'bench:progress': [fraction: number, label: string];
  /** the reference window was closed */
  'bench:closed': [];
}

export type BenchInvokeChannel = keyof BenchInvokeMap;
export type BenchEventChannel = keyof BenchEventMap;

const invoke: Record<BenchInvokeChannel, true> = {
  'bench:list': true, 'bench:chooseFile': true, 'bench:open': true, 'bench:close': true, 'bench:player': true,
  'bench:captureArm': true, 'bench:captureBegin': true, 'bench:captureAppend': true, 'bench:captureEnd': true,
  'bench:captureDiscard': true, 'bench:analyze': true, 'bench:apply': true, 'bench:unapply': true,
};
const events: Record<BenchEventChannel, true> = { 'bench:progress': true, 'bench:closed': true };

export const BENCH_INVOKE_CHANNELS = Object.freeze(Object.keys(invoke) as BenchInvokeChannel[]);
export const BENCH_EVENT_CHANNELS = Object.freeze(Object.keys(events) as BenchEventChannel[]);
