import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  AudioLines,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Download,
  Mic,
  MicOff,
  RefreshCw,
  ScanEye,
  Settings,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AgentStatus, AppInfo, ProjectSnapshot } from '@shared/types';
import { api, errMsg } from '../lib/api';
import { Button, IconButton, Popover, Progress, RecordDot, Spinner } from '../ui';
import { invokeOptional, resetIn, tightestWindow, usageTone, useAgentUsage, type AgentUsage } from './agentUsage';
import { analysisProgress, formatElapsed, summarizePipeline, summarizeTools, updatePill } from './format';
import { useST, type ST } from './i18n';
import { analysisStore, agentsStore, settingsStore, toolsStore, updateStore, useStore } from './stores';
import { getPath } from '../settings/settingsSections';
import type { SettingsSectionId } from '../settings/settingsSections';

/**
 * Bottom status bar (24px), ported from Ferret src/renderer/components/StatusBar.tsx and StatusPopover.tsx.
 * Always visible, never loud: what records, what transcribes, which agent works and how far the template pipeline is.
 * Items open a popover above the bar with details (Orca's "small item + popover" status bar; Orca由来:
 * ~/bench/orca/src/renderer/src/components/status-bar/StatusBarSurface.tsx、MIT、Ferret 経由).
 */
type PopKind = 'usage' | 'mic' | 'tools' | 'pipeline' | 'analysis' | 'update';

function Divider() {
  return <span className="statusbar__divider" aria-hidden="true" />;
}

function Item({ icon: Icon, value, title, tone = 'ok' }: { icon: LucideIcon; value: string; title: string; tone?: 'ok' | 'warn' | 'off' }) {
  return (
    <span className={`statusbar__item statusbar__item--${tone}`} title={title}>
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      <span className="statusbar__value">{value}</span>
    </span>
  );
}

