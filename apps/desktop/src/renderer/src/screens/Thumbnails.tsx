// Thumbnails (docs/10): the agent makes them from the video's content (Codex = ChatGPT subscription image generation,
// or Gemini CLI) and saves them under thumbnails/. Here the person picks one; the pick is written to publish.json.
import { useCallback, useEffect, useState } from 'react';
import { Check, FolderOpen, ImagePlus } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../ui';
import type { ThumbFile } from '@shared/publish';
import type { ProjectInfo } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import { sendToAgent } from '../terminal/agentSend';

export function Thumbnails({ project, toast }: { project: ProjectInfo | null; toast: (m: string) => void }) {
  const t = useT();
  const dir = project?.dir ?? null;
  const [images, setImages] = useState<ThumbFile[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!dir) return;
    const [list, view] = await Promise.all([api.invoke('thumbs:list', dir), api.invoke('publish:load', dir)]);
    setImages(list);
    setSelected(view.spec?.thumbnail ?? null);
  }, [dir]);

  useEffect(() => {
    setImages(null);
    void load();
  }, [load]);
  useEffect(() => api.on('publish:changed', (d) => d === dir && void load()), [dir, load]);

  if (!project || !dir) {
    return (
      <div className="ws">
        <div className="titlebar">
          <span className="title">{t('nav.thumbnails')}</span>
        </div>
        <div className="empty">{t('ws.noProject')}</div>
      </div>
    );
  }

  const ask = async () => {
    setBusy(true);
    try {
      const res = await sendToAgent({ text: t('thumb.request'), projectDir: dir }, { launch: null });
      toast(res.ok ? t('thumb.sent') : res.message);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (img: ThumbFile) => {
    const next = selected === img.rel ? null : img.rel;
    const r = await api.invoke('publish:setThumbnail', dir, next ? img.path : null);
    if (!r.ok) toast(`${t('thumb.pickFailed')}: ${r.error ?? ''}`);
    else setSelected(next);
  };

  return (
    <div className="ws thumbs">
      <div className="titlebar">
        <span className="title">{t('nav.thumbnails')}</span>
        <span className="dim">{project.title}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void api.invoke('app:showInFolder', `${dir}/thumbnails`)}>
          thumbnails/
        </Button>
        <Button size="sm" variant="primary" icon={<ImagePlus size={13} />} busy={busy} onClick={() => void ask()}>
          {t('thumb.ask')}
        </Button>
      </div>
      <div className="thumbs__main">
        {images === null ? (
          <div className="thumbs__grid">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={160} />
            ))}
          </div>
        ) : images.length === 0 ? (
          <EmptyState
            title={t('thumb.emptyTitle')}
            description={t('thumb.emptyText')}
            actions={
              <Button variant="primary" icon={<ImagePlus size={14} />} busy={busy} onClick={() => void ask()}>
                {t('thumb.ask')}
              </Button>
            }
          />
        ) : (
          <>
            <p className="thumbs__hint">{t('thumb.pickHint')}</p>
            <div className="thumbs__grid">
              {images.map((img) => (
                <button
                  key={img.rel}
                  type="button"
                  className={`thumbs__card${selected === img.rel ? ' is-selected' : ''}`}
                  aria-pressed={selected === img.rel}
                  onClick={() => void pick(img)}
                >
                  <span className="thumbs__img">
                    <img src={api.mediaUrl(img.path, img.mtimeMs)} alt="" loading="lazy" />
                    {selected === img.rel && <Check size={14} className="thumbs__check" aria-hidden="true" />}
                  </span>
                  <span className="thumbs__name mono">{img.rel.replace(/^thumbnails\//, '')}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
