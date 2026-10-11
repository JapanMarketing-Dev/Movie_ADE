// Crash reports (Sentry). Off when settings.telemetry.crashReports is false or SOLOCUT_NO_TELEMETRY=1.
//
// Ported from Ferret src/main/telemetry.ts (MIT), trimmed to what Solocut needs:
// - the setting is read again before every send (turning it off mid-run stops everything at once: errors, sessions,
//   renderer events; turning it back on resumes). Minidump capture can only start before ready, so turning it on
//   mid-run starts sending at the next launch.
// - native crashes: the minidump is parsed for the crash kind / module / offset only and then dropped (it is a memory
//   image and cannot be scrubbed); the event keeps process, exit reason, versions and Solocut's own flow breadcrumbs.
// - crashes (native, fatal, uncaught) get the last 50 "[tag] …" lines of the main-process log, scrubbed.
// - render-process-gone / child-process-gone / unresponsive / failed loads of the app's own pages are reported with
//   a `kind` tag; handled failures arrive through src/shared/report.ts (setReporter).
// - users are counted by a random install id only; no IP, name or email. No screenshots, tracing or replay.
import * as Sentry from '@sentry/electron/main';
import { app, crashReporter, session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseMinidumpCrash } from '../../shared/minidump';
import { setReporter } from '../../shared/report';
import {
  createBreadcrumbFilter,
  createEventLimiter,
  createLogRing,
  createSendGate,
  filterTransport,
  gateTransport,
  isCrashEvent,
  isNativeCrashEvent,
  memoryBucket,
  minimizeNativeCrash,
  resolveInstallId,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  sentryRelease,
  shouldReportLoadFailure,
  shouldReportProcessGone,
  shouldSendCrashReports,
  shouldSendNativeCrash,
  telemetryProfile,
  uptimeBucket,
  type ScrubContext,
} from '../../shared/telemetry';

const DSN = 'https://3fd03bc021e8962c759fe052b97eabc9@o4511317909569536.ingest.us.sentry.io/4512235129339904';

let enabled = false;
let projectPaths: () => readonly string[] = () => [];
/** the recent main-process log lines attached to crashes ("[solocut] …" lines only, scrubbed per line) */
const logRing = createLogRing(undefined, () => scrubContext());

function scrubContext(): ScrubContext {
  // longer paths first so a parent folder does not leave the child's name behind
  const paths = [...new Set(projectPaths().filter((p) => p.length > 1))].sort((a, b) => b.length - a.length);
  return { homeDir: homedir(), projectPaths: paths };
}

/** a random UUID kept in userData/telemetry-install-id; used for "users affected" only */
function installId(): string {
  const file = join(app.getPath('userData'), 'telemetry-install-id');
  let saved: string | null = null;
  try {
    saved = readFileSync(file, 'utf8');
  } catch {
    // first launch
  }
  const { id, created } = resolveInstallId(saved, randomUUID);
  if (created) {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileSync(file, `${id}\n`, 'utf8');
    } catch {
      // unwritable profile: this run still uses the same id
    }
  }
  return id;
}

/** reads that touch the disk (settings, recent projects) are reused for a few seconds; breadcrumbs are frequent */
function cached<T>(fn: () => T, ms: number, fallback: T): () => T {
  let at = -Infinity;
  let value = fallback;
  return () => {
    const now = Date.now();
    if (now - at >= ms) {
      at = now;
      try {
        value = fn();
      } catch {
        value = fallback;
      }
    }
    return value;
  };
}

export interface TelemetryOptions {
  /** read before every send; false stops sending from that moment (settings.telemetry.crashReports) */
  isEnabled?: () => boolean;
  /** folders to hide as "<project>" (the open / recent projects) */
  projectPaths?: () => readonly string[];
}