export function StatusBar({
  info,
  snapshot,
  recording,
  recStartedAtMs,
  onOpenSettings,
  onOpenLibrary,
  onOpenEdit,
}: {
  info: AppInfo | null;
  /** main-variant snapshot of the open project (pipeline step) */
  snapshot: ProjectSnapshot | null;
  recording: boolean;
  /** performance.now() when the take started */
  recStartedAtMs?: number;
  onOpenSettings: (section?: SettingsSectionId) => void;
  onOpenLibrary: () => void;
  onOpenEdit: () => void;
}) {
  const t = useST();
  const [open, setOpen] = useState<PopKind | null>(null);
  const refs = useRef<Partial<Record<PopKind, HTMLButtonElement | null>>>({});
  const settings = useStore(settingsStore);
  const tools = useStore(toolsStore);
  const agents = useStore(agentsStore);
  const update = useStore(updateStore);
  const analysis = useStore(analysisStore);
  const usage = useAgentUsage();
  const elapsed = useElapsed(recording, recStartedAtMs);
  const micLabel = useMicLabel(String(getPath(settings.json, 'recording.mic.deviceId') ?? 'default'));

  const toggle = (k: PopKind) => setOpen((cur) => (cur === k ? null : k));
  const close = () => setOpen(null);
  const ref = (k: PopKind) => (el: HTMLButtonElement | null) => {
    refs.current[k] = el;
  };

  const engine = String(getPath(settings.json, 'transcription.engine') ?? 'whisper.cpp');
  const model = String(getPath(settings.json, 'transcription.model') ?? 'large-v3-turbo-q5');
  const toolSum = summarizeTools(tools);
  const pipe = snapshot ? summarizePipeline(snapshot.steps) : null;
  const anProg = analysisProgress(analysis);
  const pill = updatePill(update);
  const installedAgents = (agents ?? []).filter((a) => a.installed);

  return (
    <footer className="statusbar" data-testid="statusbar">
      {/* agents: usage meters (desktop IPC) or the installed agents */}
      <button ref={ref('usage')} type="button" className="statusbar__btn statusbar__usage" aria-expanded={open === 'usage'} onClick={() => toggle('usage')} title={t('status.usage.title')}>
        <UsageSegments usage={usage.usage} agents={installedAgents} available={usage.available} t={t} />
      </button>
      {usage.failover?.enabled && usage.failover.current && (
        <span className="statusbar__item statusbar__item--ok" title={t('status.failover.title', { current: usage.failover.current, next: usage.failover.next ?? '—' })}>
          <ArrowRightLeft size={12} strokeWidth={2} aria-hidden="true" />
          <span className="statusbar__value">{usage.failover.next ? `→ ${agentName(usage.failover.next, agents)}` : t('status.failover.on')}</span>
        </span>
      )}
      <Divider />

      <span className={`statusbar__rec${recording ? ' is-recording' : ''}`} title={recording ? t('status.rec.on') : t('status.rec.off')}>
        <RecordDot active={recording} size={6} />
        <span className="statusbar__elapsed">{elapsed}</span>
      </span>
      <Divider />

      <button ref={ref('mic')} type="button" className="statusbar__btn statusbar__item--ok" aria-expanded={open === 'mic'} onClick={() => toggle('mic')} title={t('status.mic.title', { value: micLabel })}>
        <Mic size={12} strokeWidth={2} aria-hidden="true" />
        <span className="statusbar__value statusbar__value--clip">{micLabel}</span>
        <ChevronUp size={11} strokeWidth={2} aria-hidden="true" />
      </button>
      <Item icon={AudioLines} value={`${engine} / ${model}`} title={t('status.transcription.title', { value: `${engine} / ${model}` })} />

      <button
        ref={ref('tools')}
        type="button"
        className={`statusbar__btn statusbar__item--${toolSum.ok ? 'ok' : 'warn'}`}
        aria-expanded={open === 'tools'}
        onClick={() => toggle('tools')}
        title={toolSum.ok ? t('status.tools.ok') : t('status.tools.missing', { names: toolSum.missing.join(', ') })}
        data-testid="statusbar-tools"
      >
        <Wrench size={12} strokeWidth={2} aria-hidden="true" />
        <span className="statusbar__value">{tools === null ? '…' : toolSum.ok ? t('status.tools.ready') : t('status.tools.count', { n: String(toolSum.missing.length) })}</span>
      </button>

      {anProg !== null && (
        <button ref={ref('analysis')} type="button" className="statusbar__btn statusbar__item--ok" aria-expanded={open === 'analysis'} onClick={() => toggle('analysis')} title={t('status.analysis.title')}>
          <ScanEye size={12} strokeWidth={2} aria-hidden="true" />
          <span className="statusbar__value">{t('status.analysis.value', { percent: String(Math.round(anProg * 100)) })}</span>
          <span className="statusbar__minibar" aria-hidden="true">
            <span style={{ transform: `scaleX(${anProg})` }} />
          </span>
        </button>
      )}

      <span className="statusbar__spacer" />

      {snapshot && pipe && pipe.total > 0 && (
        <>
          <button
            ref={ref('pipeline')}
            type="button"
            className={`statusbar__btn statusbar__item--${pipe.needsHuman ? 'warn' : 'ok'}`}
            aria-expanded={open === 'pipeline'}
            onClick={() => toggle('pipeline')}
            title={t('status.pipeline.title')}
            data-testid="statusbar-pipeline"
          >
            <Workflow size={12} strokeWidth={2} aria-hidden="true" />
            <span className="statusbar__value">
              {snapshot.next?.step === 'done' ? t('status.pipeline.done') : `${snapshot.next?.step ?? pipe.current?.step ?? '—'}`}
            </span>
            <span className="statusbar__count">
              {pipe.done}/{pipe.total}
            </span>
          </button>
          <Divider />
        </>
      )}

      <MemoryItem t={t} />

      {pill?.kind === 'ready' && (
        <button type="button" className="statusbar__btn statusbar__update-ready" onClick={() => void api.invoke('update:restart')} title={t('status.update.restartTitle', { version: pill.version })}>
          <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
          <span>{t('status.update.restart')}</span>
        </button>
      )}
      {pill?.kind === 'downloading' && (
        <span className="statusbar__item" title={t('status.update.downloading', { version: pill.version, percent: String(pill.progress ?? 0) })}>
          <Download size={12} strokeWidth={2} aria-hidden="true" />
          <span className="statusbar__value">{pill.progress ?? 0}%</span>
        </span>
      )}
      <button ref={ref('update')} type="button" className="statusbar__btn statusbar__version" aria-expanded={open === 'update'} onClick={() => toggle('update')} title={t('status.update.title')} data-testid="statusbar-version">
        {info ? `v${info.version}` : <Spinner size={10} />}
        {pill?.kind === 'available' && <span className="statusbar__dot" aria-hidden="true" />}
      </button>
      <button type="button" className="statusbar__btn statusbar__btn--icon" aria-label={t('common.settings')} title={t('common.settings')} onClick={() => onOpenSettings()}>
        <Settings size={13} strokeWidth={2} aria-hidden="true" />
      </button>

      {open === 'usage' && (
        <Popover anchor={refs.current.usage ?? null} label={t('status.usage.title')} onClose={close} className="sb-pop--wide">
          <UsagePopover usage={usage.usage} available={usage.available} agents={agents} failover={usage.failover} t={t} onManage={() => (close(), onOpenSettings('accounts'))} onAgents={() => (close(), onOpenSettings('agents'))} />
        </Popover>
      )}
      {open === 'mic' && (
        <Popover anchor={refs.current.mic ?? null} label={t('status.mic.heading')} onClose={close}>
          <MicPopover t={t} label={micLabel} engine={engine} model={model} recording={recording} onMore={() => (close(), onOpenSettings('recording'))} />
        </Popover>
      )}
      {open === 'tools' && (
        <Popover anchor={refs.current.tools ?? null} label={t('status.tools.heading')} onClose={close}>
          <ToolsPopover t={t} onLibrary={() => (close(), onOpenLibrary())} />
        </Popover>
      )}
      {open === 'analysis' && analysis && (
        <Popover anchor={refs.current.analysis ?? null} label={t('status.analysis.title')} onClose={close}>
          <div className="sb-pop__body">
            <h3 className="sb-pop__title">
              <ScanEye size={13} aria-hidden="true" />
              {t('status.analysis.title')}
            </h3>
            <Progress value={anProg ?? 0} label={t('status.analysis.title')} />
            {analysis.jobs.map((j) => (
              <div key={j.id} className="st-row">
                <span className="st-row__label">
                  {j.kind} · <span className="sb-pop__mono">{j.sourceId}</span>
                </span>
                <span className="sb-pop__mono">{j.state === 'running' ? `${Math.round(j.progress * 100)}%` : j.state}</span>
              </div>
            ))}
            <div className="sb-pop__foot">
              <Button variant="ghost" onClick={() => void api.invoke('analysis:cancel')}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Popover>
      )}
      {open === 'pipeline' && snapshot && (
        <Popover anchor={refs.current.pipeline ?? null} label={t('status.pipeline.title')} onClose={close} className="sb-pop--wide" align="end">
          <PipelinePopover snapshot={snapshot} t={t} onOpen={() => (close(), onOpenEdit())} />
        </Popover>
      )}
      {open === 'update' && (
        <Popover anchor={refs.current.update ?? null} label={t('status.update.heading')} onClose={close} align="end">
          <UpdatePopover info={info} t={t} />
        </Popover>
      )}
    </footer>
  );
}

