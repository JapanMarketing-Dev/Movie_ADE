import { useEffect, useState } from 'react';
import { BookmarkPlus, Film, Search } from 'lucide-react';
import type { ArchiveDetail, ArchiveListItem, ProjectInfo } from '@shared/types';
import { useT } from '../i18n';
import { useST } from '../shell/i18n';
import { Button, EmptyState, Skeleton, Spinner, TextField } from '../ui';
import { statEntries } from './parts/screenModel';
import { api, errMsg } from '../lib/api';

function fmtDur(sec?: number): string {
  if (sec === undefined) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ArchiveScreen({ project, toast }: { project: ProjectInfo | null; toast: (m: string) => void }) {
  const t = useT();
  const st = useST();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ArchiveListItem[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);

  useEffect(() => {
    const h = window.setTimeout(
      () =>
        void api.invoke('archive:list', q).then((list) => {
          setItems(list);
          // open the newest one so the detail panel is never empty when there is something to show
          setSel((cur) => (cur && list.some((x) => x.id === cur) ? cur : (list[0]?.id ?? null)));
        }),
      200,
    );
    return () => window.clearTimeout(h);
  }, [q]);

  useEffect(() => {
    setDetail(null);
    if (sel) void api.invoke('archive:get', sel).then(setDetail);
  }, [sel]);

  const useRef_ = async () => {
    if (!project || !sel) return toast(t('arc.needProject'));
    try {
      const r = await api.invoke('archive:useAsReference', project.dir, sel);
      toast(r.ok ? t('arc.refAdded') : (r.error ?? t('common.error')));
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const stats = detail ? statEntries(detail.stats) : [];
  const ov = detail?.overview;
  return (
    <div className="gallery">
      <div className="gallery__main">
        <header className="gallery__head">
          <div>
            <h1 className="gallery__title">{t('arc.title')}</h1>
            <p className="gallery__sub">{st('arc.sub', { n: String(items?.length ?? 0) })}</p>
          </div>
          <TextField className="gallery__search" icon={<Search size={14} />} type="search" placeholder={t('arc.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </header>
        {items === null ? (
          <div className="gallery__grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="gallery__card is-skeleton">
                <Skeleton height={120} />
                <Skeleton width="70%" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title={q ? st('arc.noMatch') : st('arc.emptyTitle')} description={q ? undefined : t('arc.empty')} />
        ) : (
          <div className="gallery__grid">
            {items.map((it) => (
              <button key={it.id} type="button" className={`gallery__card${sel === it.id ? ' is-selected' : ''}`} onClick={() => setSel(it.id)}>
                <span className="gallery__thumb">
                  {it.thumbnailUrl ? <img src={it.thumbnailUrl} alt="" loading="lazy" /> : <Film size={26} />}
                  {it.durationSec !== undefined && <span className="gallery__dur">{fmtDur(it.durationSec)}</span>}
                </span>
                <span className="gallery__name">{it.title}</span>
                <span className="gallery__meta">
                  {it.kind && <span className="gallery__chip">{it.kind === 'tech' ? t('home.kind.tech') : it.kind === 'talk' ? t('home.kind.talk') : it.kind}</span>}
                  {it.template && <code className="gallery__chip">{it.template}</code>}
                  {it.createdAt && <span className="gallery__date">{new Date(it.createdAt).toLocaleDateString()}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <aside className="gallery__detail" aria-label={t('arc.stats')}>
        {!sel ? (
          <EmptyState size="sm" title={st('arc.pick')} description={st('arc.pickDesc')} />
        ) : !detail ? (
          <Spinner />
        ) : (
          <>
            <div className="gallery__hero">
              {detail.entry.thumbnailUrl ? <img src={detail.entry.thumbnailUrl} alt="" /> : <Film size={30} />}
            </div>
            <h2 className="gallery__dtitle">{detail.entry.title}</h2>
            <code className="gallery__id">{detail.entry.id}</code>
            <Button variant="primary" icon={<BookmarkPlus size={14} />} disabled={!project} onClick={() => void useRef_()} title={project ? project.title : t('arc.needProject')}>
              {t('arc.useRef')}
            </Button>
            {!project && <p className="st-note">{t('arc.needProject')}</p>}
            {ov && (
              <>
                <h3 className="gallery__h3">{t('ws.timeline')}</h3>
                <div className="stat-tiles">
                  <StatTile label={t('ws.lane.segments')} value={ov.lanes.segments.length} />
                  <StatTile label={t('ws.lane.captions')} value={ov.lanes.captions.length} />
                  <StatTile label={t('ws.lane.scenes')} value={ov.lanes.scenes.length} />
                  <StatTile label={t('ws.lane.sfx')} value={ov.lanes.sfx.length} />
                </div>
              </>
            )}
            {stats.length > 0 && (
              <>
                <h3 className="gallery__h3">{t('arc.stats')}</h3>
                <dl className="gallery__stats">
                  {stats.map(([k, v]) => (
                    <div key={k} className="gallery__stat">
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__label">{label}</span>
    </div>
  );
}
