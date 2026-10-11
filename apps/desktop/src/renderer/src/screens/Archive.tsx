import { useEffect, useState } from 'react';
import { BookmarkPlus, Film, Search } from 'lucide-react';
import type { ArchiveDetail, ArchiveListItem, ProjectInfo } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';

function fmtDur(sec?: number): string {
  if (sec === undefined) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ArchiveScreen({ project, toast }: { project: ProjectInfo | null; toast: (m: string) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ArchiveListItem[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);

  useEffect(() => {
    const h = window.setTimeout(() => void api.invoke('archive:list', q).then(setItems), 200);
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

  return (
    <div className="arc">
      <div className="arc-list">
        <h1 style={{ fontSize: 20, margin: '8px 0 14px' }}>{t('arc.title')}</h1>
        <div className="row">
          <Search size={15} color="#6f727a" />
          <input className="input" style={{ flex: 1 }} type="search" placeholder={t('arc.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {items === null ? (
          <div className="empty">{t('common.loading')}</div>
        ) : items.length === 0 ? (
          <div className="empty">{t('arc.empty')}</div>
        ) : (
          <div className="arc-grid">
            {items.map((it) => (
              <button key={it.id} className={`arc-card ${sel === it.id ? 'sel' : ''}`} onClick={() => setSel(it.id)}>
                <div className="thumb">{it.thumbnailUrl ? <img src={it.thumbnailUrl} alt="" /> : <Film size={26} />}</div>
                <div className="meta">
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
                  <div className="dim row" style={{ gap: 6, fontSize: 11.5 }}>
                    {it.kind && <span>{it.kind}</span>}
                    {it.template && <span className="mono">{it.template}</span>}
                    <span style={{ marginLeft: 'auto' }}>{fmtDur(it.durationSec)}</span>
                  </div>
                  {it.createdAt && <div className="dim" style={{ fontSize: 11 }}>{new Date(it.createdAt).toLocaleDateString()}</div>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <aside className="arc-detail">
        {!detail ? (
          <div className="dim">{sel ? t('common.loading') : ''}</div>
        ) : (
          <>
            <div className="thumb" style={{ aspectRatio: '16/9', background: '#000', borderRadius: 8, overflow: 'hidden', marginBottom: 12, display: 'grid', placeItems: 'center' }}>
              {detail.entry.thumbnailUrl ? <img src={detail.entry.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Film size={30} color="#6f727a" />}
            </div>
            <h2 style={{ margin: '0 0 4px', fontSize: 16, color: 'var(--text)' }}>{detail.entry.title}</h2>
            <div className="dim mono" style={{ marginBottom: 14 }}>
              {detail.entry.id}
            </div>
            <button className="btn primary" disabled={!project} onClick={() => void useRef_()} title={project ? project.title : t('arc.needProject')}>
              <BookmarkPlus size={14} /> {t('arc.useRef')}
            </button>
            <h2>{t('arc.stats')}</h2>
            <div className="stats">
              {Object.entries(detail.stats).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <span className="k">{k}</span>
                  <span className="mono">{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
            </div>
            {detail.overview && (
              <>
                <h2>{t('ws.timeline')}</h2>
                <div className="dim">
                  {t('ws.lane.segments')} {detail.overview.lanes.segments.length} · {t('ws.lane.captions')} {detail.overview.lanes.captions.length} ·{' '}
                  {t('ws.lane.scenes')} {detail.overview.lanes.scenes.length} · {t('ws.lane.sfx')} {detail.overview.lanes.sfx.length}
                </div>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
