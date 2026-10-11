import { Check, CircleDot, Copy, X } from 'lucide-react';
import type { ProjectSnapshot, ReviewItem, TimelineOverview } from '@shared/types';
import { formatFrames } from '@shared/project';
import { summarizePipeline } from '../../shell/format';
import { useST, type SKey } from '../../shell/i18n';
import { Badge, Button, IconButton, Tooltip, useToast } from '../../ui';

/**
 * The template pipeline as a step bar (`solocut status`): one segment per step, the current one highlighted, and the
 * "next" card with what to do and the command, as the agent sees it in `solocut next`.
 */
export function StepBar({ snap }: { snap: ProjectSnapshot | null }) {
  const t = useST();
  const toast = useToast();
  const steps = snap?.steps ?? [];
  const sum = summarizePipeline(steps);
  const next = snap?.next;
  const cmd = next?.commands[0];
  return (
    <section className="stepbar" data-testid="stepbar">
      <div className="stepbar__head">
        <span className="stepbar__title">{t('ws.steps')}</span>
        <span className="stepbar__count">
          {sum.done}/{sum.total}
        </span>
        <span className="stepbar__pct">{Math.round(sum.progress * 100)}%</span>
      </div>
      {steps.length === 0 ? (
        <p className="stepbar__empty">—</p>
      ) : (
        <ol className="stepbar__track">
          {steps.map((s) => (
            <li key={s.step} className={`stepbar__step is-${s.state}${sum.current?.step === s.step ? ' is-current' : ''}`}>
              <Tooltip label={`${s.step} · ${t(`step.${s.state}` as SKey)}${s.note ? ` — ${s.note}` : ''}`} side="top">
                <span className="stepbar__seg" />
              </Tooltip>
            </li>
          ))}
        </ol>
      )}
      {next && (
        <div className={`stepbar__next is-${next.state}`}>
          <CircleDot size={14} aria-hidden="true" />
          <div className="stepbar__next-body">
            <div className="stepbar__next-head">
              <span className="stepbar__next-label">{next.step === 'done' ? t('status.pipeline.done') : t('ws.nextStep', { step: next.step })}</span>
              {next.state === 'needs-human' && <Badge tone="warning">{t('step.needs-human')}</Badge>}
            </div>
            <p className="stepbar__next-text">{next.do || next.why}</p>
          </div>
          {cmd && (
            <Tooltip label={t('ws.copyCommand')} side="top" align="end">
              <button
                type="button"
                className="stepbar__cmd"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(cmd)
                    .then(() => toast({ tone: 'success', message: t('settings.file.copied') }))
                    .catch(() => undefined)
                }
              >
                <code>{cmd}</code>
                <Copy size={12} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </section>
  );
}

/** Decisions the decision model was not sure about (docs/05 "要確認"), confirmable on the spot. */
export function ReviewQueue({
  ov,
  selected,
  onSelect,
  onDecide,
}: {
  ov: TimelineOverview | undefined;
  selected: string | null;
  onSelect: (r: ReviewItem) => void;
  onDecide: (r: ReviewItem, d: 'accept' | 'reject') => void;
}) {
  const t = useST();
  const items = ov?.review ?? [];
  return (
    <section className="rq" data-testid="review-queue">
      <div className="rq__head">
        <span className="rq__title">{t('ws.reviewQueue')}</span>
        {items.length > 0 && <span className="count-badge count-badge--brand">{items.length}</span>}
        <span className="rq__hint">{t('ws.reviewHint')}</span>
      </div>
      {items.length === 0 ? (
        <p className="rq__empty">{t('ws.reviewEmpty')}</p>
      ) : (
        <ul className="rq__list">
          {items.map((r) => (
            <li
              key={`${r.lane}:${r.id}`}
              className={`rq__item${selected === r.id ? ' is-selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect(r);
              }}
            >
              <span className="rq__tc">{r.start !== undefined && ov ? formatFrames(r.start, ov.fpsNum, ov.fpsDen) : r.lane}</span>
              <div className="rq__body">
                <span className="rq__label">{r.label || r.id}</span>
                <span className="rq__why">
                  <span className="rq__lane">{t(`tl.lane.${r.lane}` as SKey) || r.lane}</span>
                  {r.reason && ` · ${r.reason}`}
                  {r.by && ` · ${r.by}`}
                </span>
              </div>
              {r.confidence !== undefined && (
                <span className="rq__conf" title={t('ws.confidence')}>
                  <span className="rq__conf-bar" style={{ transform: `scaleX(${Math.max(0, Math.min(1, r.confidence))})` }} />
                  <span className="rq__conf-num">{Math.round(r.confidence * 100)}%</span>
                </span>
              )}
              {r.lane !== 'open' && r.lane !== 'markers' && (
                <span className="rq__actions">
                  <Button size="sm" icon={<Check size={13} />} onClick={(e) => (e.stopPropagation(), onDecide(r, 'accept'))}>
                    {t('ws.accept')}
                  </Button>
                  <IconButton size="sm" label={t('ws.reject')} icon={<X size={13} />} onClick={(e) => (e.stopPropagation(), onDecide(r, 'reject'))} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
