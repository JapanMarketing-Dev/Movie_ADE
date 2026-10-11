import { describe, expect, it } from 'vitest';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  isEventChannel,
  isInvokeChannel,
  isSendChannel,
  mediaUrl,
  pathFromMediaUrl,
} from '../src/shared/ipc';

describe('IPC registry', () => {
  it('declares channels with namespace:name form and no duplicates across kinds', () => {
    const all = [...INVOKE_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS];
    for (const c of all) expect(c).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    for (const c of SEND_CHANNELS) expect(INVOKE_CHANNELS).not.toContain(c);
  });

  it('has the channels the app depends on', () => {
    for (const c of ['project:snapshot', 'terminal:create', 'agent:send', 'record:append', 'settings:set', 'update:restart']) expect(isInvokeChannel(c)).toBe(true);
    expect(isSendChannel('terminal:write')).toBe(true);
    expect(isEventChannel('agent:state')).toBe(true);
  });

  it('has no JSON-file editing or API key channels (settings are plain controls; no API keys in the app)', () => {
    for (const c of ['settings:validate', 'settings:write', 'prompts:readFile', 'prompts:validate', 'prompts:writeFile', 'secrets:status', 'secrets:set']) {
      expect(isInvokeChannel(c), c).toBe(false);
    }
    for (const c of ['settings:read', 'settings:set', 'prompts:list', 'prompts:render']) expect(isInvokeChannel(c), c).toBe(true);
  });

  it('rejects unknown, prototype and non-string names', () => {
    for (const bad of ['', 'nope', 'terminal:data', 'pty:spawn', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'PROJECT:SNAPSHOT', 'project:snapshot ']) {
      expect(isInvokeChannel(bad)).toBe(false);
    }
    expect(isInvokeChannel(undefined)).toBe(false);
    expect(isInvokeChannel(42)).toBe(false);
    expect(isInvokeChannel({ toString: () => 'app:info' })).toBe(false);
    expect(isSendChannel('terminal:create')).toBe(false); // invoke-only
    expect(isEventChannel('terminal:write')).toBe(false); // send-only
  });

  it('registry arrays are frozen', () => {
    expect(Object.isFrozen(INVOKE_CHANNELS)).toBe(true);
    expect(() => (INVOKE_CHANNELS as string[]).push('x:y')).toThrow();
  });
});

describe('media URLs', () => {
  it('round-trips posix, windows and unicode paths', () => {
    for (const p of ['/Users/me/My Video/renders/preview.mp4', 'C:\\Users\\me\\動画\\a#b?.mp4', '/tmp/100%/x.webm']) {
      expect(pathFromMediaUrl(mediaUrl(p))).toBe(p);
      expect(pathFromMediaUrl(mediaUrl(p, 1234.9))).toBe(p);
    }
  });
  it('adds an integer cache-busting version', () => {
    expect(mediaUrl('/a.mp4', 17.8)).toMatch(/\?v=17$/);
  });
  it('returns null for foreign or malformed URLs', () => {
    expect(pathFromMediaUrl('file:///etc/passwd')).toBeNull();
    expect(pathFromMediaUrl('solocut-media://other/%2Fa')).toBeNull();
    expect(pathFromMediaUrl('solocut-media://file/')).toBeNull();
    expect(pathFromMediaUrl('solocut-media://file/%E0%A4%A')).toBeNull();
  });
});
