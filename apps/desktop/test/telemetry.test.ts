// Crash-report rules: when to send and what is removed before sending. Nothing is sent here.
// Cases ported from Ferret test/unit/telemetry.test.ts (MIT); expectations adapted to Solocut's stricter path rule
// (absolute paths keep only their last segment).
import { describe, expect, it, vi } from 'vitest';
import { flow, reportAnomaly, reportHandled, setReporter } from '../src/shared/report';
import {
  MAX_EVENTS_PER_RUN,
  collapsePaths,
  crashReportsEnabled,
  createBreadcrumbFilter,
  createEventLimiter,
  createLogRing,
  createSendGate,
  isCrashEvent,
  resolveInstallId,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  sentryRelease,
  shouldReportLoadFailure,
  shouldReportProcessGone,
  shouldSendCrashReports,
  telemetryProfile,
} from '../src/shared/telemetry';

describe('when to send', () => {
  it('release is solocut@<version>', () => {
    expect(sentryRelease('0.2.0')).toBe('solocut@0.2.0');
  });
  it('setting on → send; off, SOLOCUT_NO_TELEMETRY or a unit test → not', () => {
    expect(shouldSendCrashReports({ enabled: true, optOut: false, unitTest: false })).toBe(true);
    expect(shouldSendCrashReports({ enabled: false, optOut: false, unitTest: false })).toBe(false);
    expect(shouldSendCrashReports({ enabled: true, optOut: true, unitTest: false })).toBe(false);
    expect(shouldSendCrashReports({ enabled: true, optOut: false, unitTest: true })).toBe(false);
  });
  it('unset setting is on; only an explicit false is off', () => {
    expect(crashReportsEnabled({})).toBe(true);
    expect(crashReportsEnabled({ crashReports: true })).toBe(true);
    expect(crashReportsEnabled({ crashReports: false })).toBe(false);
  });
  it('packaged is production, dev is development; both send every JS error but cap per run', () => {
    expect(telemetryProfile(true)).toMatchObject({ environment: 'production', sampleRate: 1, maxEventsPerRun: MAX_EVENTS_PER_RUN });
    expect(telemetryProfile(false)).toMatchObject({ environment: 'development', sampleRate: 1, maxEventsPerRun: 50 });
  });
});

describe('anomalies collected', () => {
  it("own pages' load failures are sent; aborted (-3) and subframes are not", () => {
    expect(shouldReportLoadFailure({ ownPage: true, errorCode: -6, isMainFrame: true })).toBe(true);
    expect(shouldReportLoadFailure({ ownPage: true, errorCode: -3, isMainFrame: true })).toBe(false);
    expect(shouldReportLoadFailure({ ownPage: true, errorCode: -6, isMainFrame: false })).toBe(false);
  });
  it('remote pages (OAuth windows, another session) are not sent', () => {
    expect(shouldReportLoadFailure({ ownPage: false, errorCode: -102, isMainFrame: true })).toBe(false);
  });
  it('process exits other than clean / killed are sent', () => {
    for (const r of ['crashed', 'oom', 'launch-failed', 'abnormal-exit']) expect(shouldReportProcessGone(r)).toBe(true);
    for (const r of ['clean-exit', 'killed']) expect(shouldReportProcessGone(r)).toBe(false);
  });
  it('crash events: native, fatal or unhandled exceptions', () => {
    expect(isCrashEvent({}, true)).toBe(true);
    expect(isCrashEvent({ level: 'fatal' }, false)).toBe(true);
    expect(isCrashEvent({ exception: { values: [{ mechanism: { handled: false } }] } }, false)).toBe(true);
    expect(isCrashEvent({ exception: { values: [{ mechanism: { handled: true } }] } }, false)).toBe(false);
    expect(isCrashEvent({ level: 'warning' }, false)).toBe(false);
  });
});

