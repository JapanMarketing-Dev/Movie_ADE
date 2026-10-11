import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, FolderOpen, MessageCircle, MonitorPlay, Plus } from 'lucide-react';
import type { AppInfo, Lang, RecentProject, TemplateInfo } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import iconUrl from '../assets/icon.svg';
import { Badge, Button, ListRow, Segmented } from '../ui';
import { useST } from '../shell/i18n';
import { initialOf } from '../shell/format';

const LAST_PARENT_KEY = 'solocut.lastParentDir';

export function Home({ info, onOpen, toast }: { info: AppInfo | null; onOpen: (dir: string) => void; toast: (m: string) => void }) {
  const t = useT();
  const st = useST();
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
    <div className="page home">
      <header className="home__hero">
        <img src={iconUrl} alt="" />
        <div>
          <h1>{t('home.title')}</h1>
          <p className="home__tagline">{t('home.tagline')}</p>
        </div>
      </header>

      {info && !info.cliAvailable && <div className="notice err home__notice">{t('home.cliMissing')}</div>}

      <section className="home__new" aria-label={t('home.new')}>
        <div className="home__new-head">
          <h2 className="home__h">{t('home.new')}</h2>
          <Segmented
            ariaLabel={t('home.template')}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'tech', label: t('home.kind.tech'), icon: <MonitorPlay size={13} /> },
              { value: 'talk', label: t('home.kind.talk'), icon: <MessageCircle size={13} /> },
            ]}
          />
        </div>
        <label className="home__field">
          <span className="home__label">{t('home.titleLabel')}</span>
          <input className="input home-new-title home__title" type="text" value={title} placeholder={t('home.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="home__field">
          <span className="home__label">{t('home.template')}</span>
          {templates === null ? (
            <div className="dim">{t('common.loading')}</div>
          ) : shown.length === 0 ? (
            <div className="dim">{t('home.noTemplates')}</div>
          ) : (
            <div className="tpl-grid" role="radiogroup" aria-label={t('home.template')}>
              {shown.map((tp) => (
                <button
                  key={tp.id}
                  type="button"
                  role="radio"
                  aria-checked={tp.id === template}
                  className={`tpl-card${tp.id === template ? ' is-selected' : ''}${tp.alias ? ' is-alias' : ''}`}
                  onClick={() => setTemplate(tp.id)}
                  title={tp.description}
                >
                  <OutputsPreview outputs={tp.outputs} kind={tp.kind} />
                  <span className="tpl-card__body">
                    <span className="tpl-card__name">{tp.name[lang]}</span>
                    {tp.description && <span className="tpl-card__desc">{tp.description}</span>}
                    <span className="tpl-card__meta">
                      <code>{tp.id}</code>
                      {threeVideos(tp) ? <Badge tone="brand">{st('home.threeOutputs')}</Badge> : <Badge>{st('home.outputsN', { n: String(tp.outputs.length) })}</Badge>}
                      {tp.alias && <Badge>{t('home.aliases')}</Badge>}
                    </span>
                  </span>
                  {tp.id === template && <Check size={14} className="tpl-card__check" aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="home__row">
          <div className="home__field home__field--grow">
            <span className="home__label">{t('home.folder')}</span>
            <div className="home__folder">
              <span className={`home__path${parent ? '' : ' is-empty'}`} title={parent}>
                <FolderOpen size={14} aria-hidden="true" />
                {parent || '~/Movies/Solocut'}
              </span>
              <Button onClick={() => void choose()}>{t('home.choose')}</Button>
            </div>
          </div>
          <div className="home__field">
            <span className="home__label">{t('home.language')}</span>
            <Segmented
              ariaLabel={t('home.language')}
              value={videoLang}
              onChange={setVideoLang}
              options={[
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
        </div>
        {error && <div className="notice err">{error}</div>}
        <div className="home__actions">
          <span className="home__hint">{!parent ? st('home.needFolder') : !title.trim() ? st('home.needTitle') : st('home.ready')}</span>
          <Button variant="primary" icon={<Plus size={15} />} busy={busy} disabled={!title.trim() || !template || !parent} onClick={() => void create()}>
            {busy ? t('home.creating') : t('home.create')}
          </Button>
        </div>
      </section>

      <section className="home__recent">
        <div className="home__new-head">
          <h2 className="home__h">{t('home.recent')}</h2>
          <Button variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void openFolder()}>
            {t('home.open')}
          </Button>
        </div>
        {recent.length === 0 ? (
          <div className="home__empty">{t('home.noRecent')}</div>
        ) : (
          <div className="home__list">
            {recent.map((r) => (
              <ListRow
                key={r.dir}
                className={r.exists ? '' : 'is-missing'}
                leading={<span className="home__tile">{initialOf(r.title)}</span>}
                title={r.title}
                meta={r.exists ? new Date(r.openedAt).toLocaleDateString() : undefined}
                description={<span className="home__dir">{r.dir}</span>}
                trailing={r.exists ? <ChevronRight size={14} /> : <Badge tone="warning">{t('home.missing')}</Badge>}
                onClick={() => (r.exists ? onOpen(r.dir) : toast(t('home.missing')))}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The outputs of a template as three small frames: YouTube 16:9, TikTok 9:16, Shorts 9:16 (docs/18). */
function OutputsPreview({ outputs, kind }: { outputs: string[]; kind: 'tech' | 'talk' }) {
  const st = useST();
  const frames: { id: string; label: string; vertical: boolean }[] = [
    { id: 'youtube', label: 'YouTube', vertical: false },
    { id: 'tiktok', label: 'TikTok', vertical: true },
    { id: 'youtube-shorts', label: 'Shorts', vertical: true },
  ];
  return (
    <span className={`outputs outputs--${kind}`} aria-label={st('home.outputs')}>
      {frames.map((f) => (
        <span key={f.id} className={`outputs__frame${f.vertical ? ' is-vertical' : ''}${outputs.includes(f.id) ? '' : ' is-off'}`}>
          <span className="outputs__screen" />
          {kind === 'tech' && <span className="outputs__wipe" />}
          <span className="outputs__caption" />
          <span className="outputs__label">{f.label}</span>
        </span>
      ))}
    </span>
  );
}
