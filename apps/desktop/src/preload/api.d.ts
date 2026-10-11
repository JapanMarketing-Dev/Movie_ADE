import type { SolocutApi } from '../shared/ipc';

declare global {
  interface Window {
    solocut: SolocutApi;
  }
}
export {};
