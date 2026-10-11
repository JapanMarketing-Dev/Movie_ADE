import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.js';

export interface Run { code: number; stdout: string; stderr: string; json: any }

export class Sandbox {
  root = mkdtempSync(join(tmpdir(), 'solocut-cli-'));
  home = join(this.root, 'home');
  saved = { ...process.env };

  constructor() {
    process.env.SOLOCUT_HOME = this.home;
    delete process.env.SOLOCUT_TEMPLATES_DIR;
  }

  async run(args: string[], o: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<Run> {
    let stdout = '';
    let stderr = '';
    const env: NodeJS.ProcessEnv = { ...process.env, SOLOCUT_HOME: this.home, ...o.env };
    for (const k of ['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI', 'SOLOCUT_AGENT', 'SOLOCUT_BY', 'SOLOCUT_AUTOPILOT']) if (!o.env?.[k]) delete env[k];
    const code = await main(args, {
      cwd: o.cwd ?? this.root,
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env,
      readStdin: async () => o.stdin ?? '',
    });
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = undefined;
    }
    return { code, stdout, stderr, json };
  }

  dispose(): void {
    process.env = { ...this.saved };
    rmSync(this.root, { recursive: true, force: true });
  }
}
