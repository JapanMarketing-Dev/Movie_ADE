// Shared, lazily-loaded IPC state for the shell (settings.json, update, analysis, tools, agents). Each store loads once
// when first used, reloads on its main-process event, and is read with useSyncExternalStore so the title bar, status
// bar, sidebar and settings page share one copy instead of each calling IPC.
import { useSyncExternalStore } from 'react';
import type { AgentStatus, AnalysisStatus, ToolState, UpdateState } from '@shared/types';
import type { EventChannel } from '@shared/ipc';
import { api } from '../lib/api';
import { parseSettingsText } from '../settings/settingsSections';

export interface Store<T> {
  get(): T;
  subscribe(l: () => void): () => void;
  reload(): Promise<void>;
  set(v: T): void;
}

export function createStore<T>(initial: T, load: () => Promise<T>, events: EventChannel[] = [], push?: (set: (v: T) => void) => () => void): Store<T> {
  let value = initial;
  let started = false;
  const listeners = new Set<() => void>();
  const set = (v: T) => {
    value = v;
    for (const l of listeners) l();
  };
  const reload = async () => {
    try {
      set(await load());
    } catch {
      // keep the last good value; the main process logs IPC failures
    }
  };
  const start = () => {
    if (started) return;
    started = true;
    void reload();
    for (const ev of events) api.on(ev, () => void reload());
    push?.(set);
  };
  return {
    get: () => value,
    subscribe: (l) => {
      start();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    reload,
    set,
  };
}

export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get);
}

export interface SettingsState {
  path: string;
  text: string;
  /** parsed settings.json; {} when the file is missing, null when it does not parse */
  json: Record<string, unknown> | null;
  errors: string[];
  loaded: boolean;
}

export const settingsStore = createStore<SettingsState>(
  { path: '', text: '', json: {}, errors: [], loaded: false },
  async () => {
    const d = await api.invoke('settings:read');
    return { path: d.path, text: d.text, json: parseSettingsText(d.text) ?? null, errors: d.errors, loaded: true };
  },
  ['settings:changed'],
);

export const updateStore = createStore<UpdateState | null>(null, () => api.invoke('update:state'), [], (set) => api.on('update:state', set));

export const analysisStore = createStore<AnalysisStatus | null>(null, () => api.invoke('analysis:status'), [], (set) => api.on('analysis:state', set));

export const toolsStore = createStore<ToolState[] | null>(null, () => api.invoke('tools:status'));

export const agentsStore = createStore<AgentStatus[] | null>(null, () => api.invoke('agents:list'), ['settings:changed']);

/** Set one settings key through main (validated there). Returns the error text, or null when saved. */
export async function setSetting(key: string, value: unknown): Promise<string | null> {
  const r = await api.invoke('settings:set', key, value);
  if (!r.ok) return r.errors.join('\n') || 'invalid value';
  void settingsStore.reload();
  return null;
}
