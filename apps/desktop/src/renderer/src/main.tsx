import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import '@xterm/xterm/css/xterm.css';
// order matters: tokens → fonts → the older screens → shared primitives → shell chrome → pages
import './styles/tokens.css';
import './styles/fonts.css';
import './styles.css';
import './styles/ui.css';
import './styles/shell-ported.css';
import './styles/settings.css';
import './styles/shell.css';
import './styles/screens.css';
import { App } from './App';
import { setReporter } from '@shared/report';
import { Teleprompter } from './screens/Teleprompter';

// The renderer SDK forwards to main over IPC (main's beforeSend scrubs and gates every event); only start it when
// main has crash reports on. Handled failures (src/shared/report.ts) go the same way.
void window.solocut.invoke('app:info').then((i) => {
  if (!i.crashReports) return;
  Sentry.init({});
  setReporter({
    handled: (err, tags, level) => {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { level, tags });
    },
    message: (message, tags, level, fingerprint) => {
      Sentry.captureEvent({ message, level, tags, ...(fingerprint ? { fingerprint } : {}) });
    },
    breadcrumb: (message, data) => Sentry.addBreadcrumb({ category: 'flow', message, ...(data ? { data } : {}) }),
  });
});

const hash = new URLSearchParams(location.hash.slice(1));
const tele = hash.get('teleprompter');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{tele !== null ? <Teleprompter dir={tele} /> : <App />}</StrictMode>,
);
