import type { SolocutApi } from '@shared/ipc';

export const api: SolocutApi = window.solocut;

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // ipcRenderer.invoke prefixes "Error invoking remote method 'x': Error: "
  return m.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
