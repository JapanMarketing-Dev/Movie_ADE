// Agent accounts / usage / failover state for the status bar and Settings → Accounts.
//
// Channels from the desktop worker (shared/ipc-accounts.ts): usage:state + usage:meters, failover:status, and the
// events usage:changed / accounts:changed / failover:status / failover:notice. They are called through
// `invokeOptional` so a build where the registry is not merged yet degrades to what `agents:list` knows.
import { useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import { failoverFromStatus, parseFailover, parseUsage, usageFromDesktop, type UsageSnapshot } from './usageModel';

export { resetIn, tightestWindow, usageTone, type AgentUsage, type FailoverState, type UsageSnapshot, type UsageWindow } from './usageModel';

type LooseInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type LooseOn = (channel: string, l: (...a: unknown[]) => void) => () => void;

/** Invoke a channel that may not exist yet. Resolves undefined when the preload or main rejects it. */
export async function invokeOptional(channel: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await (api.invoke as unknown as LooseInvoke)(channel, ...args);
  } catch {
    return undefined;
  }
}

function onOptional(channel: string, l: (...a: unknown[]) => void): () => void {
  try {
    return (api.on as unknown as LooseOn)(channel, l);
  } catch {
    return () => undefined;
  }
}

// ---- store ----
let snap: UsageSnapshot = { available: false, usage: [], failover: null };
let started = false;
const listeners = new Set<() => void>();
function emit(next: UsageSnapshot) {
  snap = next;
  for (const l of listeners) l();
}

export async function refreshUsage(force = false): Promise<void> {
  const [state, meters, fo] = await Promise.all([
    invokeOptional(force ? 'usage:refresh' : 'usage:state', ...(force ? [true] : [])),
    invokeOptional('usage:meters'),
    invokeOptional('failover:status'),
  ]);
  const usage = Array.isArray(state) ? parseUsage(state) : usageFromDesktop(state, meters);
  emit({ available: state !== undefined || meters !== undefined, usage, failover: failoverFromStatus(fo) ?? parseFailover(fo) });
}

const noticeListeners = new Set<(message: string) => void>();
/** failover:notice (a switch finished or failed): the App shows it as a toast. */
export function onFailoverNotice(l: (message: string) => void): () => void {
  noticeListeners.add(l);
  return () => noticeListeners.delete(l);
}

function start() {
  if (started) return;
  started = true;
  // the first usage:refresh starts main's polling (5-minute debounce there)
  void refreshUsage(true);
  onOptional('usage:changed', () => void refreshUsage());
  onOptional('accounts:changed', () => void refreshUsage());
  onOptional('failover:status', () => void refreshUsage());
  onOptional('failover:notice', (n) => {
    const m = n && typeof n === 'object' && typeof (n as { message?: unknown }).message === 'string' ? (n as { message: string }).message : null;
    if (m) for (const l of noticeListeners) l(m);
    void refreshUsage();
  });
  // usage moves slowly; a minute is enough while nothing pushes
  window.setInterval(() => void refreshUsage(), 60_000);
}

export function useAgentUsage(): UsageSnapshot {
  return useSyncExternalStore(
    (l) => {
      start();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}