/** Call before app ready (minidump capture is installed then). */
export function initSentry(crashReports: boolean, opts: TelemetryOptions = {}): void {
  const send = shouldSendCrashReports({
    enabled: crashReports,
    optOut: process.env.SOLOCUT_NO_TELEMETRY === '1',
    unitTest: Boolean(process.env.VITEST),
  });
  if (!send) {
    // still catch crashes locally with Crashpad; nothing is uploaded
    try {
      crashReporter.start({ uploadToServer: false, compress: true });
    } catch {
      // crashReporter is unavailable in some test hosts
    }
    return;
  }
  if (opts.projectPaths) projectPaths = cached(opts.projectPaths, 10_000, []);
  const packaged = app.isPackaged;
  const profile = telemetryProfile(packaged);
  const isEnabled = opts.isEnabled ? cached(opts.isEnabled, 2000, true) : () => true;
  const gate = createSendGate(
    () => process.env.SOLOCUT_NO_TELEMETRY !== '1' && isEnabled(),
    {
      onDisable: () => Sentry.endSession(),
      onEnable: () => {
        Sentry.startSession();
        Sentry.captureSession();
      },
    },
  );
  setInterval(() => gate.sync(), 5000).unref?.();
  const limit = createEventLimiter(profile.maxEventsPerRun);
  const limitWarnings = createEventLimiter(profile.maxWarningsPerRun);
  const keepBreadcrumb = createBreadcrumbFilter();
  // integrations that send outside data or screen contents
  const DROP = new Set([
    'Screenshots',
    'Console', // terminal output and paths
    'ElectronNet', // request URLs
    'NodeFetch',
    'LocalVariables',
    'LocalVariablesAsync',
    'LocalVariablesSync',
    'RendererEventLoopBlock',
    'ChildProcess', // re-added below without events; process exits are reported with kind tags
    'SentryMinidump', // re-added below with a per-run cap
  ]);

  Sentry.init({
    dsn: DSN,
    environment: profile.environment,
    release: sentryRelease(app.getVersion()),
    // off → nothing is sent (sessions and renderer events included); the offline queue (also what older versions
    // stored) passes the envelope filter right before the network
    transport: (options) => gateTransport(Sentry.makeElectronOfflineTransport((o) => filterTransport(Sentry.makeElectronTransport(o)))(options), gate.allow),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    },
    attachScreenshot: false,
    maxBreadcrumbs: 30,
    integrations: (defaults) => [
      Sentry.sentryMinidumpIntegration({ maxMinidumpsPerSession: 3 }),
      ...defaults.filter((i) => !DROP.has(i.name)),
      Sentry.childProcessIntegration({ events: [] }),
      Sentry.dedupeIntegration(),
    ],
    initialScope: {
      user: { id: installId() },
      tags: { 'os.platform': process.platform, arch: process.arch, electron: process.versions.electron, build: `${process.platform}-${process.arch}` },
    },
    getRendererName: (contents) => (contents.getURL().includes('analysis.html') ? 'analysis' : contents.getURL().includes('region=') ? 'region-picker' : 'main-window'),
    beforeBreadcrumb: (crumb) => (gate.allow() && keepBreadcrumb(crumb) ? scrubBreadcrumb(crumb, scrubContext()) : null),
    beforeSend: (event, hint) => {
      if (!gate.allow()) return null;
      const minidump = (hint.attachments ?? []).find((a) => a.attachmentType === 'event.minidump');
      const native = isNativeCrashEvent(event, Boolean(minidump));
      const dump = minidump && typeof minidump.data !== 'string' ? parseMinidumpCrash(minidump.data) : null;
      // drop every incoming attachment (minidumps, renderer / scope attachments cannot be scrubbed);
      // the only attachment sent is the scrubbed main log added below (filterEnvelope also allows only that name)
      hint.attachments = [];
      if (native) event = minimizeNativeCrash(event, dump);
      if (native && !shouldSendNativeCrash(event)) return null;
      if (!sampleEvent(native, Math.random, profile.sampleRate)) return null;
      if (!(event.level === 'warning' ? limitWarnings : limit)(event)) return null;
      const log = logRing.snapshot();
      if (log && !native && isCrashEvent(event, false)) {
        hint.attachments = [{ filename: 'main-log.txt', data: log, contentType: 'text/plain' }];
      }
      return scrubEvent(event, scrubContext());
    },
  });
  installProcessHooks();
  watchMainHealth();
  setReporter({
    handled: (err, tags, level) => {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { level, tags });
    },
    message: (message, tags, level, fingerprint) => {
      Sentry.captureEvent({ message, level, tags, ...(fingerprint ? { fingerprint } : {}) });
    },
    breadcrumb: (message, data) => Sentry.addBreadcrumb({ category: 'flow', message, ...(data ? { data } : {}) }),
  });
  enabled = true;
}