function agentName(id: string, agents: AgentStatus[] | null): string {
  return agents?.find((a) => a.id === id)?.label ?? id;
}

function AgentGlyph({ id }: { id: string }) {
  return (
    <span className={`agent-glyph agent-glyph--${id.replace(/[^a-z0-9-]/gi, '')}`} aria-hidden="true">
      {(id.replace(/^custom:/, '')[0] ?? '?').toUpperCase()}
    </span>
  );
}

function MiniBar({ percent }: { percent: number }) {
  return (
    <span className="usage-bar" data-tone={usageTone(percent)} aria-hidden="true">
      <span className="usage-bar__fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

function UsageSegments({ usage, agents, available, t }: { usage: AgentUsage[]; agents: AgentStatus[]; available: boolean; t: ST }) {
  if (available && usage.length > 0) {
    return (
      <>
        {usage.map((u) => {
          const w = tightestWindow(u);
          return (
            <span key={u.agent} className={`usage-seg${u.status === 'ok' ? '' : ' usage-seg--muted'}`}>
              <AgentGlyph id={u.agent} />
              {w ? (
                <>
                  <MiniBar percent={w.usedPercent} />
                  <span className="usage-seg__value" data-tone={usageTone(w.usedPercent)}>
                    {Math.round(w.usedPercent)}%{w.label ? ` ${w.label}` : ''}
                  </span>
                </>
              ) : (
                <span>{u.status === 'fetching' ? '···' : '--'}</span>
              )}
              {u.status === 'error' && <AlertTriangle size={11} className="usage-seg__stale" aria-label={u.error ?? t('status.usage.failed')} />}
            </span>
          );
        })}
      </>
    );
  }
  if (agents.length === 0) {
    return (
      <span className="usage-seg usage-seg--warn">
        <AlertTriangle size={11} aria-hidden="true" />
        <span>{t('status.usage.noAgent')}</span>
      </span>
    );
  }
  return (
    <>
      {agents.slice(0, 3).map((a) => (
        <span key={a.id} className="usage-seg usage-seg--muted" title={`${a.label}${a.version ? ` ${a.version}` : ''}`}>
          <AgentGlyph id={a.id} />
          <span>{a.label}</span>
        </span>
      ))}
    </>
  );
}

function UsagePopover({
  usage,
  available,
  agents,
  failover,
  t,
  onManage,
  onAgents,
}: {
  usage: AgentUsage[];
  available: boolean;
  agents: AgentStatus[] | null;
  failover: ReturnType<typeof useAgentUsage>['failover'];
  t: ST;
  onManage: () => void;
  onAgents: () => void;
}) {
  return (
    <div className="sb-pop__body" data-testid="statusbar-usage">
      <h3 className="sb-pop__title">{t('status.usage.title')}</h3>
      {available ? (
        usage.map((u) => (
          <div key={u.agent} className="usage-card">
            <div className="usage-card__head">
              <AgentGlyph id={u.agent} />
              <span className="usage-card__name">{agentName(u.agent, agents)}</span>
              {u.plan && <span className="usage-card__plan">{u.plan}</span>}
              {u.account && <span className="usage-card__account">{u.account}</span>}
            </div>
            {u.windows.length === 0 && <p className="st-note">{u.error ?? t('status.usage.unavailable')}</p>}
            {u.windows.map((w) => (
              <div key={w.label} className="usage-card__row">
                <span className="usage-card__label">{w.label}</span>
                <span className="usage-bar usage-bar--wide" data-tone={usageTone(w.usedPercent)} aria-hidden="true">
                  <span className="usage-bar__fill" style={{ width: `${w.usedPercent}%` }} />
                </span>
                <span className="usage-card__pct">{Math.round(w.usedPercent)}%</span>
                <span className="usage-card__reset">{resetIn(w.resetsAt) && t('status.usage.resetsIn', { time: resetIn(w.resetsAt) })}</span>
              </div>
            ))}
          </div>
        ))
      ) : (
        <>
          <p className="st-note">{t('status.usage.pending')}</p>
          {(agents ?? []).map((a) => (
            <div key={a.id} className="st-row">
              <span className="st-row__label">
                <AgentGlyph id={a.id} />
                {a.label}
              </span>
              <span className={`sb-pop__mono${a.installed ? '' : ' is-warn'}`}>{a.installed ? (a.version ?? t('status.usage.installed')) : t('status.usage.notInstalled')}</span>
            </div>
          ))}
        </>
      )}
      {failover && (
        <p className="st-note">
          <ArrowRightLeft size={12} aria-hidden="true" />
          {failover.enabled
            ? t('status.failover.detail', { current: agentName(failover.current ?? '—', agents), next: agentName(failover.next ?? '—', agents) })
            : t('status.failover.off')}
        </p>
      )}
      <div className="sb-pop__foot">
        <Button variant="ghost" onClick={onAgents}>
          {t('status.usage.agents')}
        </Button>
        <Button variant="ghost" onClick={onManage}>
          {t('status.usage.manage')}
        </Button>
      </div>
    </div>
  );
}

/** Mic level while the popover is open (not while recording: the recorder owns the mic then). */
function useMicLevel(active: boolean): { level: number; error: boolean } {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((x) => x.stop());
          return;
        }
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.sqrt(sum / buf.length));
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (!stopped) setError(true);
      });
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((x) => x.stop());
      void ctx?.close();
    };
  }, [active]);
  return { level, error };
}

