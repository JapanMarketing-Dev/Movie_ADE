import { parseArgs, type ParseArgsConfig } from 'node:util';

export const CLI_VERSION = '0.1.0';

export interface IO {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** stdin text for `--ops -` (tests inject it). */
  readStdin?: () => Promise<string>;
}

export class CliError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'CliError';
  }
}

export type Lang = 'ja' | 'en';

export interface Ctx {
  io: IO;
  json: boolean;
  projectFlag?: string;
  lang: Lang;
  /** Who is acting (history `by`). */
  by: 'human' | 'agent';
  agent?: string;
}

/** Print the result: JSON (`{ ok: true, ...data }`) with --json, else the human text. */
export function emit(ctx: Ctx, data: Record<string, unknown>, human: () => string | string[]): void {
  if (ctx.json) {
    ctx.io.stdout(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
    return;
  }
  const h = human();
  const text = Array.isArray(h) ? h.filter((l) => l !== undefined).join('\n') : h;
  if (text) ctx.io.stdout(text.endsWith('\n') ? text : text + '\n');
}

/** Human-only progress/info line on stderr (silent in --json mode). */
export function info(ctx: Ctx, s: string): void {
  if (!ctx.json) ctx.io.stderr(s.endsWith('\n') || s.endsWith('\r') ? s : s + '\n');
}

export const t = (ctx: Pick<Ctx, 'lang'>, ja: string, en: string): string => (ctx.lang === 'ja' ? ja : en);

type Options = NonNullable<ParseArgsConfig['options']>;

/** node:util parseArgs with usage errors turned into CliError. */
export function opts<O extends Options>(args: string[], options: O, o: { min?: number; max?: number; usage?: string } = {}) {
  let r;
  try {
    r = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new CliError('usage', `${(e as Error).message}${o.usage ? `\nusage: ${o.usage}` : ''}`);
  }
  const n = r.positionals.length;
  if ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) {
    throw new CliError('usage', `wrong number of arguments${o.usage ? `\nusage: ${o.usage}` : ''}`);
  }
  return r;
}

export function intOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new CliError('usage', `--${name} must be an integer`);
  return Number(v);
}
