// Entry point for reporting failures that are caught and survived (catch + fallback). Ported from Ferret
// (src/shared/report.ts, MIT). main and renderer can both call it; it does nothing until telemetry plugs in a
// reporter (crash reports off, unit tests). Only the error and where it happened (area / op) are sent; paths and
// URLs are removed by the telemetry scrubber.

export type ReportArea =
  | 'terminal' | 'pty' | 'agent-launch' | 'recording' | 'review' | 'files' | 'usage' | 'accounts' | 'failover'
  | 'update' | 'settings' | 'analysis' | 'publish' | 'startup' | 'ui';

export interface ReportWhere {
  area: ReportArea;
  /** what was being done: a short English verb phrase without variable values ('read settings') */
  op: string;
}

export interface Reporter {
  handled(err: unknown, tags: Record<string, string>, level: 'warning' | 'error'): void;
  message(message: string, tags: Record<string, string>, level: 'warning' | 'error', fingerprint?: string[]): void;
  breadcrumb(message: string, data?: Record<string, string | number>): void;
}

let reporter: Reporter | null = null;
let seen = new WeakSet<object>();

/** Errors relayed over IPC ("Error invoking remote method …") were already reported by main. */
export function isIpcRelay(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Error invoking remote method ');
}

export function setReporter(next: Reporter | null): void {
  reporter = next;
  seen = new WeakSet();
}

export function reportHandled(err: unknown, where: ReportWhere, level: 'warning' | 'error' = 'warning'): void {
  if (!reporter || isIpcRelay(err)) return;
  if (err && typeof err === 'object') {
    if (seen.has(err)) return;
    seen.add(err);
  }
  reporter.handled(err, { kind: 'handled', area: where.area, op: where.op }, level);
}

export function reportAnomaly(message: string, tags: Record<string, string>, level: 'warning' | 'error' = 'warning'): void {
  reporter?.message(message, tags, level, ['anomaly', message]);
}

/** A breadcrumb before risky steps: operation name and kinds only (agent id, exit code), never paths or text. */
export function flow(op: string, data?: Record<string, string | number>): void {
  reporter?.breadcrumb(op, data);
}

/** Keeps only the error's name and code (for errors whose message may contain file contents or secrets). */
export function errorKind(err: unknown): Error {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  const out = new Error(typeof code === 'string' ? `${name} ${code}` : name);
  out.name = name;
  return out;
}
