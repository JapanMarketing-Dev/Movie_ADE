import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPTS, SettingsError, SettingsSchema, applySetting, defaultSettings, diffSettings, getSetting, loadPrompts,
  loadPromptsWithErrors, loadSettings, loadSettingsWithErrors, mergePrompts, parseCliValue, parseSettings, promptsJsonSchema,
  renderPrompt, saveSettings, setSetting, settingsHistoryPath, settingsJsonSchema, settingsPath, stripJsonComments,
} from '../src/index.js';

let home: string;
const saved = process.env.SOLOCUT_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solocut-set-'));
  process.env.SOLOCUT_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SOLOCUT_HOME;
  else process.env.SOLOCUT_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('defaults', () => {
  it('fills every section from an empty object', () => {
    const s = defaultSettings();
    expect(s.language).toBe('ja');
    expect(s.agents.order).toEqual(['claude', 'codex', 'gemini']);
    expect(s.agents.failover.enabled).toBe(true);
    expect(s.recording.camera).toEqual({ deviceId: 'default', width: 1920, height: 1080, fps: 30 });
    expect(s.decision.provider).toBe('auto');
    expect(s.decision.limits).toEqual({ perProjectUsd: 2, perDayUsd: 5, perProjectCalls: 200 });
    expect(s.library.download).toBe('on-demand');
    expect(s.autopilot).toEqual({ stopBefore: ['publish'], maxFixLoops: 3, notify: ['done', 'needs-human'], budget: { decisionUsd: 2 } });
    expect(s.telemetry.crashReports).toBe(true);
    expect(s.updates).toEqual({ channel: 'stable', auto: true });
    expect(s.imageGen.providers.openai).toMatchObject({ via: 'api', model: 'gpt-image-2' });
  });

  it('has no theme option', () => {
    expect(Object.keys(defaultSettings().appearance)).not.toContain('theme');
  });

  it('missing file → defaults without errors', () => {
    expect(loadSettingsWithErrors()).toEqual({ settings: defaultSettings(), errors: [] });
  });

  it('partially filled section keeps the rest of the defaults', () => {
    const s = SettingsSchema.parse({ recording: { camera: { fps: 60 } } });
    expect(s.recording.camera).toEqual({ deviceId: 'default', width: 1920, height: 1080, fps: 60 });
    expect(s.recording.hotkeys.markNg).toBe('CmdOrCtrl+Shift+N');
  });
});

describe('loading broken files', () => {
  it('invalid JSON → defaults + error', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(settingsPath(), '{ "language": "en", ');
    const r = loadSettingsWithErrors();
    expect(r.settings).toEqual(defaultSettings());
    expect(r.errors[0]!.message).toMatch(/invalid JSON/);
  });

  it('non-object JSON → defaults + error', () => {
    expect(parseSettings('[1,2]').errors[0]!.path).toBe('(root)');
    expect(parseSettings('null').settings).toEqual(defaultSettings());
  });

  it('an invalid section falls back to defaults but keeps valid ones', () => {
    const r = parseSettings(JSON.stringify({ language: 'en', recording: { camera: { fps: 31 } }, decision: { provider: 'ollama' } }));
    expect(r.settings.language).toBe('en');
    expect(r.settings.decision.provider).toBe('ollama');
    expect(r.settings.recording.camera.fps).toBe(30);
    expect(r.errors.map((e) => e.path)).toContain('recording.camera.fps');
  });

  it('invalid top-level value is reported with its path', () => {
    const r = parseSettings(JSON.stringify({ language: 'fr' }));
    expect(r.settings.language).toBe('ja');
    expect(r.errors[0]!.path).toBe('language');
  });

  it('accepts jsonc comments (but not inside strings)', () => {
    const r = parseSettings('{\n // comment\n "language": "en", /* block */ "agents": { "order": ["codex"] },\n "recording": { "hotkeys": { "markNg": "a//b" } } }');
    expect(r.errors).toEqual([]);
    expect(r.settings.language).toBe('en');
    expect(r.settings.recording.hotkeys.markNg).toBe('a//b');
    expect(stripJsonComments('"/* x */"')).toBe('"/* x */"');
  });

  it('unknown keys are dropped, not fatal', () => {
    expect(parseSettings(JSON.stringify({ foo: 1, appearance: { theme: 'light' } })).errors).toEqual([]);
  });
});

