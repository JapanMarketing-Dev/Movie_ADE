import { useEffect, useRef, useState, type RefObject } from 'react';
import type { LaneItem, LaneName, TimelineOverview, Variant } from '@shared/types';
import { formatFrames } from '@shared/project';
import { useST, type SKey } from '../../shell/i18n';
import { Badge } from '../../ui';
import { fractionToFrame, frameToFraction, itemWidthPct, LANE_ORDER, laneStats, rulerTicks, secondsToFrame } from './timelineModel';

const LANE_KEY: Record<LaneName, SKey> = {
  segments: 'tl.lane.segments',
  captions: 'tl.lane.captions',
  scenes: 'tl.lane.scenes',
  sfx: 'tl.lane.sfx',
  markers: 'tl.lane.markers',
};

/** Follow the preview's current time (rAF while playing, events otherwise). */
function usePlayhead(videoRef: RefObject<HTMLVideoElement | null>, fpsNum: number, fpsDen: number): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    let bound: HTMLVideoElement | null = null;
    const read = () => bound && setFrame(secondsToFrame(bound.currentTime, fpsNum, fpsDen));
    const loop = () => {
      read();
      if (bound && !bound.paused) raf = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    // the <video> is re-created when a new preview is rendered; re-bind when it changes
    const bind = () => {
      const v = videoRef.current;
      if (v === bound) return;
      bound?.removeEventListener('play', onPlay);
      bound?.removeEventListener('seeked', read);
      bound?.removeEventListener('timeupdate', read);
      bound = v;
      if (!v) return;
      v.addEventListener('play', onPlay);
      v.addEventListener('seeked', read);
      v.addEventListener('timeupdate', read);
      read();
    };
    bind();
    const id = window.setInterval(bind, 1000);
    return () => {
      window.clearInterval(id);
      cancelAnimationFrame(raf);
      bound?.removeEventListener('play', onPlay);
      bound?.removeEventListener('seeked', read);
      bound?.removeEventListener('timeupdate', read);
    };
  }, [videoRef, fpsNum, fpsDen]);
  return frame;
}

/**
 * Timeline overview (display only; docs/02). Lanes for segments / captions / scenes / sfx / markers with hover
 * details, a playhead that follows the preview, click anywhere on a track to seek, and items flagged for review in
 * the accent color. The overview is the selected variant's timeline (YouTube 16:9, TikTok / Shorts 9:16).
 */
export function TimelineView({
  ov,
  variant,
  selected,
  videoRef,
  onSelect,
  onSeek,
}: {
  ov: TimelineOverview;
  variant: Variant;
  selected: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onSelect: (id: string, start: number) => void;
  onSeek: (frame: number) => void;
}) {
  const t = useST();
  const total = Math.max(1, ov.durationFrames);
  const fps = ov.fpsNum / (ov.fpsDen || 1);
  const playhead = usePlayhead(videoRef, ov.fpsNum, ov.fpsDen);
  const [hover, setHover] = useState<{ x: number; frame: number; item: LaneItem | null; lane: LaneName } | null>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const tc = (f: number) => formatFrames(f, ov.fpsNum, ov.fpsDen);
  const stats = laneStats(ov);

  const frameAtEvent = (e: React.MouseEvent<HTMLElement>, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { frame: fractionToFrame((e.clientX - r.left) / r.width, total), x: e.clientX - (tracksRef.current?.getBoundingClientRect().left ?? r.left) };
  };

  return (
    <div className="tl" data-testid="timeline">
      <div className="tl__head">
        <span className="tl__title">{t('tl.title')}</span>
        <Badge>{t(`variant.${variant}`)}</Badge>
        <span className="tl__dur">{tc(total)}</span>
        {ov.lastCheck && (
          <span className="tl__check" title={ov.lastCheck.at}>
            <Badge tone={ov.lastCheck.failed > 0 ? 'danger' : 'success'}>
              {t('tl.check', { passed: String(ov.lastCheck.passed), failed: String(ov.lastCheck.failed), human: String(ov.lastCheck.needsHuman) })}
            </Badge>
          </span>
        )}
        <span className="tl__hint">{t('tl.hint')}</span>
      </div>
      <div className="tl__body">
        <div className="tl__names">
          {stats.map((s) => (
            <div key={s.lane} className="tl__name">
              <span>{t(LANE_KEY[s.lane])}</span>
              <span className="tl__count">{s.count}</span>
              {s.review > 0 && <span className="tl__review-dot" title={t('tl.needsReview', { n: String(s.review) })} />}
            </div>
          ))}
          <div className="tl__name tl__name--ruler" />
        </div>
        <div className="tl__tracks" ref={tracksRef} onMouseLeave={() => setHover(null)}>
          {LANE_ORDER.map((lane) => (
            <div
              key={lane}
              className={`tl__track tl__track--${lane}`}
              onMouseMove={(e) => {
                const { frame, x } = frameAtEvent(e, e.currentTarget);
                const item = (e.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item;
                setHover({ x, frame, lane, item: ov.lanes[lane].find((it) => it.id === item) ?? null });
              }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('[data-item]')) return;
                onSeek(frameAtEvent(e, e.currentTarget).frame);
              }}
            >
              {ov.lanes[lane].map((it) => (
                <button
                  key={it.id}
                  type="button"
                  data-item={it.id}
                  className={`tl__item${it.needsReview ? ' is-review' : ''}${selected === it.id ? ' is-selected' : ''}`}
                  style={{ left: `${frameToFraction(it.start, total) * 100}%`, width: itemWidthPct(it, total, lane) }}
                  aria-label={`${tc(it.start)} ${it.label}`}
                  onClick={() => onSelect(it.id, it.start)}
                />
              ))}
            </div>
          ))}
          <div
            className="tl__ruler"
            onClick={(e) => onSeek(frameAtEvent(e, e.currentTarget).frame)}
            onMouseMove={(e) => setHover({ ...frameAtEvent(e, e.currentTarget), lane: 'markers', item: null })}
          >
            {rulerTicks(total, fps).filter((tk) => tk.frame > 0).map((tk) => (
              <span key={tk.frame} className="tl__tick" style={{ left: `${frameToFraction(tk.frame, total) * 100}%` }}>
                {tk.label}
              </span>
            ))}
          </div>
          <div className="tl__playhead" style={{ left: `${frameToFraction(playhead, total) * 100}%` }} aria-hidden="true">
            <span className="tl__playhead-tc">{tc(playhead)}</span>
          </div>
          {hover && (
            <>
              <div className="tl__hover-line" style={{ left: hover.x }} aria-hidden="true" />
              <div className={`tl__tip${hover.x > (tracksRef.current?.clientWidth ?? 0) - 220 ? ' is-left' : ''}`} style={{ left: hover.x }} role="tooltip">
                {hover.item ? (
                  <>
                    <span className="tl__tip-tc">
                      {tc(hover.item.start)}
                      {hover.lane !== 'markers' && ` – ${tc(hover.item.end)}`}
                    </span>
                    <span className="tl__tip-label">{hover.item.label || hover.item.id}</span>
                    {hover.item.kind && <span className="tl__tip-kind">{hover.item.kind}</span>}
                    {hover.item.needsReview && <span className="tl__tip-review">{t('tl.review')}</span>}
                  </>
                ) : (
                  <span className="tl__tip-tc">{tc(hover.frame)}</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
