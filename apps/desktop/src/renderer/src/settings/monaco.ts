/// <reference types="vite/client" />
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';

/**
 * Monaco bundled with the app (never from a CDN; works offline and under the CSP).
 * The editors here are settings.json and prompts.json, so only the JSON worker is wired; everything else uses the
 * plain editor worker. monaco-editor 0.57 maps `monaco-editor/*` to `esm/vs/*` in its exports.
 *
 * Orca由来: ~/bench/orca/src/renderer/src/lib/monaco-setup.ts（MIT, Ferret src/renderer/editor/monacoSetup.ts 経由）
 *   - workers are bundled with Vite's ?worker and chosen per language
 *   - loader.config({ monaco }) makes @monaco-editor/react use the bundled monaco
 */
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === 'json' ? new jsonWorker() : new editorWorker();
  },
};

/** Editor colors from styles/tokens.css (dark only). */
monaco.editor.defineTheme('solocut-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: 'e5e5e5' },
    { token: 'string.value.json', foreground: 'f0c674' },
    { token: 'number', foreground: '81a2be' },
    { token: 'keyword.json', foreground: 'ff6b60' },
  ],
  colors: {
    'editor.background': '#141414',
    'editor.foreground': '#e5e5e5',
    'editorLineNumber.foreground': '#5a5a5a',
    'editorLineNumber.activeForeground': '#a1a1a1',
    'editor.lineHighlightBackground': '#1e1e1e',
    'editor.selectionBackground': '#ff4a3d33',
    'editorCursor.foreground': '#ff4a3d',
    'editorIndentGuide.background1': '#262626',
    'editorWidget.background': '#1e1e1e',
    'editorWidget.border': '#333333',
    'editorSuggestWidget.background': '#1e1e1e',
    'editorSuggestWidget.selectedBackground': '#2e2e2e',
    'scrollbarSlider.background': '#40404080',
  },
});

loader.config({ monaco });

export { monaco };