function MicPopover({ t, label, engine, model, recording, onMore }: { t: ST; label: string; engine: string; model: string; recording: boolean; onMore: () => void }) {
  const probe = useMicLevel(!recording);
  const value = Math.min(1, probe.level * 5);
  return (
    <div className="sb-pop__body">
      <h3 className="sb-pop__title">
        <Mic size={13} aria-hidden="true" />
        {t('status.mic.heading')}
      </h3>
      <div className="st-row">
        <span className="st-row__label">{t('status.mic.device')}</span>
        <span className="sb-pop__mono sb-pop__clip">{label}</span>
      </div>
      <div className="st-row">
        <span className="st-row__label">{t('status.mic.level')}</span>
        <div className="sb-meter" role="meter" aria-label={t('status.mic.level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
          <span className="sb-meter__bar" style={{ transform: `scaleX(${value})` }} />
        </div>
      </div>
      {recording && <p className="st-note">{t('status.mic.locked')}</p>}
      {probe.error && !recording && (
        <p className="st-note st-note--warn">
          <MicOff size={12} aria-hidden="true" />
          {t('status.mic.failed')}
        </p>
      )}
      <div className="st-row">
        <span className="st-row__label">{t('status.transcription')}</span>
        <span className="sb-pop__mono">
          {engine} / {model}
        </span>
      </div>
      <p className="st-note">{t('status.mic.local')}</p>
      <div className="sb-pop__foot">
        <Button variant="ghost" onClick={onMore}>
          {t('status.moreSettings')}
        </Button>
      </div>
    </div>
  );
}

function ToolsPopover({ t, onLibrary }: { t: ST; onLibrary: () => void }) {
  const tools = useStore(toolsStore);
  const [busy, setBusy] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => api.on('tools:progress', (name, received, total) => setBusy((b) => (name in b ? { ...b, [name]: total ? received / total : null } : b))), []);
  const install = async (name: string) => {
    setBusy((b) => ({ ...b, [name]: null }));
    setError(null);
    try {
      const r = await api.invoke('tools:install', name);
      if (!r.ok) setError(r.error ?? t('common.error'));
    } catch (e) {
      setError(errMsg(e));
    }
    setBusy((b) => {
      const n = { ...b };
      delete n[name];
      return n;
    });
    void toolsStore.reload();
  };
  return (
    <div className="sb-pop__body" data-testid="statusbar-tools-popover">
      <h3 className="sb-pop__title">
        <Wrench size={13} aria-hidden="true" />
        {t('status.tools.heading')}
      </h3>
      {tools === null && <Spinner size={14} />}
      {tools?.map((tool) => (
        <div key={tool.name} className="st-row">
          <span className="st-row__label">
            {tool.installed ? <CircleCheck size={13} className="is-ok" aria-hidden="true" /> : <CircleAlert size={13} className="is-warn" aria-hidden="true" />}
            {tool.name}
          </span>
          {tool.installed ? (
            <span className="sb-pop__mono">{tool.version ?? t('status.usage.installed')}</span>
          ) : tool.name in busy ? (
            <span className="sb-pop__progress">
              <Progress {...(busy[tool.name] != null ? { value: busy[tool.name]! } : {})} label={tool.name} />
            </span>
          ) : (
            <Button size="sm" icon={<Download size={13} />} onClick={() => void install(tool.name)}>
              {t('status.tools.install')}
            </Button>
          )}
        </div>
      ))}
      {error && <p className="st-note st-note--warn">{error}</p>}
      <div className="sb-pop__foot">
        <IconButton label={t('common.refresh')} icon={<RefreshCw size={13} />} onClick={() => void toolsStore.reload()} />
        <Button variant="ghost" onClick={onLibrary}>
          {t('status.tools.library')}
        </Button>
      </div>
    </div>
  );
}

function PipelinePopover({ snapshot, t, onOpen }: { snapshot: ProjectSnapshot; t: ST; onOpen: () => void }) {
  const sum = summarizePipeline(snapshot.steps);
  return (
    <div className="sb-pop__body" data-testid="statusbar-pipeline-popover">
      <h3 className="sb-pop__title">
        <Workflow size={13} aria-hidden="true" />
        {t('status.pipeline.title')}
        <span className="sb-pop__mono sb-pop__push">
          {sum.done}/{sum.total}
        </span>
      </h3>
      <Progress value={sum.progress} label={t('status.pipeline.title')} />
      <ol className="pipe-list">
        {snapshot.steps.map((s) => (
          <li key={s.step} className={`pipe-list__item is-${s.state}`} title={s.note}>
            <span className="pipe-list__dot" aria-hidden="true" />
            <span className="pipe-list__name">{s.step}</span>
            <span className="pipe-list__state">{t(`step.${s.state}`)}</span>
          </li>
        ))}
      </ol>
      {snapshot.next && snapshot.next.step !== 'done' && (
        <div className="pipe-next">
          <span className="pipe-next__label">{t('status.pipeline.next')}</span>
          <span className="pipe-next__text">{snapshot.next.do || snapshot.next.why}</span>
          {snapshot.next.commands[0] && <code className="pipe-next__cmd">{snapshot.next.commands[0]}</code>}
        </div>
      )}
      <div className="sb-pop__foot">
        <Button variant="ghost" onClick={onOpen}>
          {t('status.pipeline.open')}
        </Button>
      </div>
    </div>
  );
}

function UpdatePopover({ info, t }: { info: AppInfo | null; t: ST }) {
  const s = useStore(updateStore);
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    void api
      .invoke('update:check')
      .then((x) => updateStore.set(x))
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };
  let note: ReactNode = null;
  if (s?.status === 'up-to-date') note = <p className="st-note st-note--ok">{t('status.update.latest')}</p>;
  else if (s?.status === 'available' || s?.status === 'notify-only') note = <p className="st-note">{t('status.update.available', { version: s.latest ?? '' })}</p>;
  else if (s?.status === 'downloading') note = <Progress value={s.progress ?? 0} label={t('status.update.downloading', { version: s.latest ?? '', percent: String(Math.round((s.progress ?? 0) * 100)) })} />;
  else if (s?.status === 'ready') note = <p className="st-note st-note--ok">{t('status.update.ready', { version: s.latest ?? '' })}</p>;
  else if (s?.status === 'error') note = <p className="st-note st-note--warn">{s.error ?? t('common.error')}</p>;
  return (
    <div className="sb-pop__body" data-testid="statusbar-update">
      <h3 className="sb-pop__title">
        <RefreshCw size={13} aria-hidden="true" />
        {t('status.update.heading')}
      </h3>
      <div className="st-row">
        <span className="st-row__label">{t('status.update.current')}</span>
        <span className="sb-pop__mono">v{info?.version ?? '—'}</span>
      </div>
      {note}
      {info && !info.packaged && <p className="st-note">{t('status.update.dev')}</p>}
      <div className="sb-pop__foot">
        {s?.status === 'ready' && (
          <Button variant="primary" onClick={() => void api.invoke('update:restart')}>
            {t('status.update.restart')}
          </Button>
        )}
        {s?.status === 'notify-only' && (
          <Button onClick={() => void api.invoke('app:openExternal', 'https://solocut.app/download')}>{t('status.update.download')}</Button>
        )}
        <Button busy={checking || s?.status === 'checking'} disabled={!info?.packaged} icon={<RefreshCw size={14} />} onClick={check}>
          {t('status.update.check')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Memory of the app. TODO(desktop IPC): uses `app:metrics` ({ totalBytes }) once declared; until then the item is
 * hidden rather than showing only the renderer heap, which would understate it.
 */
function MemoryItem({ t }: { t: ST }) {
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = (await invokeOptional('app:metrics')) as { totalBytes?: unknown } | undefined;
      if (alive) setBytes(typeof r?.totalBytes === 'number' ? r.totalBytes : null);
    };
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  if (bytes === null) return null;
  return (
    <>
      <span className="statusbar__item" title={t('status.memory')}>
        <span className="statusbar__value statusbar__mono">{formatMemory(bytes)}</span>
      </span>
      <Divider />
    </>
  );
}

function formatMemory(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function useElapsed(recording: boolean, startedAtMs?: number): string {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, [recording]);
  return formatElapsed(recording && startedAtMs !== undefined ? now - startedAtMs : 0);
}

/** Label of the configured mic ('default' → the system default's name when the browser exposes it). */
function useMicLabel(deviceId: string): string {
  const t = useST();
  const [label, setLabel] = useState<string>('');
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const mics = list.filter((d) => d.kind === 'audioinput');
        const hit = mics.find((d) => d.deviceId === deviceId) ?? (deviceId === 'default' ? mics.find((d) => d.deviceId === 'default') : undefined);
        if (alive) setLabel(hit?.label.replace(/^Default - /, '') ?? '');
      } catch {
        if (alive) setLabel('');
      }
    };
    void read();
    navigator.mediaDevices?.addEventListener?.('devicechange', read);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', read);
    };
  }, [deviceId]);
  return label || t('status.mic.default');
}
