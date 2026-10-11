import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Circle, FileVideo, Globe, Square, Wand2, X } from 'lucide-react';
import {
  activeReference, benchReducer, captureStep, DEFAULT_RANGE, formatClock, initialCapture, normalizeRange, parseClock, parseReferenceUrl,
  RANGE_PRESETS, summarizeProfile, type BenchEntry, type BenchRange, type BenchScope, type BenchState, type CaptureState,
} from '@shared/benchmark';
import { LangContext, useT, type TKey } from '../i18n';
import { api, errMsg } from '../lib/api';
import { Button, Note, Progress, Segmented, Select, TextField } from '../ui';

type RangeChoice = (typeof RANGE_PRESETS)[number]['id'] | 'custom';

function rangeOf(choice: RangeChoice, from: string, to: string): BenchRange {
  const preset = RANGE_PRESETS.find((p) => p.id === choice);
  if (preset) return { ...preset.range };
  return normalizeRange({ start: parseClock(from) ?? DEFAULT_RANGE.start, end: parseClock(to) ?? DEFAULT_RANGE.end });
}

function pickMime(): string | undefined {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
  return undefined;
}

/**
 * Records the reference window while the user plays the chosen part (captureStep decides when), into a temp file
 * in main. Resolves with the recording id, or null when cancelled.
 */
function useReferenceCapture(onState: (s: CaptureState | null) => void) {
  const cancel = useRef<(() => void) | null>(null);
  const run = useCallback(
    async (range: BenchRange): Promise<string | null> => {
      const arm = await api.invoke('bench:captureArm');
      if (!arm.ok) throw new Error(arm.error ?? 'capture');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const { id } = await api.invoke('bench:captureBegin');
      const mime = pickMime();
      const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 2_500_000 });
      let queue: Promise<unknown> = Promise.resolve();
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) queue = queue.then(async () => api.invoke('bench:captureAppend', id, new Uint8Array(await ev.data.arrayBuffer())));
      };
      const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
      let state = initialCapture(range, Date.now());
      onState(state);
      return new Promise<string | null>((resolve, reject) => {
        let polling = false;
        let finished = false;
        const finish = async (keep: boolean) => {
          if (finished) return;
          finished = true;
          window.clearInterval(timer);
          cancel.current = null;
          try {
            if (rec.state !== 'inactive') {
              rec.stop();
              await stopped;
            }
            await queue;
            for (const tr of stream.getTracks()) tr.stop();
            onState(null);
            if (!keep) {
              await api.invoke('bench:captureDiscard', id);
              resolve(null);
              return;
            }
            await api.invoke('bench:captureEnd', id);
            resolve(id);
          } catch (e) {
            await api.invoke('bench:captureDiscard', id).catch(() => undefined);
            reject(e);
          }
        };
        cancel.current = () => void finish(false);
        // the user closed the reference window or stopped sharing
        for (const tr of stream.getVideoTracks()) tr.addEventListener('ended', () => void finish(state.recorded > 1));
        const timer = window.setInterval(async () => {
          if (polling || finished) return;
          polling = true;
          try {
            const sample = await api.invoke('bench:player');
            const { state: next, action } = captureStep(state, sample, Date.now());
            state = next;
            onState(next);
            if (action === 'start' && rec.state === 'inactive') rec.start(1000);
            else if (action === 'pause' && rec.state === 'recording') rec.pause();
            else if (action === 'resume' && rec.state === 'paused') rec.resume();
            else if (action === 'stop') await finish(true);
          } finally {
            polling = false;
          }
        }, 500);
      });
    },
    [onState],
  );
  return useMemo(() => ({ run, cancel: () => cancel.current?.() }), [run]);
}