describe('string scrubbing', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/secret-app'] };
  it('home dirs become ~ and absolute paths keep only the last segment (macOS, Linux, Windows)', () => {
    expect(scrubString('ENOENT: /Users/hanako/Library/x.json')).toBe('ENOENT: <path>/x.json');
    expect(scrubString('open /home/hanako/.config/a')).toBe('open <path>/a');
    expect(scrubString('C:\\Users\\Hanako\\AppData\\Roaming\\solocut')).not.toMatch(/Hanako/);
    expect(scrubString('file:///Users/hanako/x.js')).toBe('file://~/x.js');
    expect(scrubString('spawn /tmp/solocut-update-1.sh')).toBe('spawn <path>/solocut-update-1.sh');
    expect(scrubString('D:\\Videos\\take1\\raw.mp4 missing')).toBe('<path>/raw.mp4 missing');
  });
  it('project folders are hidden before the home dir', () => {
    expect(scrubString("can't read /Users/taro/work/secret-app/src/a.ts", ctx)).toBe("can't read <path>/a.ts");
    expect(scrubString('opened /Users/taro/work/secret-app', ctx)).toBe('opened <project>');
  });
  it('URLs (with query strings) are not sent', () => {
    expect(scrubString('failed to load https://intra.example.com/admin?id=42&token=abc (net::ERR)')).toBe('failed to load <url> (net::ERR)');
    expect(scrubString('ws://localhost:3000/socket closed')).toBe('<url> closed');
    expect(scrubString('POST https://oauth2.googleapis.com/token?code=4/0Ab returned 400')).toBe('POST <url> returned 400');
  });
  it('app:// stack file names stay (source maps need them)', () => {
    expect(scrubString('app:///out/main/index.js')).toBe('app:///out/main/index.js');
  });
  it('emails and IP addresses are not sent', () => {
    expect(scrubString('user hanako.yamada+test@example.co.jp not found')).toBe('user <email> not found');
    expect(scrubString('connect ECONNREFUSED 192.168.1.20:443')).toBe('connect ECONNREFUSED <ip>:443');
    expect(scrubString('at 12:34:56 Foo::bar')).toBe('at 12:34:56 Foo::bar');
  });
  it('API keys and tokens are not sent (OpenAI, GitHub, Bearer, Google, JWT, Google OAuth)', () => {
    expect(scrubString('401 for sk-proj-abcdefghijklmnop1234')).toBe('401 for <secret>');
    expect(scrubString('401 for sk-ant-api03-abcdefghijklmnop')).toBe('401 for <secret>');
    expect(scrubString('token ghp_ABCDEFGHIJ1234567890abcd')).toBe('token <secret>');
    expect(scrubString('Authorization: Bearer abc.def-123456789')).toBe('Authorization: <secret>');
    expect(scrubString('AIzaSyA1234567890abcdefghijklmnop')).toBe('<secret>');
    expect(scrubString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk')).toBe('jwt <secret>');
    expect(scrubString('access ya29.a0AfH6SMBxxxxxxxxxxxxxx expired')).toBe('access <secret> expired');
    expect(scrubString('refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWx revoked')).toBe('refresh <secret> revoked');
  });
  it('long text is truncated (terminal output or transcripts never go out whole)', () => {
    expect(scrubString('x'.repeat(2000)).length).toBeLessThanOrEqual(301);
  });
  it('collapsePaths leaves relative paths and words alone', () => {
    expect(collapsePaths('src/main/index.ts failed')).toBe('src/main/index.ts failed');
    expect(collapsePaths('a / b')).toBe('a / b');
  });
});

