// Exposes only the channels declared in @shared/ipc as window.solocut. Sandboxed preload: no Node APIs.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isEventChannel, isInvokeChannel, isSendChannel, mediaUrl, type SolocutApi } from '../shared/ipc';

const api: SolocutApi = {
  invoke(channel, ...args) {
    if (!isInvokeChannel(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${String(channel)}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (!isSendChannel(channel)) throw new Error(`IPC channel not allowed: ${String(channel)}`);
    ipcRenderer.send(channel, ...args);
  },
  on(channel, listener) {
    if (!isEventChannel(channel)) throw new Error(`IPC channel not allowed: ${String(channel)}`);
    const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => (listener as (...a: unknown[]) => void)(...args);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  mediaUrl,
};

contextBridge.exposeInMainWorld('solocut', api);
