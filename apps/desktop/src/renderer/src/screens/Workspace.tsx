import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { FolderOpen, Pause, Play, RefreshCw, Sparkles, Video } from 'lucide-react';
import type { ProjectInfo, ProjectSnapshot, PromptButton, ReviewItem, Variant } from '@shared/types';
import { LangContext, useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import { TerminalPane } from '../components/TerminalPane';
import { sendToAgent } from '../terminal/agentSend';
import { FeedbackLayer } from '../components/Feedback';
import { AnalysisBar } from '../components/AnalysisBar';
import { TimelineView } from './parts/Timeline';
import { FindingsPanel } from './parts/Findings';
import { ReviewQueue, StepBar } from './parts/WorkspaceParts';
import { RawPlayer } from './parts/RawPlayer';
import { finishPrompt, playerSource } from './parts/workspaceModel';

const RIGHT_W_KEY = 'solocut.ws.rightWidth';
/** One video per project: the workspace always shows the main timeline. */
const VARIANT: Variant = 'main';

export function Workspace({
  project,
  visible,
  toast,
  onRecord,
  focus = 'edit',
  showTerminal = true,
  showCenter = true,
  embedded = false,
}: {
  project: ProjectInfo | null;
  visible: boolean;
  toast: (m: string) => void;
  onRecord: () => void;
  /** ignored: one video per project (kept so older callers still type-check) */
  variant?: Variant;
  onVariantChange?: (v: Variant) => void;
  /** 編集 (preview + timeline + terminal) or 確認 (preview + review list first, no terminal) */
  focus?: 'edit' | 'review';
  showTerminal?: boolean;
  showCenter?: boolean;
  /** inside the shell: the title bar already has the record button */
  embedded?: boolean;
}) {
  const t = useT();
  const lang = useContext(LangContext);
  const [fbActive, setFbActive] = useState(false);
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptButton[]>([]);
  const [rightW, setRightW] = useState<number>(() => Number(localStorage.getItem(RIGHT_W_KEY)) || 0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dir = project?.dir ?? null;

  const refresh = useCallback(async () => {
    if (!dir) return;
    setLoading(true);
    try {
      setSnap(await api.invoke('project:snapshot', dir, VARIANT));
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [dir, toast]);

  const loadPrompts = useCallback(async () => {
    setPrompts(await api.invoke('prompts:list', dir ?? undefined));
  }, [dir]);

  useEffect(() => {
    setSnap(null);
    setSelected(null);
    void refresh();
    void loadPrompts();
  }, [dir, refresh, loadPrompts]);

  // xterm refits itself when the terminal column is shown again (terminalClient's ResizeObserver)
  const termShown = showTerminal && focus === 'edit';

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
    try {
      const vars: Record<string, string> = {};
      if (selected) vars.selection = selected;
      const r = await api.invoke('prompts:render', p.id, dir ?? undefined, vars);
      const agent = r.agent ?? p.agent;
      // main picks the project's agent terminal (focused one first), pastes, checks, then presses Enter;
      // with no agent running it opens one (the prompt's agent or the default) and sends once it is ready
      const res = await sendToAgent(
        { text: r.text, agent: agent && agent !== 'default' ? agent : null, projectDir: dir },
        { launch: agent && agent !== 'default' ? agent : null },
      );
      toast(res.ok ? `${t('prompts.sent')}: ${p.label}` : res.message);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const decide = async (item: ReviewItem, decision: 'accept' | 'reject') => {
    if (!dir) return;
    const r = await api.invoke('project:review', dir, item, decision, VARIANT);
    if (!r.ok) toast(r.error ?? t('common.error'));
    else void refresh();
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
  const shown = playerSource(snap);
  const finish = finishPrompt(prompts, t('prompts.finish'));
  const style = rightW ? ({ '--right-w': `${rightW}px` } as React.CSSProperties) : undefined;
  const wsClass = ['ws', `focus-${focus}`, termShown ? '' : 'no-terminal', showCenter || !termShown ? '' : 'no-center', embedded ? 'embedded' : ''].filter(Boolean).join(' ');

  return (
    <div className={wsClass}>
      <div className="titlebar">
        <span className="title">{project.title}</span>
        <span className="grow" />
        {!embedded && <button className="btn ghost small" onClick={onRecord}>
          <Video size={14} /> {t('nav.record')}
        </button>}
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
            {shown === 'edited' && snap?.preview ? (
              <>
                <video ref={videoRef} key={snap.preview.url} src={snap.preview.url} controls={!fbActive} preload="metadata" />
                <FeedbackLayer
                  dir={project.dir}
                  variant={VARIANT}
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
            ) : shown === 'raw' && snap?.raw ? (
              <RawPlayer raw={snap.raw} />
            ) : (
              <div className="placeholder">
                <span>{t('ws.noVideo')}</span>
                <button className="btn" onClick={onRecord}>
                  <Video size={14} /> {t('nav.record')}
                </button>
              </div>
            )}
            {shown !== 'none' && !fbActive && (
              <span className={`player-label is-${shown}`} title={shown === 'raw' ? t('ws.rawHint') : undefined} data-testid="player-label">
                {t(shown === 'raw' ? 'ws.raw' : 'ws.edited')}
              </span>
            )}
          </div>
          {snap && snap.errors.length > 0 && (
            <div className="section">
              {snap.errors.map((e) => (
                <div key={e} className="notice err" style={{ marginBottom: 4 }}>
                  {e}
                </div>
              ))}
            </div>
          )}
          <StepBar snap={snap} />
          <AnalysisBar dir={project.dir} toast={toast} />
          <div className="section section--timeline">
            {ov ? (
              <TimelineView
                ov={ov}
                selected={selected}
                videoRef={videoRef}
                onSelect={(id, start) => (setSelected(id), seek(start))}
                onSeek={seek}
              />
            ) : (
              <div className="dim">{t('ws.noTimeline')}</div>
            )}
          </div>
          <div className="section review-sec">
            <ReviewQueue ov={ov} selected={selected} onSelect={(r) => (setSelected(r.id), r.start !== undefined && seek(r.start))} onDecide={(r, d) => void decide(r, d)} />
          </div>
          {focus === 'review' && (
            <div className="section findings-sec">
              <FindingsPanel dir={project.dir} variant={VARIANT} onSeek={seek} />
            </div>
          )}
        </div>
        <div className="splitter" onMouseDown={startDrag} />
        <div className="ws-right">
          <TerminalPane projectDir={project.dir} visible={visible && termShown} toast={toast} />
          <div className="prompts">
            <button className="btn small autopilot" onClick={() => void sendPrompt(finish)} title={finish.agent ? `→ ${finish.agent}` : finish.id} data-testid="prompt-finish">
              <Sparkles size={12} color="#ff4a3d" />
              {finish.label}
            </button>
          </div>
        </div>
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
