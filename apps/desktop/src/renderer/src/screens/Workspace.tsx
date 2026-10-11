import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, Pause, Play, RefreshCw, Sparkles, Video, X } from 'lucide-react';
import type { LaneName, ProjectInfo, ProjectSnapshot, PromptButton, ReviewItem, TimelineOverview, Variant } from '@shared/types';
import { formatFrames, progressOf, stepMark, variantArgs } from '@shared/project';
import { LangContext, useT, type TKey } from '../i18n';
import { api, errMsg } from '../lib/api';
import { terminals } from '../lib/terminals';
import { Terminals } from '../components/Terminals';
import { FeedbackLayer } from '../components/Feedback';
import { AnalysisBar } from '../components/AnalysisBar';

const RIGHT_W_KEY = 'solocut.ws.rightWidth';

export function Workspace({
  project,
  visible,
  toast,
  onRecord,
}: {
  project: ProjectInfo | null;
  visible: boolean;
  toast: (m: string) => void;
  onRecord: () => void;
}) {
  const t = useT();
  const lang = useContext(LangContext);
  const [fbActive, setFbActive] = useState(false);
  const [variant, setVariant] = useState<Variant>('main');
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptButton[]>([]);
  const [rightW, setRightW] = useState<number>(() => Number(localStorage.getItem(RIGHT_W_KEY)) || 0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dir = project?.dir ?? null;
  const prevDir = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!dir) return;
    setLoading(true);
    try {
      setSnap(await api.invoke('project:snapshot', dir, variant));
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [dir, variant, toast]);

  const loadPrompts = useCallback(async () => {
    setPrompts(await api.invoke('prompts:list', dir ?? undefined));
  }, [dir]);

  useEffect(() => {
    if (prevDir.current && prevDir.current !== dir && terminals.tabs.length > 0) terminals.closeAll();
    if (prevDir.current !== dir) setVariant('main');
    prevDir.current = dir;
    setSnap(null);
    setSelected(null);
    void refresh();
    void loadPrompts();
  }, [dir, refresh, loadPrompts]);

  useEffect(() => {
    const off1 = api.on('project:changed', (d) => {
      if (d === dir) void refresh();
    });
    const off2 = api.on('settings:changed', () => void loadPrompts());
    return () => {
      off1();
      off2();
    };
  }, [dir, refresh, loadPrompts]);

  const sendPrompt = async (p: PromptButton) => {
    const tab = terminals.targetFor(p.agent);
    if (!tab) {
      toast(t('prompts.noTerminal'));
      return;
    }
    try {
      const vars: Record<string, string> = {};
      if (selected) vars.selection = selected;
      const r = await api.invoke('prompts:render', p.id, dir ?? undefined, vars);
      terminals.paste(tab, r.text);
      toast(`${t('prompts.sent')}: ${p.label} → ${tab.title}`);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const decide = async (item: ReviewItem, decision: 'accept' | 'reject') => {
    if (!dir) return;
    const r = await api.invoke('project:review', dir, item, decision, variant);
    if (!r.ok) toast(r.error ?? t('common.error'));
    else void refresh();
  };

  const renderPreview = async () => {
    if (!dir) return;
    setLoading(true);
    const r = await api.invoke('project:cli', dir, ['render', '--preview', ...variantArgs(variant)]);
    setLoading(false);
    if (!r.ok) toast(r.error ?? t('common.error'));
    void refresh();
  };

  const derive = async () => {
    if (!dir || variant === 'main') return;
    setLoading(true);
    const r = await api.invoke('project:cli', dir, ['derive', '--target', variant]);
    setLoading(false);
    if (!r.ok) toast(r.error ?? t('common.error'));
    void refresh();
  };

  const seek = (frame: number) => {
    const v = videoRef.current;
    const ov = snap?.overview;
    if (!v || !ov) return;
    v.currentTime = (frame * ov.fpsDen) / ov.fpsNum;
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(360, Math.min(window.innerWidth - 480, window.innerWidth - ev.clientX));
      setRightW(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setRightW((w) => {
        localStorage.setItem(RIGHT_W_KEY, String(w));
        return w;
      });
      terminals.fitActive();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!project) {
    return (
      <div className="ws">
        <div className="titlebar">
          <span className="title">{t('nav.workspace')}</span>
        </div>
        <div className="empty">{t('ws.noProject')}</div>
      </div>
    );
  }

  const ov = snap?.overview;
  const style = rightW ? ({ '--right-w': `${rightW}px` } as React.CSSProperties) : undefined;

  return (
    <div className="ws">
      <div className="titlebar">
        <span className="title">{project.title}</span>
        {project.template && <span className="pill mono">{project.template.id}</span>}
        <span className="grow" />
        <div className="segmented" title={t('ws.variantHint')}>
          {(['main', 'tiktok', 'youtube-shorts'] as Variant[]).map((v) => (
            <button key={v} className={variant === v ? 'on' : ''} disabled={fbActive} onClick={() => setVariant(v)}>
              {t(v === 'main' ? 'var.main' : v === 'tiktok' ? 'var.tiktok' : 'var.shorts')}
              {snap && v !== 'main' && !snap.variants.includes(v) ? ' ·' : ''}
            </button>
          ))}
        </div>
        <button className="btn ghost small" onClick={onRecord}>
          <Video size={14} /> {t('nav.record')}
        </button>
        <button className="btn ghost small" onClick={() => void api.invoke('app:showInFolder', project.dir)}>
          <FolderOpen size={14} /> {t('ws.openFolder')}
        </button>
        <button className="btn ghost small icon" title={t('ws.refresh')} onClick={() => void refresh()}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <div className="ws-body" style={style}>
        <div className="ws-left">
          <div className="player">
            {snap?.preview ? (
              <>
                <video ref={videoRef} key={snap.preview.url} src={snap.preview.url} controls={!fbActive} preload="metadata" />
                <FeedbackLayer
                  dir={project.dir}
                  variant={variant}
                  videoRef={videoRef}
                  previewPath={snap.preview.path}
                  fpsNum={snap.overview?.fpsNum ?? 30}
                  fpsDen={snap.overview?.fpsDen ?? 1}
                  lang={lang}
                  toast={toast}
                  active={fbActive}
                  onActiveChange={setFbActive}
                />
                {fbActive && <MiniTransport videoRef={videoRef} />}
              </>
            ) : (
              <div className="placeholder">
                {variant !== 'main' && snap && !snap.variants.includes(variant) ? (
                  <>
                    <span>{t('ws.notDerived')}</span>
                    <button className="btn" disabled={loading} onClick={() => void derive()}>
                      <Sparkles size={14} /> {t('ws.derive')}
                    </button>
                  </>
                ) : (
                  <>
                    <span>{t('ws.noPreview')}</span>
                    <button className="btn" disabled={loading} onClick={() => void renderPreview()}>
                      <Play size={14} /> {t('ws.renderPreview')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {snap?.stale && (
            <div className="section">
              <div className="notice row" style={{ justifyContent: 'space-between' }}>
                <span>{t('ws.stale')}</span>
                <button className="btn small" disabled={loading} onClick={() => void derive()}>
                  {t('ws.derive')}
                </button>
              </div>
            </div>
          )}
          {snap && snap.errors.length > 0 && (
            <div className="section">
              {snap.errors.map((e) => (
                <div key={e} className="notice err" style={{ marginBottom: 4 }}>
                  {e}
                </div>
              ))}
            </div>
          )}
          <Pipeline snap={snap} />
          {variant === 'main' && <AnalysisBar dir={project.dir} toast={toast} />}
          <div className="section">
            <div className="section-title">
              {t('ws.timeline')}
              {ov?.lastCheck && (
                <span className={`pill ${ov.lastCheck.failed > 0 ? 'accent' : 'okp'}`}>
                  {t('ws.lastCheck')} ✓{ov.lastCheck.passed} ✕{ov.lastCheck.failed} ?{ov.lastCheck.needsHuman}
                </span>
              )}
            </div>
            {ov ? <Lanes ov={ov} selected={selected} onSelect={(id, start) => (setSelected(id), seek(start))} /> : <div className="dim">{t('ws.noTimeline')}</div>}
          </div>
          <div className="section" style={{ borderBottom: 0 }}>
            <div className="section-title">
              {t('ws.review')} {ov && ov.review.length > 0 && <span className="pill accent">{ov.review.length}</span>}
            </div>
            {!ov || ov.review.length === 0 ? (
              <div className="dim">{t('ws.noReview')}</div>
            ) : (
              <div className="review-list">
                {ov.review.map((r) => (
                  <div key={`${r.lane}:${r.id}`} className={`review-item ${selected === r.id ? 'sel' : ''}`} onClick={() => (setSelected(r.id), r.start !== undefined && seek(r.start))}>
                    <span className="pill mono">{r.start !== undefined ? formatFrames(r.start, ov.fpsNum, ov.fpsDen) : r.lane}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label || r.id}</div>
                      <div className="why">
                        {r.reason}
                        {r.confidence !== undefined && ` · ${t('ws.confidence')} ${Math.round(r.confidence * 100)}%`}
                        {r.by && ` · ${r.by}`}
                      </div>
                    </div>
                    {r.lane !== 'open' && r.lane !== 'markers' && (
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn small" onClick={(e) => (e.stopPropagation(), void decide(r, 'accept'))}>
                          <Check size={13} /> {t('ws.accept')}
                        </button>
                        <button className="btn small" onClick={(e) => (e.stopPropagation(), void decide(r, 'reject'))}>
                          <X size={13} /> {t('ws.reject')}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="splitter" onMouseDown={startDrag} />
        <div className="ws-right">
          <Terminals cwd={project.dir} visible={visible} toast={toast} />
          <div className="prompts">
            <span className="dim" style={{ fontSize: 11, paddingRight: 4, flexShrink: 0 }}>
              {t('prompts.title')}
            </span>
            {prompts.map((p) => (
              <button key={p.id} className={`btn small ${p.autopilot ? 'autopilot' : ''}`} onClick={() => void sendPrompt(p)} title={p.agent ? `→ ${p.agent}` : p.id}>
                {p.autopilot && <Sparkles size={12} color="#ff4a3d" />}
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Pipeline({ snap }: { snap: ProjectSnapshot | null }) {
  const t = useT();
  const steps = snap?.steps ?? [];
  return (
    <div className="section">
      <div className="section-title">
        {t('ws.pipeline')}
        {steps.length > 0 && <span className="dim">{Math.round(progressOf(steps) * 100)}%</span>}
      </div>
      {steps.length === 0 ? (
        <div className="dim">—</div>
      ) : (
        <div className="pipeline">
          {steps.map((s) => (
            <div key={s.step} className={`step ${s.state}`} title={`${s.step}: ${s.state}${s.note ? ` — ${s.note}` : ''}`}>
              <div className="bar" />
              <div className="lbl">
                {stepMark(s)} {s.step}
              </div>
            </div>
          ))}
        </div>
      )}
      {snap?.next && (
        <div className="next">
          <span className={`pill ${snap.next.state === 'needs-human' ? 'accent' : snap.next.state === 'done' ? 'okp' : ''}`}>
            {t('ws.next')}: {snap.next.step}
          </span>
          <span style={{ minWidth: 0 }}>{snap.next.do || snap.next.why}</span>
        </div>
      )}
    </div>
  );
}

const LANES: LaneName[] = ['segments', 'captions', 'scenes', 'sfx', 'markers'];

function Lanes({ ov, selected, onSelect }: { ov: TimelineOverview; selected: string | null; onSelect: (id: string, start: number) => void }) {
  const t = useT();
  const total = Math.max(1, ov.durationFrames);
  const pct = (f: number) => `${(f / total) * 100}%`;
  return (
    <div className="lanes">
      {LANES.map((lane) => (
        <div key={lane} className={`lane ${lane}`}>
          <span className="name">{t(`ws.lane.${lane}` as TKey)}</span>
          <div className="track">
            {ov.lanes[lane].map((it) => (
              <button
                key={it.id}
                className={`item ${it.needsReview ? 'review' : ''} ${selected === it.id ? 'sel' : ''}`}
                style={{ left: pct(it.start), width: lane === 'markers' ? undefined : `max(2px, ${pct(it.end - it.start)})` }}
                title={`${formatFrames(it.start, ov.fpsNum, ov.fpsDen)} ${it.label}`}
                onClick={() => onSelect(it.id, it.start)}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="ruler">
        <span>00:00:00</span>
        <span>{formatFrames(total, ov.fpsNum, ov.fpsDen)}</span>
      </div>
    </div>
  );
}

/** Play/pause and a seek bar while drawing (native controls would steal pointer events from the canvas). */
function MiniTransport({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const [, force] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const f = () => force((n) => n + 1);
    v.addEventListener('timeupdate', f);
    v.addEventListener('play', f);
    v.addEventListener('pause', f);
    return () => {
      v.removeEventListener('timeupdate', f);
      v.removeEventListener('play', f);
      v.removeEventListener('pause', f);
    };
  }, [videoRef]);
  const v = videoRef.current;
  if (!v) return null;
  return (
    <div className="fb-transport">
      <button className="btn small icon" onClick={() => (v.paused ? void v.play() : v.pause())}>
        {v.paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
      <input
        type="range"
        min={0}
        max={Number.isFinite(v.duration) ? v.duration : 0}
        step={0.01}
        value={v.currentTime}
        onChange={(e) => (v.currentTime = Number(e.target.value))}
      />
    </div>
  );
}
