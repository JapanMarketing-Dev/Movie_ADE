// Maps an AudioContext time (seconds, the worklet's currentTime) onto the performance.now() clock that the video
// tracks use (take.json firstFrameMs). getOutputTimestamp() is the precise mapping, but it is {0, 0} (or undefined)
// until the context has produced output, which is exactly when the first sample arrives; then the context's
// currentTime read together with performance.now() is used instead.

export interface OutputTimestamp {
  contextTime?: number;
  performanceTime?: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * performance.now() ms of context time `t`. `ts` = ctx.getOutputTimestamp(), `nowMs` = performance.now() and
 * `currentTime` = ctx.currentTime, both read when the worklet's message arrives. Undefined when nothing usable.
 */
export function contextTimeToPerfMs(t: number, ts: OutputTimestamp | null | undefined, nowMs: number, currentTime: number): number | undefined {
  if (!finite(t)) return undefined;
  if (ts && finite(ts.performanceTime) && finite(ts.contextTime) && ts.performanceTime > 0 && ts.contextTime > 0) {
    const v = ts.performanceTime + (t - ts.contextTime) * 1000;
    // a mapping that lands in the future or before the page existed is stale; fall back
    if (v >= 0 && v <= nowMs + 1) return v;
  }
  if (!finite(nowMs) || !finite(currentTime)) return undefined;
  // the message is handled after the sample was rendered, so currentTime >= t; clamp clock jitter
  const v = nowMs - Math.max(0, currentTime - t) * 1000;
  return v >= 0 ? v : undefined;
}