export function sentryEnabled(): boolean {
  return enabled;
}

/** report a caught main-process failure with tags (kind / area). No-op when telemetry is off. */
export function reportMainError(err: unknown, tags: Record<string, string>): void {
  if (enabled) Sentry.captureException(err, { tags });
}

/** non-exception anomalies are sent without a stack so the title stays the message */
function reportMessage(message: string, level: 'error' | 'warning', tags: Record<string, string>): void {
  if (enabled) Sentry.captureEvent({ message, level, tags });
}

/** The app's own pages use the default session; remote pages (OAuth windows) use other sessions. */
function isOwnContents(contents: WebContents): boolean {
  try {
    return contents.session === session.defaultSession;
  } catch {
    return false;
  }
}

function watchWebContents(contents: WebContents): void {
  contents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (!shouldReportLoadFailure({ ownPage: isOwnContents(contents), errorCode, isMainFrame })) return;
    reportMessage(`did-fail-load: ${errorDescription} (${errorCode})`, 'error', {
      kind: 'did-fail-load',
      'load.errorCode': String(errorCode),
      'contents.type': contents.getType(),
    });
  });
  contents.on('preload-error', (_e, preloadPath, error) => {
    reportMainError(error, { kind: 'preload-error', preload: preloadPath.split(/[\\/]/).pop() ?? 'unknown' });
  });
  contents.on('unresponsive', () => {
    if (isOwnContents(contents)) reportMessage('webContents unresponsive', 'warning', { kind: 'unresponsive', 'contents.type': contents.getType() });
  });
}

function installProcessHooks(): void {
  app.on('render-process-gone', (_e, _contents, details) => {
    if (!shouldReportProcessGone(details.reason)) return;
    reportMessage(`render-process-gone: ${details.reason}`, 'error', {
      kind: 'render-process-gone',
      reason: details.reason,
      exitCode: String(details.exitCode),
    });
  });
  app.on('child-process-gone', (_e, details) => {
    if (!shouldReportProcessGone(details.reason)) return;
    reportMessage(`child-process-gone: ${details.type} ${details.reason}`, 'error', {
      kind: 'child-process-gone',
      reason: details.reason,
      'process.type': details.type,
      exitCode: String(details.exitCode),
      ...(details.name ? { 'process.name': details.name } : {}),
    });
  });
  app.on('web-contents-created', (_e, contents) => watchWebContents(contents));
  // keep "[tag] …" lines for the crash attachment (console output itself is never sent)
  for (const level of ['log', 'error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logRing.push(level, args);
      original(...args);
    };
  }
}

/**
 * main's memory and uptime as coarse buckets on the scope, updated when a bucket changes. The scope is persisted, so
 * a native main crash reported at the next launch carries the last values.
 */
function watchMainHealth(): void {
  let last = '';
  const tick = (): void => {
    const memory = process.memoryUsage();
    const tags = {
      'mem.rss': memoryBucket(memory.rss / 2 ** 20),
      'mem.heap': memoryBucket(memory.heapUsed / 2 ** 20),
      uptime: uptimeBucket(process.uptime()),
    };
    const key = JSON.stringify(tags);
    if (key === last) return;
    last = key;
    Sentry.setTags(tags);
  };
  tick();
  setInterval(tick, 30_000).unref?.();
}
