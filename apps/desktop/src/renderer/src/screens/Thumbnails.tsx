import { useCallback, useEffect, useState } from 'react';
import { ImagePlus, RefreshCw, Sparkles, Star } from 'lucide-react';
import type { ProjectInfo, ThumbCandidate, ThumbImage } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';

export function Thumbnails({ project, toast }: { project: ProjectInfo | null; toast: (m: string) => void }) {
  const t = useT();
  const [cands, setCands] = useState<ThumbCandidate[] | null>(null);
  const [candErr, setCandErr] = useState<string | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [title, setTitle] = useState('');
  const [n, setN] = useState(3);
  const [busy, setBusy] = useState<'cands' | 'gen' | null>(null);
  const [images, setImages] = useState<ThumbImage[]>([]);
  const dir = project?.dir ?? null;

  const loadCands = useCallback(async () => {
    if (!dir) return;
    setBusy('cands');
    setCandErr(null);
    try {
      const r = await api.invoke('thumbs:candidates', dir);
      if (r.ok && r.data) {
        setCands(r.data);
        setFrame((f) => f ?? r.data![0]?.frame ?? null);
      } else {
        setCands([]);
        setCandErr(r.error ?? t('common.error'));
      }
    } finally {
      setBusy(null);
    }
  }, [dir, t]);

  useEffect(() => {
    setCands(null);
    setFrame(null);
    setImages([]);
    if (!dir) return;
    void api.invoke('thumbs:providers').then((p) => {
      setProviders(p);
      setProvider((cur) => cur || p[0] || '');
    });
    void api.invoke('thumbs:existing', dir).then(setImages);
    void loadCands();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const generate = async () => {
    if (!dir || frame === null) return;
    setBusy('gen');
    try {
      const r = await api.invoke('thumbs:generate', dir, { frame, n, provider, title });
      if (!r.ok || !r.data) toast(`${t('thumb.genFailed')}: ${r.error ?? ''}`);
      else setImages((cur) => [...r.data!, ...cur.filter((c) => !r.data!.some((x) => x.path === c.path))]);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleFav = async (img: ThumbImage) => {
    if (!dir) return;
    const favs = await api.invoke('thumbs:favorite', dir, img.path, !img.favorite);
    setImages((xs) => xs.map((x) => ({ ...x, favorite: favs.some((f) => x.path.endsWith(f)) })));
  };

  if (!project) {
    return (
      <div className="ws">
        <div className="titlebar">
          <span className="title">{t('nav.thumbnails')}</span>
        </div>
        <div className="empty">{t('ws.noProject')}</div>
      </div>
    );
  }

  return (
    <div className="ws">
      <div className="titlebar">
        <span className="title">{t('nav.thumbnails')}</span>
        <span className="dim">{project.title}</span>
        <span className="grow" />
        <button className="btn ghost small" disabled={busy !== null} onClick={() => void loadCands()}>
          <RefreshCw size={13} className={busy === 'cands' ? 'spin' : ''} /> {t('thumb.candidates')}
        </button>
      </div>
      <div className="thumb-layout">
        <section className="thumb-main">
          <h2 style={{ marginTop: 0 }}>{t('thumb.candidates')}</h2>
          {cands === null ? (
            <div className="dim">{t('common.loading')}</div>
          ) : cands.length === 0 ? (
            <div className="notice">{candErr ?? t('thumb.noCandidates')}</div>
          ) : (
            <div className="thumb-grid">
              {cands.map((c) => (
                <button key={c.frame} className={`thumb-card ${frame === c.frame ? 'sel' : ''}`} onClick={() => setFrame(c.frame)}>
                  <img src={api.mediaUrl(c.image)} alt="" />
                  <span className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="mono dim">{c.timecode || c.frame}</span>
                    {c.score !== undefined && <span className="pill">{Math.round(c.score * 100)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <h2>{t('thumb.results')}</h2>
          {images.length === 0 ? (
            <div className="dim">{t('thumb.noResults')}</div>
          ) : (
            <div className="thumb-grid large">
              {images.map((img) => (
                <div key={img.path} className={`thumb-card ${img.favorite ? 'fav' : ''}`}>
                  <img src={api.mediaUrl(img.path)} alt="" />
                  <span className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="dim" style={{ fontSize: 11 }}>{img.provider ?? img.path.split(/[\\/]/).pop()}</span>
                    <button className="btn ghost small icon" title={t('thumb.favorite')} onClick={() => void toggleFav(img)}>
                      <Star size={14} fill={img.favorite ? '#ff4a3d' : 'none'} color={img.favorite ? '#ff4a3d' : 'currentColor'} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
        <aside className="rec-side">
          <div className="field">
            <label>{t('thumb.frame')}</label>
            <div className="mono">{frame ?? '—'}</div>
          </div>
          <div className="field">
            <label>{t('thumb.provider')}</label>
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t('thumb.title')}</label>
            <input className="input" type="text" value={title} placeholder={t('thumb.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>{t('thumb.count')}</label>
            <select className="input" value={n} onChange={(e) => setN(Number(e.target.value))}>
              {[1, 2, 3, 4].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="dim" style={{ fontSize: 12 }}>
            {t('thumb.note')}
          </div>
          <div style={{ flex: 1 }} />
          <button className="recbtn" disabled={busy !== null || frame === null} onClick={() => void generate()}>
            {busy === 'gen' ? <Sparkles size={16} className="spin" /> : <ImagePlus size={16} />} {busy === 'gen' ? t('thumb.generating') : t('thumb.generate')}
          </button>
        </aside>
      </div>
    </div>
  );
}
