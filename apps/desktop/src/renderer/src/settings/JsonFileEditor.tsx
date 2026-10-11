import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { CircleCheck, CircleAlert, RotateCcw, Save } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { invokeOptional } from '../shell/agentUsage';
import { useST } from '../shell/i18n';
import { Button, Switch, useToast } from '../ui';
import { monaco } from './monaco';

type CodeEditor = Parameters<OnMount>[0];
export type JsonFileKind = 'settings' | 'prompts';

const CHANNELS = {
  settings: { read: 'settings:read', validate: 'settings:validate', write: 'settings:write', schema: 'settings:schema' },
  prompts: { read: 'prompts:readFile', validate: 'prompts:validate', write: 'prompts:writeFile', schema: 'prompts:schema' },
} as const;
const MODEL_URI: Record<JsonFileKind, string> = { settings: 'inmemory://solocut/settings.json', prompts: 'inmemory://solocut/prompts.json' };
const EMPTY: Record<JsonFileKind, string> = { settings: '{\n}\n', prompts: '{\n  "prompts": []\n}\n' };
const AUTOSAVE_KEY = 'solocut.settings.autosave';

/** Register the JSON schemas for both models once (when main provides them; TODO(desktop IPC) 'settings:schema'). */
let schemasLoaded: Promise<void> | null = null;
function loadSchemas(): Promise<void> {
  schemasLoaded ??= (async () => {
    const [s, p] = await Promise.all([invokeOptional(CHANNELS.settings.schema), invokeOptional(CHANNELS.prompts.schema)]);
    const schemas: { uri: string; fileMatch: string[]; schema: Record<string, unknown> }[] = [];
    if (s && typeof s === 'object') schemas.push({ uri: 'https://solocut.app/schema/settings.v1.json', fileMatch: [MODEL_URI.settings], schema: s as Record<string, unknown> });
    if (p && typeof p === 'object') schemas.push({ uri: 'https://solocut.app/schema/prompts.v1.json', fileMatch: [MODEL_URI.prompts], schema: p as Record<string, unknown> });
    monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, enableSchemaRequest: false, schemaRequest: 'ignore', schemas });
  })();
  return schemasLoaded;
}

/**
 * settings.json / prompts.json in the bundled Monaco (ported from Ferret src/renderer/components/SettingsJsonEditor.tsx).
 * The file is the source of truth (docs/11): main validates with the zod schema before writing, and a broken file is
 * never written. Saves with ⌘S / the button, or automatically shortly after typing stops when the text is valid.
 * Changes on disk (an agent editing the file) are taken in when there are no local edits; otherwise a bar offers to
 * reload.
 */
export default function JsonFileEditor({ kind, height = 420 }: { kind: JsonFileKind; height?: number }) {
  const t = useST();
  const toast = useToast();
  const ch = CHANNELS[kind];
  const [path, setPath] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const editorRef = useRef<CodeEditor | null>(null);
  /** last text read from or written to disk; compared with the editor to know if there are local edits */
  const baselineRef = useRef('');

  const apply = (next: string) => {
    baselineRef.current = next;
    setText(next);
    setDirty(false);
    setDiskChanged(false);
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== next) model.setValue(next);
  };

  const load = async () => {
    try {
      const d = await api.invoke(ch.read);
      setPath(d.path);
      setErrors(d.errors);
      apply(d.text || EMPTY[kind]);
    } catch (e) {
      toast({ tone: 'danger', message: errMsg(e) });
    }
  };

  useEffect(() => {
    void loadSchemas();
    void load();
    return api.on('settings:changed', () => {
      void api.invoke(ch.read).then((d) => {
        const disk = d.text || EMPTY[kind];
        const current = editorRef.current?.getValue() ?? baselineRef.current;
        if (disk === baselineRef.current || disk === current) {
          baselineRef.current = disk;
          return;
        }
        if (current === baselineRef.current) apply(disk);
        else setDiskChanged(true);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const save = async (value: string, quiet = false) => {
    setSaving(true);
    const previous = baselineRef.current;
    baselineRef.current = value; // our own write comes back as settings:changed; treat it as ours
    try {
      const r = await api.invoke(ch.write, value);
      setErrors(r.errors);
      if (!r.ok) {
        baselineRef.current = previous;
        return;
      }
      setDirty(false);
      setDiskChanged(false);
      if (!quiet) toast({ tone: 'success', message: t('settings.file.saved') });
    } catch (e) {
      baselineRef.current = previous;
      toast({ tone: 'danger', message: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // live validation by main (the zod schema) + autosave when valid
  useEffect(() => {
    if (!dirty) return;
    const value = editorRef.current?.getValue() ?? '';
    const h = window.setTimeout(async () => {
      const r = await api.invoke(ch.validate, value).catch(() => null);
      if (!r) return;
      setErrors(r.errors);
      if (r.ok && autosave && editorRef.current?.getValue() === value) void saveRef.current(value, true);
    }, 700);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, dirty, autosave]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current(editor.getValue()));
  };

  const setAuto = (on: boolean) => {
    setAutosave(on);
    try {
      localStorage.setItem(AUTOSAVE_KEY, on ? 'on' : 'off');
    } catch {
      // keep for this session
    }
  };

  return (
    <div className="st-json" data-testid={`json-editor-${kind}`}>
      <div className="st-json__bar">
        <code className="st-json__path" title={path}>
          {path}
        </code>
        {errors.length === 0 ? (
          <span className="st-json__state is-ok">
            <CircleCheck size={13} aria-hidden="true" />
            {saving ? t('settings.file.saving') : dirty ? t('settings.file.valid') : t('settings.file.savedState')}
          </span>
        ) : (
          <span className="st-json__state is-warn">
            <CircleAlert size={13} aria-hidden="true" />
            {t('settings.file.errors', { n: String(errors.length) })}
          </span>
        )}
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => void load()}>
          {t('settings.file.reload')}
        </Button>
        <Button size="sm" icon={<Save size={13} />} disabled={!dirty || errors.length > 0} busy={saving} onClick={() => void save(editorRef.current?.getValue() ?? '')}>
          {t('settings.file.save')}
        </Button>
      </div>
      {diskChanged && (
        <p className="st-note st-note--warn">
          {t('settings.file.diskChanged')}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t('settings.file.reload')}
          </Button>
        </p>
      )}
      <div className="st-json__editor" style={{ height }}>
        {text !== null && (
          <Editor
            path={MODEL_URI[kind]}
            defaultLanguage="json"
            defaultValue={text}
            theme="solocut-dark"
            onMount={onMount}
            onChange={(value) => {
              setDirty((value ?? '') !== baselineRef.current);
              setText(value ?? '');
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: "'JetBrains Mono Variable', ui-monospace, Menlo, monospace",
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              renderLineHighlight: 'line',
              padding: { top: 8 },
              editContext: false,
            }}
          />
        )}
      </div>
      {errors.length > 0 && (
        <ul className="st-json__errors" role="alert">
          {errors.slice(0, 20).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <Switch label={t('settings.file.autosave')} checked={autosave} onChange={setAuto} />
    </div>
  );
}