describe('event scrubbing', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/app'] };
  const event = {
    event_id: 'e1',
    message: 'boom at /Users/taro/work/app/feedback.md',
    user: { ip_address: '203.0.113.5', email: 'taro@example.com' },
    server_name: 'taros-macbook.local',
    request: { url: 'https://example.com/page' },
    extra: { transcript: '今日は社外秘の話をします' },
    contexts: {
      os: { name: 'macOS', version: '15.1' },
      device: { arch: 'arm64', name: "Taro's MacBook", model_id: 'Mac15,3', boot_time: '2026-10-02T14:40:18.347Z' },
      runtime: { name: 'Electron', version: '44.5.1' },
      terminal: { output: 'ls ~/secret' },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: "ENOENT: no such file, open '/Users/taro/Documents/a.txt' (taro@example.com)",
          stacktrace: { frames: [{ filename: 'app:///out/main/index.js', abs_path: `/Users/taro/Applications/Solocut.app/${'deep/'.repeat(80)}x.js`, function: 'run', lineno: 10 }] },
        },
      ],
    },
    breadcrumbs: [
      { category: 'console', message: 'terminal output: npm run secret' },
      { category: 'ui.click', message: 'button[aria-label="Delete /Users/taro/x"]' },
      { category: 'electron', message: 'app.ready', data: { url: 'https://example.com', title: 'Inbox (3) – taro@example.com' } },
      { category: 'child-process', message: 'ffmpeg exited', data: { type: 'Utility', exitCode: 1, name: 'ffmpeg', cwd: '/Users/taro/work/app' } },
      { category: 'flow', message: 'agent launch', data: { agent: 'claude', path: '/Users/taro/x', n: 2 } },
    ],
  };

  it('user keeps only an empty geo; request, extra and server_name are dropped', () => {
    const out = scrubEvent(event, ctx) as Record<string, unknown>;
    expect(out.user).toEqual({ geo: {} });
    expect(out.request).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.server_name).toBeUndefined();
  });
  it('an install id survives as the user id', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect((scrubEvent({ user: { id, email: 'a@b.co' } }) as { user: unknown }).user).toEqual({ id, geo: {} });
  });
  it('OS / CPU / runtime versions stay; device names and unknown contexts go', () => {
    const out = scrubEvent(event, ctx) as unknown as { contexts: Record<string, Record<string, unknown>> };
    expect(out.contexts.os).toEqual({ name: 'macOS', version: '15.1' });
    expect(out.contexts.device).toEqual({ arch: 'arm64' });
    expect(out.contexts.runtime?.version).toBe('44.5.1');
    expect(out.contexts.terminal).toBeUndefined();
  });
  it('messages lose paths and emails; stack file names are not truncated', () => {
    const out = scrubEvent(event, ctx) as typeof event;
    const v = out.exception.values[0]!;
    expect(v.value).toBe("ENOENT: no such file, open '<path>/a.txt' (<email>)");
    expect(out.message).toBe('boom at <path>/feedback.md');
    expect(v.stacktrace.frames[0]!.filename).toBe('app:///out/main/index.js');
    expect(v.stacktrace.frames[0]!.abs_path.startsWith('~/Applications/Solocut.app/')).toBe(true);
    expect(v.stacktrace.frames[0]!.abs_path.endsWith('x.js')).toBe(true);
  });
  it('breadcrumbs: electron, child-process and flow only, with their safe fields', () => {
    const out = scrubEvent(event, ctx) as typeof event;
    expect(out.breadcrumbs.map((b) => b.category)).toEqual(['electron', 'child-process', 'flow']);
    expect(out.breadcrumbs[0]).toEqual({ category: 'electron', message: 'app.ready' });
    expect(out.breadcrumbs[1]!.data).toEqual({ type: 'Utility', exitCode: 1, name: 'ffmpeg' });
    expect(out.breadcrumbs[2]!.data).toEqual({ agent: 'claude', n: 2 });
  });
  it('Sentry ids are kept even when they look like secrets', () => {
    const ids = { event_id: 'a'.repeat(32), contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) } } };
    expect(scrubEvent(ids)).toEqual({ ...ids, user: { geo: {} } });
  });
  it('does not modify the original event', () => {
    scrubEvent(event, ctx);
    expect(event.user.email).toBe('taro@example.com');
  });
  it('nothing personal is left anywhere in the sent event', () => {
    expect(JSON.stringify(scrubEvent(event, ctx))).not.toMatch(/\/Users\/taro|https?:\/\/|@example\.com|社外秘|taros-macbook|secret-app/);
  });
  it('beforeBreadcrumb uses the same rules', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: 'https://a' } })).toBeNull();
    expect(scrubBreadcrumb({ category: 'electron', message: 'browser-window.closed /Users/taro/a' }, ctx)).toEqual({ category: 'electron', message: 'browser-window.closed <path>/a' });
  });
});