/** `bench:unapply` for one scope; returns the new state (null on failure, after a toast). */
async function removeReference(scope: BenchScope, projectDir: string | null | undefined, toast: (m: string) => void, t: ReturnType<typeof useT>): Promise<BenchState | null> {
  try {
    const r = await api.invoke('bench:unapply', scope, projectDir ?? undefined);
    if (!r.ok) {
      toast(r.error ?? t('common.error'));
      return null;
    }
    toast(t('bench.removed'));
    return r.state ?? null;
  } catch (e) {
    toast(errMsg(e));
    return null;
  }
}

/**
 * Reference videos ("お手本動画", docs/09): add one from a local file or a YouTube / TikTok page played in an in-app
 * window, see its profile (cut pace, captions, SFX, BGM) and apply it to this video or to every video.
 */
export function BenchmarkPanel({ projectDir, toast }: { projectDir?: string | null; toast: (m: string) => void }) {
  const t = useT();
  const lang = useContext(LangContext);
  const [state, setState] = useState<BenchState | null>(null);
  const [flow, dispatch] = useReducer(benchReducer, { step: 'idle' });
  const [source, setSource] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [choice, setChoice] = useState<RangeChoice>('first3');
  const [from, setFrom] = useState('0:00');
  const [to, setTo] = useState('3:00');
  const [cap, setCap] = useState<CaptureState | null>(null);
  const [picked, setPicked] = useState<BenchEntry | null>(null);
  const [scope, setScope] = useState<BenchScope>(projectDir ? 'project' : 'global');
  const [applying, setApplying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const capture = useReferenceCapture(setCap);

  const load = useCallback(async () => {
    try {
      setState(await api.invoke('bench:list', projectDir ?? undefined));
    } catch (e) {
      toast(errMsg(e));
    }
  }, [projectDir, toast]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!projectDir) setScope('global');
  }, [projectDir]);
  useEffect(() => {
    const off1 = api.on('bench:progress', (fraction, label) => dispatch({ type: 'progress', fraction, label }));
    const off2 = api.on('bench:closed', () => {
      capture.cancel();
      dispatch({ type: 'reset' });
    });
    return () => {
      off1();
      off2();
    };
  }, [capture]);

  const range = rangeOf(choice, from, to);

  const analyze = async (req: { file?: string; captureId?: string; url?: string }) => {
    dispatch({ type: 'analyze', label: t('bench.analyzing') });
    const r = await api.invoke('bench:analyze', { ...req, range });
    if (r.ok && r.entry) {
      dispatch({ type: 'analyzed', entry: r.entry });
      setPicked(r.entry);
      void load();
    } else dispatch({ type: 'fail', message: r.error ?? t('common.error') });
  };

  const openUrl = async () => {
    const p = parseReferenceUrl(url);
    if (!p.ok) {
      setUrlError(t(`bench.err.${p.error}` as TKey));
      return;
    }
    setUrlError(null);
    const r = await api.invoke('bench:open', p.url);
    if (!r.ok) toast(r.error ?? t('common.error'));
    else dispatch({ type: 'openUrl', url: p.url, platform: p.platform });
  };

  const startCapture = async () => {
    if (flow.step !== 'browsing') return;
    const target = flow.url;
    dispatch({ type: 'startCapture' });
    try {
      const id = await capture.run(range);
      if (!id) {
        dispatch({ type: 'openUrl', url: target, platform: flow.platform });
        return;
      }
      await api.invoke('bench:close');
      await analyze({ captureId: id, url: target });
    } catch (e) {
      dispatch({ type: 'fail', message: t('bench.err.capture', { msg: errMsg(e) }) });
    }
  };

  const chooseFile = async () => {
    const f = await api.invoke('bench:chooseFile');
    if (f) setFile(f);
  };

  const apply = async () => {
    if (!picked) return;
    setApplying(true);
    try {
      const r = await api.invoke('bench:apply', picked.id, scope, projectDir ?? undefined);
      if (!r.ok) toast(r.error ?? t('common.error'));
      else {
        toast(t('bench.appliedDone'));
        if (r.state) setState(r.state);
      }
    } finally {
      setApplying(false);
    }
  };

  const remove = async (sc: BenchScope) => {
    setRemoving(true);
    const next = await removeReference(sc, projectDir, toast, t);
    setRemoving(false);
    if (next) setState(next);
  };

  const active = activeReference(state?.applied);
  const busy = flow.step === 'analyzing' || flow.step === 'capturing';
  const capHint = cap?.hint
    ? t(`bench.hint.${cap.hint}` as TKey, { at: formatClock(cap.hint === 'before' || cap.hint === 'after' ? cap.range.start : 0), len: formatClock(cap.range.end - cap.range.start) })
    : null;

  return (
    <section className="bench" data-testid="bench-panel">
      <header className="bench__head">
        <h3 className="bench__title">{t('bench.title')}</h3>
        {!active && (
          <span className="bench__active" data-testid="bench-active">
            {t('bench.none')}
          </span>
        )}
      </header>
      {(['project', 'global'] as const).map((sc) => {
        const ref = state?.applied[sc];
        if (!ref) return null;
        return (
          <div key={sc} className="bench__row bench__applied" data-testid={`bench-applied-${sc}`}>
            <span>{`${t('bench.applied', { name: ref.title })}（${t(sc === 'project' ? 'bench.appliedProject' : 'bench.appliedGlobal')}）`}</span>
            <Button size="sm" variant="ghost" icon={<X size={12} />} disabled={busy || removing} onClick={() => void remove(sc)}>
              {t('bench.remove')}
            </Button>
          </div>
        );
      })}
      <p className="bench__desc">{t('bench.desc')}</p>
      <Note tone="warn">{t('bench.legal')}</Note>

      <div className="bench__add">
        <Segmented
          size="sm"
          ariaLabel={t('bench.add')}
          value={source}
          onChange={(v) => setSource(v)}
          options={[
            { value: 'url', label: t('bench.byUrl'), icon: <Globe size={13} /> },
            { value: 'file', label: t('bench.byFile'), icon: <FileVideo size={13} /> },
          ]}
        />
        <div className="bench__row">
          <span className="bench__label">{t('bench.range')}</span>
          <Select<RangeChoice>
            ariaLabel={t('bench.range')}
            value={choice}
            disabled={busy}
            onChange={setChoice}
            options={[
              { value: 'first1', label: t('bench.first1') },
              { value: 'first3', label: t('bench.first3') },
              { value: 'first5', label: t('bench.first5') },
              { value: 'custom', label: t('bench.custom') },
            ]}
          />
          {choice === 'custom' && (
            <>
              <TextField className="bench__clock" aria-label={t('bench.from')} value={from} disabled={busy} onChange={(e) => setFrom(e.target.value)} mono />
              <span>–</span>
              <TextField className="bench__clock" aria-label={t('bench.to')} value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} mono />
              <span className="bench__dim">{`${formatClock(range.start)}–${formatClock(range.end)}`}</span>
            </>
          )}
        </div>
        {source === 'url' ? (
          <>
            <div className="bench__row">
              <TextField
                className="bench__url"
                placeholder={t('bench.urlPlaceholder')}
                value={url}
                invalid={!!urlError}
                disabled={busy}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void openUrl()}
                data-testid="bench-url"
              />
              <Button icon={<Globe size={14} />} disabled={busy} onClick={() => void openUrl()}>
                {t('bench.open')}
              </Button>
            </div>
            {urlError && <p className="bench__error">{urlError}</p>}
            {flow.step === 'browsing' && (
              <div className="bench__row">
                <span className="bench__dim">{t('bench.opened')}</span>
                <Button variant="record" icon={<Circle size={12} />} onClick={() => void startCapture()} data-testid="bench-start">
                  {t('bench.startCapture')}
                </Button>
              </div>
            )}
            {flow.step === 'capturing' && cap && (
              <div className="bench__capture">
                <Progress
                  value={(cap.recorded / Math.max(1, cap.range.end - cap.range.start)) * 100}
                  label={t(cap.phase === 'recording' ? 'bench.recording' : 'bench.paused', { done: formatClock(cap.recorded), total: formatClock(cap.range.end - cap.range.start) })}
                />
                {capHint && <span className="bench__dim">{capHint}</span>}
                <Button size="sm" icon={<Square size={12} />} onClick={() => capture.cancel()}>
                  {t('bench.cancel')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="bench__row">
            <Button icon={<FileVideo size={14} />} disabled={busy} onClick={() => void chooseFile()}>
              {t('bench.chooseFile')}
            </Button>
            {file && <code className="bench__file">{file}</code>}
            <Button variant="primary" icon={<Wand2 size={14} />} disabled={!file || busy} onClick={() => file && void analyze({ file })}>
              {t('bench.analyze')}
            </Button>
          </div>
        )}
        {flow.step === 'analyzing' && <Progress value={flow.fraction * 100} label={flow.label || t('bench.analyzing')} />}
        {flow.step === 'error' && <p className="bench__error">{flow.message}</p>}
      </div>

      {picked && (
        <div className="bench__result" data-testid="bench-result">
          <h4 className="bench__subtitle">
            {t('bench.result')}: {picked.title}
            {picked.analyzed && <span className="bench__dim"> · {picked.analyzed}</span>}
          </h4>
          <dl className="bench__summary">
            {summarizeProfile(picked.profile, lang).map((r) => (
              <div key={r.id} className="bench__summary-row">
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          <div className="bench__row">
            <Segmented
              size="sm"
              ariaLabel={t('bench.apply')}
              value={scope}
              onChange={setScope}
              options={[
                { value: 'project', label: t('bench.forProject'), disabled: !projectDir, title: projectDir ? undefined : t('bench.noProject') },
                { value: 'global', label: t('bench.forAll') },
              ]}
            />
            <Button variant="primary" busy={applying} disabled={scope === 'project' && !projectDir} onClick={() => void apply()} data-testid="bench-apply">
              {t('bench.apply')}
            </Button>
          </div>
        </div>
      )}

      {state && state.profiles.length > 0 && (
        <div className="bench__saved">
          <h4 className="bench__subtitle">{t('bench.saved')}</h4>
          <ul className="bench__list">
            {state.profiles.map((e) => (
              <li key={e.profilePath} className={picked?.profilePath === e.profilePath ? 'is-on' : ''}>
                <span className="bench__name" title={e.url ?? e.profilePath}>
                  {e.title}
                </span>
                {e.analyzed && <span className="bench__dim">{e.analyzed}</span>}
                <Button size="sm" variant="ghost" onClick={() => setPicked(e)}>
                  {t('bench.use')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** One line in the editing screen: which reference is used, and 変更 (opens the panel). */
export function BenchmarkBadge({ projectDir, toast }: { projectDir: string; toast: (m: string) => void }) {
  const t = useT();
  const [state, setState] = useState<BenchState | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      setState(await api.invoke('bench:list', projectDir));
    } catch {
      setState(null);
    }
  }, [projectDir]);
  useEffect(() => void load(), [load, open]);
  const active = activeReference(state?.applied);
  return (
    <div className="bench-badge" data-testid="bench-badge">
      <span className="bench-badge__text">
        {active ? `${t('bench.applied', { name: active.ref.title })}（${t(active.scope === 'project' ? 'bench.appliedProject' : 'bench.appliedGlobal')}）` : t('bench.none')}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t('bench.change')}
      </Button>
      {active && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void removeReference(active.scope, projectDir, toast, t).then((next) => {
              if (next) setState(next);
            })
          }
          data-testid="bench-badge-remove"
        >
          {t('bench.remove')}
        </Button>
      )}
      {open && (
        <div className="modal-back" onClick={() => setOpen(false)}>
          <div className="modal bench-modal" onClick={(e) => e.stopPropagation()}>
            <BenchmarkPanel projectDir={projectDir} toast={toast} />
            <div className="bench-modal__foot">
              <Button onClick={() => setOpen(false)}>{t('common.close')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
