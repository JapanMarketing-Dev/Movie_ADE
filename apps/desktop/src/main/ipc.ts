// Typed registration of every IPC channel declared in @shared/ipc. Startup fails loudly if a declared
// invoke channel has no handler, and messages from frames that are not ours are rejected.
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  INVOKE_CHANNELS,
  isEventChannel,
  type EventChannel,
  type EventMap,
  type InvokeChannel,
  type InvokeMap,
  type SendChannel,
  type SendMap,
} from '../shared/ipc';

type Handler<C extends InvokeChannel> = (
  e: IpcMainInvokeEvent,
  ...args: InvokeMap[C]['args']
) => InvokeMap[C]['result'] | Promise<InvokeMap[C]['result']>;

const registered = new Set<InvokeChannel>();
let trusted: (url: string) => boolean = () => true;

export function setTrustedOrigin(fn: (url: string) => boolean): void {
  trusted = fn;
}

function checkSender(e: IpcMainInvokeEvent | IpcMainEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!trusted(url)) throw new Error(`IPC from untrusted frame: ${url}`);
}

export function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  if (registered.has(channel)) throw new Error(`IPC handler registered twice: ${channel}`);
  registered.add(channel);
  ipcMain.handle(channel, async (e, ...args) => {
    checkSender(e);
    return fn(e, ...(args as InvokeMap[C]['args']));
  });
}

export function on<C extends SendChannel>(channel: C, fn: (e: IpcMainEvent, ...args: SendMap[C]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    try {
      checkSender(e);
    } catch {
      return;
    }
    fn(e, ...(args as SendMap[C]));
  });
}

export function emit<C extends EventChannel>(wc: WebContents | null | undefined, channel: C, ...args: EventMap[C]): void {
  if (!wc || wc.isDestroyed() || !isEventChannel(channel)) return;
  wc.send(channel, ...args);
}

/** Throws if any declared invoke channel lacks a handler. */
export function assertAllHandled(): void {
  const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c));
  if (missing.length > 0) throw new Error(`IPC channels without handlers: ${missing.join(', ')}`);
}
