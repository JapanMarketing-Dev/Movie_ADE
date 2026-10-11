// Agent accounts / usage / failover state for the status bar and Settings → Accounts.
//
// TODO(desktop IPC): the main-process side (usage polling, account detection, failover) is being added by the desktop
// worker. Until its channels are declared in @shared/ipc, calls go through `invokeOptional`, which the preload rejects
// for unknown channels; the UI then falls back to what `agents:list` knows (installed / version) and hides meters.
import { useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import { parseFailover, parseUsage, type UsageSnapshot } from './usageModel';

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

export async function refreshUsage(): Promise<void> {
  const [u, f] = await Promise.all([invokeOptional('usage:state'), invokeOptional('failover:state')]);
  emit({ available: u !== undefined, usage: parseUsage(u), failover: parseFailover(f) });
}

function start() {
  if (started) return;
  started = true;
  void refreshUsage();
  onOptional('usage:changed', () => void refreshUsage());
  onOptional('failover:changed', () => void refreshUsage());
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
