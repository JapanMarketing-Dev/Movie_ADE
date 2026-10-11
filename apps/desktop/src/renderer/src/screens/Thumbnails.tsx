import { useCallback, useEffect, useState } from 'react';
import { Check, ImagePlus, RefreshCw, Sparkles, Star } from 'lucide-react';
import { Button, Segmented, Select, SettingRow, Skeleton } from '../ui';
import { useST } from '../shell/i18n';
import type { ProjectInfo, ThumbCandidate, ThumbImage, Variant } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';

export function Thumbnails({ project, toast }: { project: ProjectInfo | null; toast: (m: string) => void }) {
  const t = useT();
  const st = useST();
  const [cands, setCands] = useState<ThumbCandidate[] | null>(null);
  const [candErr, setCandErr] = useState<string | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [title, setTitle] = useState('');
  const [n, setN] = useState(3);
  const [busy, setBusy] = useState<'cands' | 'gen' | null>(null);
  const [images, setImages] = useState<ThumbImage[]>([]);
  // YouTube main → 16:9; Shorts → 9:16 (TikTok takes a cover frame time instead of an image)
  const [variant, setVariant] = useState<Variant>('main');
  const dir = project?.dir ?? null;

  const loadCands = useCallback(async () => {
    if (!dir) return;
    setBusy('cands');
    setCandErr(null);
    try {
      const r = await api.invoke('thumbs:candidates', dir, variant);
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
  }, [dir, variant, t]);

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
  }, [dir, variant]);

  const generate = async () => {
    if (!dir || frame === null) return;
    setBusy('gen');
    try {
      const r = await api.invoke('thumbs:generate', dir, { frame, n, provider, title, variant });
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
    const favs = await api.invoke('thumbs:favorite', dir, img.path, !img.favorite, variant);
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

  const picked = cands?.find((c) => c.frame === frame);
  const vertical = variant !== 'main';
  return (
    <div className="ws thumbs">
      <div className="titlebar">
        <span className="title">{t('nav.thumbnails')}</span>
        <span className="dim">{project.title}</span>
        <span className="grow" />
        <Segmented
          ariaLabel={st('thumb.size')}
          size="sm"
          value={variant}
          onChange={setVariant}
          options={[
            { value: 'main', label: `${t('var.main')} 16:9` },
            { value: 'youtube-shorts', label: `${t('var.shorts')} 9:16` },
          ]}
        />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={busy === 'cands' ? 'spin' : ''} />} disabled={busy !== null} onClick={() => void loadCands()}>
          {t('thumb.candidates')}
        </Button>
      </div>
      <div className="thumbs__body">
        <section className="thumbs__main">
          <div className="thumbs__step">
            <span className="thumbs__num">1</span>
            <h2 className="thumbs__h">{st('thumb.pickFrame')}</h2>
            <span className="thumbs__hint">{st('thumb.pickHint')}</span>
          </div>
          {cands === null ? (
            <div className={`thumbs__grid${vertical ? ' is-vertical' : ''}`}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} height={vertical ? 200 : 110} />
              ))}
            </div>
          ) : cands.length === 0 ? (
            <div className="notice">{candErr ?? t('thumb.noCandidates')}</div>
          ) : (
            <div className={`thumbs__grid${vertical ? ' is-vertical' : ''}`}>
              {cands.map((c) => (
                <button key={c.frame} type="button" className={`thumbs__card${frame === c.frame ? ' is-selected' : ''}`} onClick={() => setFrame(c.frame)}>
                  <span className="thumbs__img">
                    <img src={api.mediaUrl(c.image)} alt="" loading="lazy" />
                    <span className="thumbs__tc">{c.timecode || c.frame}</span>
                    {frame === c.frame && <Check size={14} className="thumbs__check" aria-hidden="true" />}
                  </span>
                  {c.score !== undefined && (
                    <span className="thumbs__score" title={st('thumb.score')}>
                      <span className="thumbs__score-bar" style={{ transform: `scaleX(${Math.max(0, Math.min(1, c.score))})` }} />
                      <span className="thumbs__score-num">{Math.round(c.score * 100)}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="thumbs__step">
            <span className="thumbs__num">2</span>
            <h2 className="thumbs__h">{t('thumb.results')}</h2>
            <span className="thumbs__hint">{st('thumb.resultsHint')}</span>
          </div>
          {images.length === 0 ? (
            <div className="thumbs__empty">{t('thumb.noResults')}</div>
          ) : (
            <div className={`thumbs__grid thumbs__grid--large${vertical ? ' is-vertical' : ''}`}>
              {images.map((img) => (
                <div key={img.path} className={`thumbs__card thumbs__card--result${img.favorite ? ' is-fav' : ''}`}>
                  <span className="thumbs__img">
                    <img src={api.mediaUrl(img.path)} alt="" loading="lazy" />
                    <button type="button" className={`thumbs__fav${img.favorite ? ' is-on' : ''}`} title={t('thumb.favorite')} aria-pressed={img.favorite} onClick={() => void toggleFav(img)}>
                      <Star size={14} fill={img.favorite ? 'currentColor' : 'none'} />
                    </button>
                  </span>
                  <span className="thumbs__provider">{img.provider ?? img.path.split(/[\\/]/).pop()}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <aside className="thumbs__side">
          <h2 className="thumbs__h">{st('thumb.generate')}</h2>
          <div className="thumbs__picked">
            {picked ? <img src={api.mediaUrl(picked.image)} alt="" /> : <span>{st('thumb.noFrame')}</span>}
          </div>
          <SettingRow label={t('thumb.frame')}>
            <code className="st-value st-value--mono">{picked?.timecode || frame || '—'}</code>
          </SettingRow>
          <SettingRow label={t('thumb.provider')}>
            <Select ariaLabel={t('thumb.provider')} value={provider} options={providers.map((p) => ({ value: p, label: p }))} onChange={setProvider} />
          </SettingRow>
          <label className="thumbs__field">
            <span className="st-row__label">{t('thumb.title')}</span>
            <input className="input" type="text" value={title} placeholder={t('thumb.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <SettingRow label={t('thumb.count')}>
            <Segmented
              ariaLabel={t('thumb.count')}
              size="sm"
              value={String(n) as '1' | '2' | '3' | '4'}
              onChange={(v) => setN(Number(v))}
              options={(['1', '2', '3', '4'] as const).map((x) => ({ value: x, label: x }))}
            />
          </SettingRow>
          <p className="st-note">{t('thumb.note')}</p>
          <span className="thumbs__grow" />
          <Button
            variant="primary"
            className="thumbs__go"
            icon={busy === 'gen' ? <Sparkles size={15} className="spin" /> : <ImagePlus size={15} />}
            disabled={busy !== null || frame === null}
            onClick={() => void generate()}
          >
            {busy === 'gen' ? t('thumb.generating') : t('thumb.generate')}
          </Button>
        </aside>
      </div>
    </div>
  );
}
