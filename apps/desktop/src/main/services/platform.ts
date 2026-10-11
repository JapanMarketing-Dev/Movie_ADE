// The only module in the app that imports the @solocut/* platform packages (APIs per docs/dev/CONTRACTS.md).
// Everything here converts package types to the app's shared types and never throws to the IPC layer for
// "package not ready" situations: callers get empty lists and an error string instead.
import { AGENTS, detectAgents, getAgent, launchCommand } from '@solocut/agents';
import { getArchive, listArchive, searchArchive } from '@solocut/archive';
import {
  PromptsSchema,
  SettingsSchema,
  loadPrompts,
  loadSettings,
  renderPrompt,
  saveSettings,
  setSetting,
  settingsPath,
  stripJsonComments,
} from '@solocut/settings';
import { listTemplates } from '@solocut/templates';
import { ensureTool, solocutHome, toolStatus } from '@solocut/toolchain';
import type {
  AgentStatus,
  ArchiveDetail,
  ArchiveListItem,
  Lang,
  OsName,
  PromptButton,
  TemplateInfo,
  ToolState,
  ValidationResult,
} from '../../shared/types';
import { timelineOverview } from '../../shared/project';
import { mediaUrl } from '../../shared/ipc';
import { existsSync } from 'node:fs';
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

export function promptsFile(): string {
  return join(solocutHome(), 'prompts.json');
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
    return { ok: true, value: JSON.parse(stripJsonComments(text)) }; // settings and prompts accept jsonc comments
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

export function writeSettingsValue(value: unknown): void {
  saveSettings(value as Parameters<typeof saveSettings>[0]);
}

export function setSettingValue(key: string, value: unknown): ValidationResult {
  try {
    setSetting(key, value);
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: zodErrors(e) };
  }
}

export function validatePromptsText(text: string): ValidationResult {
  const p = parseJsonText(text);
  if (!p.ok) return { ok: false, errors: [p.error] };
  const r = PromptsSchema.safeParse(p.value);
  return r.success ? { ok: true, errors: [] } : { ok: false, errors: zodErrors(r.error) };
}

// ---------- prompts ----------

interface PromptLike {
  id: string;
  label?: { ja?: string; en?: string } | string;
  agent?: string;
  autopilot?: boolean;
  hidden?: boolean;
}

function promptsFor(dir?: string): PromptLike[] {
  const list = loadPrompts(dir) as unknown;
  return Array.isArray(list) ? (list.filter((p) => isObj(p) && typeof p.id === 'string') as unknown as PromptLike[]) : [];
}

export function promptButtons(dir?: string): PromptButton[] {
  const lang = language();
  return promptsFor(dir)
    .filter((p) => !p.hidden)
    .map((p) => {
      const label = typeof p.label === 'string' ? p.label : (p.label?.[lang] ?? p.label?.ja ?? p.label?.en ?? p.id);
      const b: PromptButton = { id: p.id, label };
      if (p.agent) b.agent = p.agent;
      if (p.autopilot) b.autopilot = true;
      return b;
    });
}

export function renderPromptText(id: string, dir: string | undefined, vars: Record<string, string>): { text: string; agent?: string } {
  const p = promptsFor(dir).find((x) => x.id === id);
  if (!p) throw new Error(`prompt not found: ${id}`);
  const text = renderPrompt(p as unknown as Parameters<typeof renderPrompt>[0], vars, language());
  return p.agent ? { text, agent: p.agent } : { text };
}

// ---------- templates ----------

export function templates(): TemplateInfo[] {
  const list = listTemplates() as unknown as Dict[];
  return list.map((t) => ({
    id: String(t.id),
    version: String(t.version ?? '1'),
    name: isObj(t.name) ? { ja: String(t.name.ja ?? t.id), en: String(t.name.en ?? t.id) } : { ja: String(t.id), en: String(t.id) },
    kind: t.kind === 'talk' ? 'talk' : 'tech',
    targets: Array.isArray(t.targets) ? t.targets.map(String) : [],
  }));
}

// ---------- agents ----------

export async function agents(): Promise<AgentStatus[]> {
  const os = osName();
  const detected = await detectAgents();
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

import { TOOL_NAMES, type ToolName } from '@solocut/toolchain';

export async function tools(): Promise<ToolState[]> {
  const st = (await toolStatus()) as Record<string, { installed: boolean; path?: string; version?: string }>;
  return Object.entries(st).map(([name, v]) => {
    const t: ToolState = { name, installed: v.installed };
    if (v.path) t.path = v.path;
    if (v.version) t.version = v.version;
    return t;
  });
}

export async function installTool(name: string, onProgress: (received: number, total?: number) => void): Promise<string> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`unknown tool: ${name}`);
  return ensureTool(name as ToolName, { onProgress: (p) => onProgress(p.received, p.total) });
}

// ---------- archive ----------

function archiveItem(e: unknown): ArchiveListItem {
  const o = isObj(e) ? e : {};
  const summary = isObj(o.summary) ? o.summary : o;
  const id = String(o.id ?? '');
  const item: ArchiveListItem = { id, title: String(summary.title ?? o.title ?? id), raw: e };
  const kind = summary.kind ?? o.kind;
  const template = isObj(summary.template) ? summary.template.id : (summary.template ?? o.template);
  const created = o.createdAt ?? o.created ?? summary.created;
  const dur = summary.durationSec ?? o.durationSec;
  if (typeof kind === 'string') item.kind = kind;
  if (typeof template === 'string') item.template = template;
  if (typeof created === 'string') item.createdAt = created;
  if (typeof dur === 'number') item.durationSec = dur;
  if (typeof o.projectDir === 'string') item.projectDir = o.projectDir;
  const thumb = typeof o.thumbnail === 'string' ? o.thumbnail : join(home(), 'archive', id, 'thumbnail.jpg');
  if (id && existsSync(thumb)) item.thumbnailUrl = mediaUrl(thumb);
  return item;
}

export function archiveList(query?: string): ArchiveListItem[] {
  const list = (query && query.trim() ? searchArchive(query.trim()) : listArchive({ limit: 500 })) as unknown[];
  return list.map(archiveItem);
}

export function archiveGet(id: string): ArchiveDetail | null {
  const r = getArchive(id) as unknown as { entry: unknown; timeline: unknown; stats: unknown } | null;
  if (!r) return null;
  return {
    entry: archiveItem(r.entry),
    stats: isObj(r.stats) ? r.stats : {},
    overview: r.timeline ? timelineOverview(r.timeline) : undefined,
  } as ArchiveDetail;
}

export function archiveRoot(): string {
  return join(home(), 'archive');
}
