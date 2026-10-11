import { describe, expect, it } from 'vitest';
import { activeSectionAt, filterSettingsSections, getPath, moveItem, parseSettingsText, preferFirst, SETTINGS_SECTIONS, type SettingsSectionId } from '../src/renderer/src/settings/settingsSections';
import { goToStep, initialOnboarding, isLastStep, markOnboarding, nextStep, ONBOARDING_KEY, ONBOARDING_STEPS, prevStep, shouldShowOnboarding, type StorageLike } from '../src/renderer/src/onboarding/flow';
import { SHELL_DICT } from '../src/renderer/src/shell/i18n';

const title = (id: SettingsSectionId) => `Title ${id}`;

describe('settings sections', () => {
  it('returns every section for an empty query, in list order', () => {
    expect(filterSettingsSections('', title)).toEqual([...SETTINGS_SECTIONS]);
    expect(filterSettingsSections('   ', title)).toEqual([...SETTINGS_SECTIONS]);
  });
  it('finds sections by item words in English and Japanese', () => {
    expect(filterSettingsSections('fps', title)).toEqual(['recording']);
    expect(filterSettingsSections('マイク', title)).toContain('recording');
    expect(filterSettingsSections('whisper', title)).toEqual(expect.arrayContaining(['transcription', 'library']));
    expect(filterSettingsSections('サブスク', title)).toContain('decision');
    expect(filterSettingsSections('prompts.json', title)).toEqual(['prompts']);
  });
  it('ANDs words, folds width and case', () => {
    expect(filterSettingsSections('ＦＰＳ', title)).toEqual(['recording']);
    expect(filterSettingsSections('camera fps', title)).toEqual(['recording']);
    expect(filterSettingsSections('camera beta', title)).toEqual([]);
  });
  it('matches the current-language title too', () => {
    expect(filterSettingsSections('title about', (id) => (id === 'about' ? 'Title About' : 'x'))).toEqual(['about']);
  });
  it('picks the section being read from scroll positions', () => {
    expect(activeSectionAt([])).toBeNull();
    const tops = [
      { id: 'general' as const, top: -400 },
      { id: 'appearance' as const, top: -10 },
      { id: 'language' as const, top: 300 },
    ];
    expect(activeSectionAt(tops)).toBe('appearance');
    expect(activeSectionAt([{ id: 'general', top: 100 }, { id: 'appearance', top: 400 }])).toBe('general');
    expect(activeSectionAt(tops, 400)).toBe('language');
  });
  it('has a title in both languages for every section', () => {
    for (const id of SETTINGS_SECTIONS) {
      const key = `settings.section.${id}` as keyof (typeof SHELL_DICT)['ja'];
      expect(SHELL_DICT.ja[key]).toBeTruthy();
      expect(SHELL_DICT.en[key]).toBeTruthy();
    }
  });
});

describe('settings helpers', () => {
  it('reads dotted paths without crashing on non-objects', () => {
    const o = { recording: { camera: { fps: 60 }, list: [1] } };
    expect(getPath(o, 'recording.camera.fps')).toBe(60);
    expect(getPath(o, 'recording.camera.width')).toBeUndefined();
    expect(getPath(o, 'recording.list.0')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
    expect(getPath('str', 'length')).toBeUndefined();
  });
  it('parses settings text: missing file is {}, broken or non-object is undefined', () => {
    expect(parseSettingsText('')).toEqual({});
    expect(parseSettingsText(undefined)).toEqual({});
    expect(parseSettingsText('{"language":"en"}')).toEqual({ language: 'en' });
    expect(parseSettingsText('{"a":')).toBeUndefined();
    expect(parseSettingsText('[1,2]')).toBeUndefined();
    expect(parseSettingsText('null')).toBeUndefined();
    expect(parseSettingsText('// c\n{}')).toBeUndefined();
  });
  it('moves an id to the front without duplicates', () => {
    expect(preferFirst(['codex', 'gemini', 'openai'], 'openai')).toEqual(['openai', 'codex', 'gemini']);
    expect(preferFirst(['codex'], 'codex')).toEqual(['codex']);
    expect(preferFirst([], 'x')).toEqual(['x']);
    expect(preferFirst(['a', 'x', 'x'], 'x')).toEqual(['x', 'a']);
  });
  it('moves list items within bounds only', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a'], 5, -1)).toEqual(['a']);
    const src = ['a', 'b'];
    moveItem(src, 0, 1);
    expect(src).toEqual(['a', 'b']);
  });
});

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe('onboarding flow', () => {
  it('walks the steps forward and back within bounds', () => {
    let s = initialOnboarding();
    expect(s.step).toBe('language');
    s = prevStep(s);
    expect(s.step).toBe('language');
    for (let i = 0; i < 10; i++) s = nextStep(s);
    expect(s.step).toBe('project');
    expect(isLastStep(s.step)).toBe(true);
    expect(s.visited).toEqual([...ONBOARDING_STEPS]);
    expect(prevStep(s).step).toBe('permissions');
  });
  it('jumps only to visited steps', () => {
    const s = nextStep(initialOnboarding());
    expect(goToStep(s, 'project')).toBe(s);
    expect(goToStep(s, 'language').step).toBe('language');
    expect(nextStep(goToStep(s, 'language')).visited).toEqual(['language', 'agents']);
  });
  it('shows once for new users, never after completion, done / skipped or with projects', () => {
    const show = (completedAt: unknown, storage: StorageLike | null, recentCount: number) => shouldShowOnboarding({ completedAt, storage, recentCount });
    expect(show(null, memStorage(), 0)).toBe(true);
    expect(show(undefined, memStorage(), 0)).toBe(true);
    expect(show('2026-10-11T10:00:00Z', memStorage(), 0)).toBe(false);
    expect(show('', memStorage(), 0)).toBe(true);
    expect(show(42, memStorage(), 0)).toBe(true);
    expect(show(null, memStorage(), 2)).toBe(false);
    expect(show(null, memStorage({ [ONBOARDING_KEY]: 'done' }), 0)).toBe(false);
    expect(show(null, memStorage({ [ONBOARDING_KEY]: 'skipped' }), 0)).toBe(false);
    expect(show(null, memStorage({ [ONBOARDING_KEY]: 'other' }), 0)).toBe(true);
    expect(show(null, null, 0)).toBe(true);
  });
  it('survives storage that throws', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(shouldShowOnboarding({ completedAt: null, storage: broken, recentCount: 0 })).toBe(true);
    expect(() => markOnboarding(broken, 'done')).not.toThrow();
    const ok = memStorage();
    markOnboarding(ok, 'skipped');
    expect(ok.data[ONBOARDING_KEY]).toBe('skipped');
  });
});

describe('shell dictionary', () => {
  it('has the same keys in Japanese and English, none empty', () => {
    const ja = Object.keys(SHELL_DICT.ja).sort();
    const en = Object.keys(SHELL_DICT.en).sort();
    expect(en).toEqual(ja);
    for (const k of ja) {
      expect(SHELL_DICT.ja[k as keyof (typeof SHELL_DICT)['ja']].trim()).not.toBe('');
      expect(SHELL_DICT.en[k as keyof (typeof SHELL_DICT)['ja']].trim()).not.toBe('');
    }
  });
  it('uses the same {placeholders} in both languages', () => {
    for (const k of Object.keys(SHELL_DICT.ja) as (keyof (typeof SHELL_DICT)['ja'])[]) {
      const vars = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
      expect(vars(SHELL_DICT.en[k]), k).toEqual(vars(SHELL_DICT.ja[k]));
    }
  });
});
