import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { AppInfo, SettingsDoc, UpdateState } from '@shared/types';
import { useT } from '../i18n';
import { ApiKeys } from '../components/ApiKeys';
import { api, errMsg } from '../lib/api';

type Which = 'settings' | 'prompts';

function get(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function Settings({ info, toast, onSaved }: { info: AppInfo | null; toast: (m: string) => void; onSaved: () => void }) {
  const t = useT();
  const [which, setWhich] = useState<Which>('settings');
  const [doc, setDoc] = useState<SettingsDoc | null>(null);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [external, setExternal] = useState(false);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async (w: Which) => {
    const d = await api.invoke(w === 'settings' ? 'settings:read' : 'prompts:readFile');
    setDoc(d);
    setText(d.text || (w === 'settings' ? '{\n}\n' : '{\n  "prompts": []\n}\n'));
    setErrors(d.errors);
    setDirty(false);
    setExternal(false);
  }, []);

  useEffect(() => {
    void load(which);
  }, [which, load]);

  useEffect(() => {
    void api.invoke('update:state').then(setUpd);
    const off1 = api.on('update:state', setUpd);
    const off2 = api.on('settings:changed', () => {
      if (dirtyRef.current) setExternal(true);
      else void load(which);
    });
    return () => {
      off1();
      off2();
    };
  }, [which, load]);

  // live validation
  useEffect(() => {
    if (!dirty) return;
    const h = window.setTimeout(async () => {
      const r = await api.invoke(which === 'settings' ? 'settings:validate' : 'prompts:validate', text);
      setErrors(r.errors);
    }, 250);
    return () => window.clearTimeout(h);
  }, [text, dirty, which]);

  const save = async () => {
    try {
      const r = await api.invoke(which === 'settings' ? 'settings:write' : 'prompts:writeFile', text);
      setErrors(r.errors);
      if (r.ok) {
        toast(t('set.saved'));
        await load(which);
        onSaved();
      }
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const setKey = async (key: string, value: unknown) => {
    const r = await api.invoke('settings:set', key, value);
    if (!r.ok) toast(r.errors.join('\n'));
    else {
      onSaved();
      if (which === 'settings' && !dirty) await load('settings');
    }
  };

  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(doc?.text || '{}');
  } catch {
    parsed = undefined;
  }

  return (
    <div className="settings">
      <aside className="settings-side">
        <h1 style={{ fontSize: 20, margin: '8px 0 4px' }}>{t('set.title')}</h1>
        <div className="segmented">
          <button className={which === 'settings' ? 'on' : ''} onClick={() => setWhich('settings')}>
            {t('set.settingsJson')}
          </button>
          <button className={which === 'prompts' ? 'on' : ''} onClick={() => setWhich('prompts')}>
            {t('set.promptsJson')}
          </button>
        </div>
        <h2 style={{ margin: '10px 0 0' }}>{t('set.common')}</h2>
        <div className="field">
          <label>{t('set.language')}</label>
          <div className="segmented">
            <button className={info?.language === 'ja' ? 'on' : ''} onClick={() => void setKey('language', 'ja')}>
              日本語
            </button>
            <button className={info?.language === 'en' ? 'on' : ''} onClick={() => void setKey('language', 'en')}>
              English
            </button>
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={get(parsed, 'telemetry.crashReports') !== false}
            onChange={(e) => void setKey('telemetry.crashReports', e.target.checked)}
          />
          {t('set.crash')}
        </label>
        <label className="check">
          <input type="checkbox" checked={get(parsed, 'updates.auto') !== false} onChange={(e) => void setKey('updates.auto', e.target.checked)} />
          {t('set.updates')}
        </label>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>{t('set.screenFps')}</label>
            <select className="input" value={String(get(parsed, 'recording.screen.fps') ?? 30)} onChange={(e) => void setKey('recording.screen.fps', Number(e.target.value))}>
              {[30, 60].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>{t('set.cameraFps')}</label>
            <select className="input" value={String(get(parsed, 'recording.camera.fps') ?? 30)} onChange={(e) => void setKey('recording.camera.fps', Number(e.target.value))}>
              {[24, 30, 60].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>
        <h2 style={{ margin: '10px 0 0' }}>{t('keys.title')}</h2>
        <ApiKeys toast={toast} />
        <div style={{ flex: 1 }} />
        <div className="dim" style={{ fontSize: 12 }}>
          {t('set.version')} {info?.version} · {info?.os}/{info?.arch}
        </div>
        <button className="btn small" disabled={upd?.status === 'checking' || !info?.packaged} onClick={() => void api.invoke('update:check').then(setUpd)}>
          {t('set.checkUpdate')}
        </button>
        {upd && upd.status !== 'idle' && (
          <div className="dim" style={{ fontSize: 11.5 }}>
            {upd.status}
            {upd.latest ? ` · ${upd.latest}` : ''}
            {upd.error ? ` · ${upd.error}` : ''}
          </div>
        )}
      </aside>
      <section className="settings-main">
        <div className="row">
          <span className="mono dim" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc?.path}
          </span>
          {errors.length === 0 ? <span className="pill okp">{t('set.valid')}</span> : <span className="pill accent">{errors.length}</span>}
          <button className="btn small" onClick={() => void load(which)}>
            <RotateCcw size={13} /> {t('set.reload')}
          </button>
          <button className="btn small primary" disabled={!dirty || errors.length > 0} onClick={() => void save()}>
            <Save size={13} /> {t('set.save')}
          </button>
        </div>
        {external && (
          <div className="notice row" style={{ justifyContent: 'space-between' }}>
            <span>{t('set.externalChange')}</span>
            <button className="btn small" onClick={() => void load(which)}>
              {t('set.reload')}
            </button>
          </div>
        )}
        <textarea
          className="input editor"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              if (dirty && errors.length === 0) void save();
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const s = el.selectionStart;
              const v = el.value;
              setText(v.slice(0, s) + '  ' + v.slice(el.selectionEnd));
              setDirty(true);
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
          }}
        />
        {errors.length > 0 && (
          <div className="notice err mono" style={{ maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
            {errors.join('\n')}
          </div>
        )}
      </section>
    </div>
  );
}