describe('save and history', () => {
  it('writes atomically with $schema and logs changes', () => {
    const s = defaultSettings();
    s.language = 'en';
    saveSettings(s);
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(raw.$schema).toMatch(/settings\.v1\.json$/);
    expect(raw.language).toBe('en');
    expect(loadSettings().language).toBe('en');
    const lines = readFileSync(settingsHistoryPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).changes).toEqual([{ key: 'language', from: 'ja', to: 'en' }]);
  });

  it('does not log when nothing changed', () => {
    saveSettings(defaultSettings());
    expect(existsSync(settingsHistoryPath())).toBe(false);
  });

  it('refuses to save invalid settings', () => {
    const s = defaultSettings() as unknown as { language: string };
    s.language = 'xx';
    expect(() => saveSettings(s as never)).toThrow(SettingsError);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('diffSettings treats arrays as leaves', () => {
    expect(diffSettings({ a: { b: [1] } }, { a: { b: [1, 2] } })).toEqual([{ key: 'a.b', from: [1], to: [1, 2] }]);
  });
});

describe('get/set by dot path', () => {
  it('gets nested values and undefined for unknown keys', () => {
    expect(getSetting('decision.limits.perDayUsd')).toBe(5);
    expect(getSetting('agents.order.0')).toBe('claude');
    expect(getSetting('nope.nothing')).toBeUndefined();
    expect(getSetting('agents.order.x')).toBeUndefined();
  });

  it('sets, validates and persists', () => {
    const s = setSetting('recording.camera.fps', 60);
    expect(s.recording.camera.fps).toBe(60);
    expect(getSetting('recording.camera.fps')).toBe(60);
    setSetting('agents.order', ['codex', 'claude']);
    expect(loadSettings().agents.order).toEqual(['codex', 'claude']);
    setSetting('agents.order.1', 'gemini');
    expect(loadSettings().agents.order).toEqual(['codex', 'gemini']);
  });

  it('allows new keys inside records', () => {
    setSetting('imageGen.providers.mine', { via: 'api', apiKeyRef: 'mine' });
    expect(loadSettings().imageGen.providers.mine).toEqual({ via: 'api', apiKeyRef: 'mine' });
  });

  it('agents.order accepts any catalog agent id and custom ones', () => {
    expect(setSetting('agents.order', ['aider', 'claude', 'custom:mine']).agents.order).toEqual(['aider', 'claude', 'custom:mine']);
  });

  it('decision.provider accepts auto and the agent CLIs', () => {
    for (const v of ['auto', 'claude-cli', 'codex-cli', 'gemini-cli', 'off', 'ollama']) expect(setSetting('decision.provider', v).decision.provider).toBe(v);
  });

  it('rejects invalid values with issues', () => {
    try {
      setSetting('recording.camera.fps', 61);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect((e as SettingsError).issues[0]!.path).toBe('recording.camera.fps');
    }
    expect(() => setSetting('decision.limits.perDayUsd', -1)).toThrow(/invalid value/);
    expect(() => setSetting('language', 'de')).toThrow(SettingsError);
    expect(() => setSetting('agents.order', ['Not An Agent!'])).toThrow(SettingsError);
    expect(() => setSetting('decision.endpoint', 'not a url')).toThrow(SettingsError);
    expect(() => setSetting('decision.provider', 'chatgpt-web')).toThrow(SettingsError);
    expect(() => setSetting('decision.limits.perProjectCalls', 1.5)).toThrow(SettingsError);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('rejects unknown keys and malformed paths', () => {
    expect(() => setSetting('appearance.theme', 'light')).toThrow(/unknown setting/);
    expect(() => setSetting('bogus', 1)).toThrow(/unknown setting/);
    expect(() => setSetting('a..b', 1)).toThrow(/invalid key/);
    expect(() => setSetting('', 1)).toThrow(/invalid key/);
    expect(() => setSetting('.language', 'en')).toThrow(/invalid key/);
    expect(() => setSetting('$schema', 'x')).toThrow(SettingsError);
    expect(() => setSetting('agents.order.x', 'claude')).toThrow(/array index/);
    expect(() => applySetting(defaultSettings(), 'appearance.__proto__', {})).toThrow(SettingsError);
  });

  it('parseCliValue reads JSON when possible', () => {
    expect(parseCliValue('60')).toBe(60);
    expect(parseCliValue('true')).toBe(true);
    expect(parseCliValue('["a"]')).toEqual(['a']);
    expect(parseCliValue('hello')).toBe('hello');
    expect(parseCliValue('{bad')).toBe('{bad');
  });

  it('exports a JSON schema with all sections', () => {
    const js = settingsJsonSchema() as { properties: Record<string, unknown>; $id: string };
    expect(js.$id).toMatch(/settings\.v1\.json/);
    for (const k of ['language', 'agents', 'recording', 'decision', 'autopilot', 'telemetry']) expect(js.properties).toHaveProperty(k);
  });
});

describe('prompts', () => {
  it('ships every prompt from docs/13 and docs/17 with ja and en bodies', () => {
    const ids = DEFAULT_PROMPTS.map((p) => p.id);
    for (const id of ['finish', 'rough-cut', 'fix-feedback', 'fix-checks', 'captions-polish', 'shorts', 'thumbnail', 'metadata', 'publish', 'announce', 'english', 'same-as-last', 'like-past', 'compare-past', 'learn', 'bench-apply']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of DEFAULT_PROMPTS) {
      expect(p.body.ja, p.id).toBeTruthy();
      expect(p.body.en, p.id).toBeTruthy();
      expect(p.label.ja && p.label.en).toBeTruthy();
    }
  });

  it('finish drives the solocut next loop and never publishes', () => {
    const f = DEFAULT_PROMPTS.find((p) => p.id === 'finish')!;
    expect(f.autopilot).toBe(true);
    expect(f.body.ja).toContain('solocut next --json');
    expect(f.body.ja).toContain('投稿はしないでください');
    expect(f.body.en).toContain('Do not publish');
  });

  it('thumbnail goes to an image-capable agent', () => {
    expect(DEFAULT_PROMPTS.find((p) => p.id === 'thumbnail')!.agent).toBe('codex');
  });

  it('merges overrides, additions and hides', () => {
    const errors: string[] = [];
    const out = mergePrompts(DEFAULT_PROMPTS, [
      { id: 'finish', body: { ja: '短く' } },
      { id: 'english', hidden: true },
      { id: 'mine', label: { ja: '自分用', en: 'Mine' }, body: { en: 'do it' }, agent: 'claude' },
      { id: 'broken', body: { ja: 'x' } },
    ], errors);
    const finish = out.find((p) => p.id === 'finish')!;
    expect(finish.body.ja).toBe('短く');
    expect(finish.body.en).toContain('Finish'); // other language kept
    expect(finish.label.ja).toBe('動画を完成させて');
    expect(out.find((p) => p.id === 'english')!.hidden).toBe(true);
    expect(out.find((p) => p.id === 'mine')).toMatchObject({ agent: 'claude', label: { en: 'Mine' } });
    expect(out.find((p) => p.id === 'broken')).toBeUndefined();
    expect(errors[0]).toMatch(/broken/);
    // the defaults are not mutated
    expect(DEFAULT_PROMPTS.find((p) => p.id === 'finish')!.body.ja).not.toBe('短く');
  });

  it('loads user then project files; project wins; hidden removed', () => {
    writeFileSync(join(home, 'prompts.json'), JSON.stringify({ prompts: [{ id: 'finish', body: { ja: 'user' } }, { id: 'english', hidden: true }] }));
    const proj = join(home, 'proj');
    mkdirSync(join(proj, '.solocut'), { recursive: true });
    writeFileSync(join(proj, '.solocut', 'prompts.json'), JSON.stringify({ prompts: [{ id: 'finish', body: { ja: 'project' } }, { id: 'english', hidden: false }] }));
    expect(loadPrompts().find((p) => p.id === 'finish')!.body.ja).toBe('user');
    expect(loadPrompts().find((p) => p.id === 'english')).toBeUndefined();
    expect(loadPrompts(undefined, { includeHidden: true }).find((p) => p.id === 'english')).toBeDefined();
    const pp = loadPrompts(proj);
    expect(pp.find((p) => p.id === 'finish')!.body.ja).toBe('project');
    expect(pp.find((p) => p.id === 'english')).toBeDefined();
  });

  it('a broken prompts.json is reported and ignored', () => {
    writeFileSync(join(home, 'prompts.json'), '{oops');
    const r = loadPromptsWithErrors();
    expect(r.prompts.length).toBe(DEFAULT_PROMPTS.length);
    expect(r.errors[0]!.message).toMatch(/invalid JSON/);
    writeFileSync(join(home, 'prompts.json'), JSON.stringify({ prompts: [{ id: 'Bad ID' }] }));
    expect(loadPromptsWithErrors().errors).toHaveLength(1);
  });

  it('renders vars, falls back to the other language, blanks unknown vars', () => {
    const p = { id: 'x', label: { ja: 'x', en: 'x' }, agent: 'default', body: { ja: '{{template}} / {{ project }} / {{nope}} / {{date}}' } };
    const out = renderPrompt(p, { template: 'talk-youtube', project: 'p1' }, 'en');
    expect(out).toMatch(/^talk-youtube \/ p1 \/  \/ \d{4}-\d{2}-\d{2}$/);
    expect(renderPrompt({ ...p, body: {} }, {}, 'ja')).toBe('');
    const finish = DEFAULT_PROMPTS.find((x) => x.id === 'finish')!;
    expect(renderPrompt(finish, { template: 'tech-tutorial', project: 'demo' }, 'ja')).toContain('テンプレート tech-tutorial');
    expect(renderPrompt(finish, {}, 'ja')).not.toContain('{{');
  });

  it('exports a prompts JSON schema', () => {
    expect((promptsJsonSchema() as { $id: string }).$id).toMatch(/prompts\.v1/);
  });
});
