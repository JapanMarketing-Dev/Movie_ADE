import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { Teleprompter } from './screens/Teleprompter';

Sentry.init({});

const hash = new URLSearchParams(location.hash.slice(1));
const tele = hash.get('teleprompter');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{tele !== null ? <Teleprompter dir={tele} /> : <App />}</StrictMode>,
);
