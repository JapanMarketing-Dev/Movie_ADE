import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Plus } from 'lucide-react';
import type { AppInfo, Lang, RecentProject, TemplateInfo } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import iconUrl from '../assets/icon.svg';

const LAST_PARENT_KEY = 'solocut.lastParentDir';

export function Home({ info, onOpen, toast }: { info: AppInfo | null; onOpen: (dir: string) => void; toast: (m: string) => void }) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'tech' | 'talk'>('tech');
  const [template, setTemplate] = useState<string>('');
  const [parent, setParent] = useState<string>(() => localStorage.getItem(LAST_PARENT_KEY) ?? '');
  const [videoLang, setVideoLang] = useState<Lang>(info?.language ?? 'ja');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke('templates:list').then(setTemplates);
    void api.invoke('project:recent').then(setRecent);
  }, []);
  useEffect(() => {
    if (info) setVideoLang(info.language);
  }, [info]);

  const lang = info?.language ?? 'ja';
  // docs/18: the tech / talk families (3 outputs) first; old ids kept as aliases are listed after them
  const shown = useMemo(
    () =>
      (templates ?? [])
        .filter((x) => x.kind === kind)
        .sort((a, b) => Number(a.alias ?? false) - Number(b.alias ?? false) || b.outputs.length - a.outputs.length || a.id.localeCompare(b.id)),
    [templates, kind],
  );
  const threeVideos = (tp: TemplateInfo) => ['youtube', 'tiktok', 'youtube-shorts'].every((o) => tp.outputs.includes(o));
  useEffect(() => {
    if (!shown.some((x) => x.id === template)) setTemplate(shown[0]?.id ?? '');
  }, [shown, template]);

  const choose = async () => {
    const d = await api.invoke('app:chooseFolder', t('home.folder'));
    if (d) {
      setParent(d);
      localStorage.setItem(LAST_PARENT_KEY, d);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.invoke('project:create', { parentDir: parent, title: title.trim(), template, language: videoLang });
      if (!r.ok || !r.data) throw new Error(r.error ?? 'solocut init failed');
      onOpen(r.data.dir);
      setTitle('');
      setRecent(await api.invoke('project:recent'));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    const d = await api.invoke('app:chooseFolder', t('home.open'));
    if (d) onOpen(d);
  };

  return (
    <div className="page">
      <div className="home-hero">
        <img src={iconUrl} alt="" />
        <div>
          <h1>{t('home.title')}</h1>
          <div className="muted">{t('home.tagline')}</div>
        </div>
      </div>

      {info && !info.cliAvailable && <div className="notice err" style={{ marginBottom: 16 }}>{t('home.cliMissing')}</div>}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <strong>{t('home.new')}</strong>
          <div className="segmented">
            <button className={kind === 'tech' ? 'on' : ''} onClick={() => setKind('tech')}>
              {t('home.kind.tech')}
            </button>
            <button className={kind === 'talk' ? 'on' : ''} onClick={() => setKind('talk')}>
              {t('home.kind.talk')}
            </button>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 14 }}>
          <label>{t('home.titleLabel')}</label>
          <input className="input home-new-title" type="text" value={title} placeholder={t('home.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 14 }}>
          <label>{t('home.template')}</label>
          {templates === null ? (
            <div className="dim">{t('common.loading')}</div>
          ) : shown.length === 0 ? (
            <div className="dim">{t('home.noTemplates')}</div>
          ) : (
            <div className="templates">
              {shown.map((tp) => (
                <button
                  key={tp.id}
                  className={`tpl ${tp.id === template ? 'selected' : ''} ${tp.alias ? 'alias' : ''}`}
                  onClick={() => setTemplate(tp.id)}
                  title={tp.description}
                >
                  <span className="name">{tp.name[lang]}</span>
                  <span className="dim mono">
                    {tp.id}
                    {tp.alias ? ` · ${t('home.aliases')}` : ''}
                  </span>
                  {threeVideos(tp) ? (
                    <span className="pill accent">{t('home.threeVideos')}</span>
                  ) : (
                    <span className="row wrap" style={{ gap: 4 }}>
                      {tp.outputs.map((x) => (
                        <span key={x} className="pill">
                          {x}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid2" style={{ gridTemplateColumns: '1fr auto', marginBottom: 16 }}>
          <div className="field">
            <label>{t('home.folder')}</label>
            <div className="row">
              <input className="input mono" style={{ flex: 1 }} type="text" readOnly value={parent} placeholder="~/Movies/Solocut" />
              <button className="btn" onClick={() => void choose()}>
                {t('home.choose')}
              </button>
            </div>
          </div>
          <div className="field">
            <label>{t('home.language')}</label>
            <div className="segmented">
              <button className={videoLang === 'ja' ? 'on' : ''} onClick={() => setVideoLang('ja')}>
                日本語
              </button>
              <button className={videoLang === 'en' ? 'on' : ''} onClick={() => setVideoLang('en')}>
                English
              </button>
            </div>
          </div>
        </div>
        {error && <div className="notice err" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !title.trim() || !template || !parent} onClick={() => void create()}>
            <Plus size={15} /> {busy ? t('home.creating') : t('home.create')}
          </button>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('home.recent')}</h2>
        <button className="btn ghost small" onClick={() => void openFolder()}>
          <FolderOpen size={14} /> {t('home.open')}
        </button>
      </div>
      {recent.length === 0 ? (
        <div className="card empty">{t('home.noRecent')}</div>
      ) : (
        <div className="recent">
          {recent.map((r) => (
            <button
              key={r.dir}
              onClick={() => (r.exists ? onOpen(r.dir) : toast(t('home.missing')))}
              style={{ opacity: r.exists ? 1 : 0.5 }}
            >
              <span>{r.title}</span>
              <span className="dim">{r.exists ? new Date(r.openedAt).toLocaleDateString() : t('home.missing')}</span>
              <span className="path mono">{r.dir}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