describe('volume', () => {
  const err = (value: string) => ({ exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: 'app:///a.js', function: 'f', lineno: 1 }] } }] } });
  it('the same error once per run', () => {
    const allow = createEventLimiter();
    expect(allow(err('a'))).toBe(true);
    expect(allow(err('a'))).toBe(false);
    expect(allow(err('b'))).toBe(true);
  });
  it('a cap per run', () => {
    const allow = createEventLimiter();
    const results = Array.from({ length: MAX_EVENTS_PER_RUN + 5 }, (_, i) => allow(err(`e${i}`)));
    expect(results.filter(Boolean)).toHaveLength(MAX_EVENTS_PER_RUN);
  });
  it('sampling: native crashes always, JS errors by rate', () => {
    expect(sampleEvent(true, () => 0.99)).toBe(true);
    expect(sampleEvent(false, () => 0.99)).toBe(false);
    expect(sampleEvent(false, () => 0.1)).toBe(true);
    expect(sampleEvent(false, () => 0.99, 1)).toBe(true);
  });
  it('breadcrumb filter drops noisy and repeated crumbs', () => {
    const keep = createBreadcrumbFilter();
    expect(keep({ category: 'electron', message: 'app.accessibility-support-changed' })).toBe(false);
    expect(keep({ category: 'electron', message: 'app.ready' })).toBe(true);
    expect(keep({ category: 'electron', message: 'app.ready' })).toBe(false);
    expect(keep({ category: 'flow', message: 'app.ready' })).toBe(true);
  });
});

describe('send gate (crash reports turned off mid-run)', () => {
  it('follows the setting at each call and fires the hooks once per change', () => {
    let on = true;
    const onDisable = vi.fn();
    const onEnable = vi.fn();
    const gate = createSendGate(() => on, { onDisable, onEnable });
    expect(gate.allow()).toBe(true);
    on = false;
    expect(gate.allow()).toBe(false);
    expect(gate.sync()).toBe(false);
    expect(onDisable).toHaveBeenCalledTimes(1);
    on = true;
    expect(gate.allow()).toBe(true);
    expect(onEnable).toHaveBeenCalledTimes(1);
  });
});

describe('install id', () => {
  it('keeps a saved v4 UUID, replaces missing or broken ones', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const fresh = () => '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(resolveInstallId(`${id}\n`, fresh)).toEqual({ id, created: false });
    expect(resolveInstallId(null, fresh)).toEqual({ id: fresh(), created: true });
    expect(resolveInstallId('taro@example.com', fresh)).toEqual({ id: fresh(), created: true });
  });
});

describe('main log ring (attached to crashes)', () => {
  it('keeps only "[tag] …" lines, scrubbed and short, newest 50', () => {
    const ring = createLogRing(undefined, () => ({ homeDir: '/Users/taro' }));
    ring.push('log', ['terminal output: rm -rf /Users/taro']);
    ring.push('log', [{ not: 'a string' }]);
    ring.push('error', ['[solocut] open /Users/taro/Movies/take/raw.mp4 failed for taro@example.com', new Error('ENOENT')]);
    for (let i = 0; i < 60; i++) ring.push('log', [`[solocut] line ${i}`]);
    const text = ring.snapshot();
    const lines = text.split('\n');
    expect(lines).toHaveLength(50);
    expect(text).not.toMatch(/terminal output|taro|not/);
    expect(lines.at(-1)).toMatch(/log \[solocut\] line 59$/);
  });
  it('a long line is cut', () => {
    const ring = createLogRing(3);
    ring.push('log', [`[x] ${'a'.repeat(1000)}`]);
    expect(ring.snapshot().length).toBeLessThan(220);
  });
});

describe('handled failures (src/shared/report.ts)', () => {
  it('forwards once per error object with area / op tags; IPC relays are skipped', () => {
    const handled = vi.fn();
    const message = vi.fn();
    const breadcrumb = vi.fn();
    setReporter({ handled, message, breadcrumb });
    const err = new Error('boom');
    reportHandled(err, { area: 'update', op: 'update check' });
    reportHandled(err, { area: 'update', op: 'update check' });
    reportHandled(new Error("Error invoking remote method 'x': boom"), { area: 'ui', op: 'x' });
    reportAnomaly('weird', { kind: 'x' });
    flow('agent launch', { agent: 'claude' });
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(err, { kind: 'handled', area: 'update', op: 'update check' }, 'warning');
    expect(message).toHaveBeenCalledWith('weird', { kind: 'x' }, 'warning', ['anomaly', 'weird']);
    expect(breadcrumb).toHaveBeenCalledWith('agent launch', { agent: 'claude' });
    setReporter(null);
    reportHandled(new Error('after'), { area: 'update', op: 'x' });
    expect(handled).toHaveBeenCalledTimes(1);
  });
});
