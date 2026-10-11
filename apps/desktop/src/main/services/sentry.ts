// Crash reports (Sentry). Off when settings.telemetry.crashReports is false. Paths are scrubbed.
import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { homedir } from 'node:os';
import { scrubDeep } from './scrub';

const DSN = 'https://3fd03bc021e8962c759fe052b97eabc9@o4511317909569536.ingest.us.sentry.io/4512235129339904';

let enabled = false;

export function initSentry(crashReports: boolean): void {
  if (!crashReports || process.env.SOLOCUT_NO_TELEMETRY === '1') return;
  const home = homedir();
  Sentry.init({
    dsn: DSN,
    environment: app.isPackaged ? 'production' : 'development',
    release: `solocut@${app.getVersion()}`,
    beforeSend(event) {
      return scrubDeep(event, home);
    },
    beforeBreadcrumb(b) {
      return scrubDeep(b, home);
    },
  });
  enabled = true;
}

export function sentryEnabled(): boolean {
  return enabled;
}
