import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, FolderOpen, Video } from 'lucide-react';
import type { AppInfo, VideoList, VideoStatus } from '@shared/types';
import { videoFolderName } from '@shared/videoName';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import iconUrl from '../assets/icon.svg';
import { Badge, Button, ListRow, type BadgeTone } from '../ui';
import { useST } from '../shell/i18n';
import { initialOf } from '../shell/format';
import { setSetting, settingsStore, useStore } from '../shell/stores';
import { videosRootChosen } from '../onboarding/flow';

const STATUS_TONE: Record<VideoStatus, BadgeTone> = { new: 'neutral', editing: 'neutral', done: 'brand', posted: 'success' };

/**
 * Home: the master folder (settings `videos.root`), one button that makes `<root>/<date>-<idea>/` and goes straight to
 * recording, and the videos already in the master folder. One template, the UI language — nothing else to choose.
 */
export function Home({
  info,
  onOpen,
  onCreated,
  toast,
}: {
  info: AppInfo | null;
  onOpen: (dir: string) => void | Promise<void>;
  onCreated?: (dir: string) => void;
  toast: (m: string) => void;
}) {
  const t = useT();
  const st = useST();
  const settings = useStore(settingsStore);
  const [list, setList] = useState<VideoList | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => void api.invoke('videos:list').then(setList).catch((e) => setError(errMsg(e))), []);
  useEffect(load, [load]);
  useEffect(() => api.on('settings:changed', load), [load]);

  const root = list?.root ?? '';
  // first run: ask once (the default is shown); creating a video also counts as accepting it
  const asking = settings.loaded && settings.json !== null && !videosRootChosen(settings.json);

  const keepRoot = async (dir: string) => {
    const err = await setSetting('videos.root', dir);
    if (err) toast(err);
    load();
  };

  const changeRoot = async () => {
    const d = await api.invoke('app:chooseFolder', st('home.rootPick'));
    if (d) await keepRoot(d);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      if (asking && root) await setSetting('videos.root', root);
      const r = await api.invoke('project:create', { title: title.trim() });
      if (!r.ok || !r.data) throw new Error(r.error ?? 'solocut init failed');
      const dir = r.data.dir;
      setTitle('');
      await onOpen(dir);
      onCreated?.(dir);
      window.dispatchEvent(new CustomEvent('solocut:navigate', { detail: 'record' }));
      load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    const d = await api.invoke('app:chooseFolder', t('home.open'));
    if (d) void onOpen(d);
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

      <section className="home__new" aria-label={st('home.shoot')}>
        <div className="home__field">
          <span className="home__label">{st('home.root')}</span>
          <div className="home__folder">
            <span className="home__path" title={root}>
              <FolderOpen size={14} aria-hidden="true" />
              {root || '…'}
            </span>
            <Button onClick={() => void changeRoot()}>{st('home.rootChange')}</Button>
          </div>
          {asking && (
            <div className="home__ask">
              <span>{st('home.rootAsk')}</span>
              <Button size="sm" variant="primary" disabled={!root} onClick={() => void keepRoot(root)}>
                {st('home.rootOk')}
              </Button>
            </div>
          )}
        </div>
        <label className="home__field">
          <span className="home__label">{st('home.idea')}</span>
          <input
            className="input home-new-title home__title"
            type="text"
            value={title}
            placeholder={st('home.ideaPlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) void create();
            }}
          />
        </label>
        {error && <div className="notice err">{error}</div>}
        <div className="home__actions">
          <span className="home__hint">{st('home.willCreate', { name: videoFolderName(title) })}</span>
          <Button variant="primary" className="home__shoot" icon={<Video size={16} />} busy={busy} onClick={() => void create()}>
            {busy ? st('home.shooting') : st('home.shoot')}
          </Button>
        </div>
      </section>

      <section className="home__recent">
        <div className="home__new-head">
          <h2 className="home__h">{st('home.videos')}</h2>
          <Button variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void openFolder()}>
            {st('home.openOther')}
          </Button>
        </div>
        {list?.error ? (
          <div className="notice err">{list.error === 'permission' ? st('home.rootNoAccess') : st('home.rootUnreadable', { error: list.error })}</div>
        ) : !list ? null : list.videos.length === 0 ? (
          <div className="home__empty">{st('home.videosEmpty')}</div>
        ) : (
          <div className="home__list">
            {list.videos.map((v) => (
              <ListRow
                key={v.dir}
                leading={<span className="home__tile">{initialOf(v.title)}</span>}
                title={v.title}
                meta={v.updatedAt ? new Date(v.updatedAt).toLocaleDateString() : undefined}
                description={<span className="home__dir">{v.name}</span>}
                trailing={
                  <>
                    <Badge tone={STATUS_TONE[v.status]}>{st(`home.status.${v.status}`)}</Badge>
                    <ChevronRight size={14} />
                  </>
                }
                onClick={() => void onOpen(v.dir)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
