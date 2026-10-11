// The only module in the app that imports the @solocut/* platform packages (APIs per docs/dev/CONTRACTS.md).
// Everything here converts package types to the app's shared types and never throws to the IPC layer for
// "package not ready" situations: callers get empty lists and an error string instead.
import { AGENTS, detectAgents, getAgent, launchCommand } from '@solocut/agents';
import {
  SettingsSchema,
  defaultPromptText,
  isPromptId,
  loadSettings,
  promptsFromSettings,
  renderPromptById,
  setSetting,
  settingsPath,
  stripJsonComments,
} from '@solocut/settings';
import { listTemplates } from '@solocut/templates';
import { solocutHome, toolStatus } from '@solocut/toolchain';
import type {
  AgentStatus,
  Lang,
  OsName,
  PromptButton,
  TemplateInfo,
  ToolState,
  ValidationResult,
} from '../../shared/types';
import { delimiter } from 'node:path';
import { searchDirs, shellPathIsProvisional } from '../shellPath';
import { join } from 'node:path';

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

export function osName(): OsName {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
}

// ---------- settings ----------

export function settingsObject(): Dict {
  try {
    const s = loadSettings() as unknown;
    return isObj(s) ? s : {};
  } catch {
    return {};
  }
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function language(): Lang {
  return getPath(settingsObject(), 'language') === 'en' ? 'en' : 'ja';
}

export function crashReportsEnabled(): boolean {
  return getPath(settingsObject(), 'telemetry.crashReports') !== false;
}

export function updatesEnabled(): boolean {
  return getPath(settingsObject(), 'updates.auto') !== false;
}

export function hotkeys(): { markNg: string; markImportant: string } {
  const s = settingsObject();
  const ng = getPath(s, 'recording.hotkeys.markNg');
  const imp = getPath(s, 'recording.hotkeys.markImportant');
  return {
    markNg: typeof ng === 'string' ? ng : 'CmdOrCtrl+Shift+N',
    markImportant: typeof imp === 'string' ? imp : 'CmdOrCtrl+Shift+M',
  };
}

export function home(): string {
  return solocutHome();
}

export function settingsFile(): string {
  return settingsPath();
}

interface ZodIssueLike {
  path: (string | number)[];
  message: string;
}
function zodErrors(err: unknown): string[] {
  const issues = isObj(err) && Array.isArray(err.issues) ? (err.issues as ZodIssueLike[]) : [];
  if (issues.length === 0) return [String(err)];
  return issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(stripJsonComments(text)) }; // settings.json accepts jsonc comments
  } catch (e) {
    return { ok: false, error: `JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function validateSettingsText(text: string): ValidationResult & { value?: unknown } {
  const p = parseJsonText(text);
  if (!p.ok) return { ok: false, errors: [p.error] };
  const r = SettingsSchema.safeParse(p.value);
  return r.success ? { ok: true, errors: [], value: r.data } : { ok: false, errors: zodErrors(r.error) };
}

export function setSettingValue(key: string, value: unknown): ValidationResult {
  try {
    setSetting(key, value);
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: zodErrors(e) };
  }
}

// ---------- prompts ----------
// Two prompts only (finish / publish): built-in texts, overridable in settings.json (prompts.finish / prompts.publish).

function promptSettings(): Parameters<typeof promptsFromSettings>[0] {
  try {
    return loadSettings();
  } catch {
    return undefined;
  }
}

export function promptButtons(_dir?: string): PromptButton[] {
  const lang = language();
  return promptsFromSettings(promptSettings()).map((p) => {
    const b: PromptButton = {
      id: p.id,
      label: p.label[lang],
      text: p.body[lang] ?? p.body.ja ?? '',
      defaultText: defaultPromptText(p.id, lang),
    };
    if (p.agent && p.agent !== 'default') b.agent = p.agent;
    if (p.autopilot) b.autopilot = true;
    if (p.overridden) b.overridden = true;
    return b;
  });
}

export function renderPromptText(id: string, _dir: string | undefined, vars: Record<string, string>): { text: string; agent?: string } {
  if (!isPromptId(id)) throw new Error(`prompt not found: ${id}`);
  const { text, prompt } = renderPromptById(id, vars, language(), promptSettings());
  return prompt.agent && prompt.agent !== 'default' ? { text, agent: prompt.agent } : { text };
}

// ---------- templates ----------

export function templates(): TemplateInfo[] {
  const list = listTemplates() as unknown as Dict[];
  const lang = language();
  return list.map((t) => {
    const targets = Array.isArray(t.targets) ? t.targets.map(String) : [];
    // docs/18: families declare an `outputs` map (youtube / tiktok / youtube-shorts)
    const outputs = isObj(t.outputs) ? Object.keys(t.outputs) : targets;
    const info: TemplateInfo = {
      id: String(t.id),
      version: String(t.version ?? '1'),
      name: isObj(t.name) ? { ja: String(t.name.ja ?? t.id), en: String(t.name.en ?? t.id) } : { ja: String(t.id), en: String(t.id) },
      kind: t.kind === 'talk' ? 'talk' : 'tech',
      targets,
      outputs,
    };
    if (isObj(t.description)) info.description = String(t.description[lang] ?? t.description.ja ?? '');
    else if (typeof t.description === 'string') info.description = t.description;
    if (t.alias === true || typeof t.aliasOf === 'string') info.alias = true;
    return info;
  });
}

// ---------- agents ----------

export async function agents(): Promise<AgentStatus[]> {
  const os = osName();
  // search the login shell's PATH + common install dirs (Finder-launched apps get a short PATH)
  let detected = await detectAgents({ path: (await searchDirs()).join(delimiter) });
  if (shellPathIsProvisional() && detected.some((d) => !d.installed)) {
    // last launch's PATH may be stale: retry once with a fresh login shell PATH
    detected = await detectAgents({ path: (await searchDirs({ fresh: true })).join(delimiter) });
  }
  return AGENTS.map((def) => {
    const d = detected.find((x) => x.id === def.id);
    const s: AgentStatus = {
      id: def.id,
      label: def.label,
      installed: d?.installed ?? false,
      install: def.install[os],
      command: def.command,
    };
    if (d?.version) s.version = d.version;
    if (d?.path) s.path = d.path;
    if (def.update) s.update = def.update;
    return s;
  });
}

/** Shell command line that starts an agent (built-in or settings.agents.custom). */
export function agentCommand(id: string): string | null {
  const custom = getPath(settingsObject(), 'agents.custom');
  const def = getAgent(id, Array.isArray(custom) ? (custom as Parameters<typeof getAgent>[1]) : []);
  if (!def) return null;
  return launchCommand(def, process.platform === 'win32' ? 'powershell' : 'posix');
}

// ---------- toolchain ----------


export async function tools(): Promise<ToolState[]> {
  const st = (await toolStatus()) as Record<string, { installed: boolean; path?: string; version?: string }>;
  return Object.entries(st).map(([name, v]) => {
    const t: ToolState = { name, installed: v.installed };
    if (v.path) t.path = v.path;
    if (v.version) t.version = v.version;
    return t;
  });
}

