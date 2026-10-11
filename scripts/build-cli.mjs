#!/usr/bin/env node
// Bundles the `solocut` CLI (packages/cli) into apps/desktop/resources/cli/solocut.mjs and copies the built-in
// templates to apps/desktop/resources/templates. The desktop app runs the bundle with Electron's Node
// (ELECTRON_RUN_AS_NODE=1) through the wrappers in resources/cli/bin/.
import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'apps', 'desktop', 'resources');
const cliDir = join(resources, 'cli');
const outfile = join(cliDir, 'solocut.mjs');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

mkdirSync(join(cliDir, 'bin'), { recursive: true });

await build({
  entryPoints: [join(root, 'packages', 'cli', 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node', // node builtins stay external; everything else is bundled
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  // ESM output still needs `require` for bundled CommonJS dependencies.
  banner: {
    js: [
      `// solocut ${version} — bundled by scripts/build-cli.mjs. MIT. Do not edit.`,
      "import { createRequire as __solocutCreateRequire } from 'node:module';",
      'const require = __solocutCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

const POSIX = `#!/bin/sh
# solocut: runs the bundled CLI with Electron's Node when available, else with node from PATH.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$DIR/../solocut.mjs"
if [ -n "$SOLOCUT_ELECTRON" ] && [ -x "$SOLOCUT_ELECTRON" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$SOLOCUT_ELECTRON" "$SCRIPT" "$@"
fi
exec node "$SCRIPT" "$@"
`;

const CMD = [
  '@echo off',
  'rem solocut: runs the bundled CLI with Electron\'s Node when available, else with node from PATH.',
  'setlocal',
  'set "SCRIPT=%~dp0..\\solocut.mjs"',
  'if not defined SOLOCUT_ELECTRON goto node',
  'if not exist "%SOLOCUT_ELECTRON%" goto node',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%SOLOCUT_ELECTRON%" "%SCRIPT%" %*',
  'exit /b %ERRORLEVEL%',
  ':node',
  'node "%SCRIPT%" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

writeFileSync(join(cliDir, 'bin', 'solocut'), POSIX);
chmodSync(join(cliDir, 'bin', 'solocut'), 0o755);
writeFileSync(join(cliDir, 'bin', 'solocut.cmd'), CMD);

const templatesOut = join(resources, 'templates');
rmSync(templatesOut, { recursive: true, force: true });
cpSync(join(root, 'templates'), templatesOut, { recursive: true });

const kb = Math.round(statSync(outfile).size / 1024);
console.log(`built ${outfile.slice(root.length + 1)} (${kb} KB), wrappers in resources/cli/bin, templates → resources/templates`);
