import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, Camera, Check, Circle, FileText, Flag, Monitor, MonitorOff, RefreshCw, ShieldAlert, Square, Star, Timer, Video } from 'lucide-react';
import { Badge, Button, IconButton, RecordDot, Select, SettingRow, Switch, Tooltip } from '../ui';
import { useST } from '../shell/i18n';
import type { AppInfo, CaptureSource, MediaPermissionState, ProjectInfo } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import { recorder, type CameraChoice, type RecStatus } from '../lib/recorder';

const RESOLUTIONS = [
  { id: '720p', w: 1280, h: 720 },
  { id: '1080p', w: 1920, h: 1080 },
  { id: '4k', w: 3840, h: 2160 },
];

function stopStream(s: MediaStream | null | undefined): void {
  s?.getTracks().forEach((t) => t.stop());
}

function Preview({ stream, label, muted = true }: { stream: MediaStream | null; label: string; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="preview-box">
      {stream ? <video ref={ref} autoPlay playsInline muted={muted} /> : <span>{label}</span>}
      {stream && <span className="tag">{label}</span>}
    </div>
  );
}

function useLevel(stream: MediaStream | null): { level: number; clip: boolean } {
  const [v, setV] = useState({ level: 0, clip: false });
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setV({ level: 0, clip: false });
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    let clipUntil = 0;
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      const now = performance.now();
      if (peak >= 0.99) clipUntil = now + 1500;
      const db = 20 * Math.log10(Math.max(peak, 1e-5));
      setV({ level: Math.max(0, Math.min(1, (db + 60) / 60)), clip: now < clipUntil });
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      void ctx.close();
    };
  }, [stream]);
  return v;
}

export function Record({
  project,
  info,
  visible,
  toast,
  onIngested,
}: {
  project: ProjectInfo | null;
  info: AppInfo | null;
  visible: boolean;
  toast: (m: string) => void;
  onIngested: () => void;
}) {
  const t = useT();
  const st = useST();
  const [tele, setTele] = useState(false);
  const permLabel = (x: string) => (x === 'granted' ? st('rec.perm.granted') : x === 'denied' ? st('rec.perm.denied') : st('rec.perm.unknown'));
  const [status, setStatus] = useState<RecStatus>(recorder.get());
  const [perm, setPerm] = useState<MediaPermissionState | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [systemAudio, setSystemAudio] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [camIds, setCamIds] = useState<string[]>([]);
  const [micId, setMicId] = useState<string | null>(null);
  const [res, setRes] = useState('1080p');
  const [fps, setFps] = useState(30);
  const [countdownSec, setCountdownSec] = useState(3);
  const [count, setCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [camStreams, setCamStreams] = useState<{ choice: CameraChoice; stream: MediaStream }[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const recording = status.state !== 'idle';
  const active = visible || recording;
  const level = useLevel(micStream);

  useEffect(() => recorder.subscribe(setStatus), []);

  const loadDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list);
    setMicId((m) => m ?? list.find((d) => d.kind === 'audioinput')?.deviceId ?? null);
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const s = await api.invoke('record:sources');
      setSources(s);
      setSourceId((cur) => cur ?? s.find((x) => x.kind === 'screen')?.id ?? null);
    } catch (e) {
      toast(errMsg(e));
    }
  }, [toast]);

  useEffect(() => {
    if (!visible) return;
    void api.invoke('app:permissions').then(setPerm);
    void loadSources();
    void loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, [visible, loadSources, loadDevices]);

  // screen stream
  useEffect(() => {
    if (!active || !sourceId || recording) return;
    let cancelled = false;
    let s: MediaStream | null = null;
    void (async () => {
      try {
        await api.invoke('record:selectSource', sourceId, systemAudio);
        s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio: systemAudio });
        if (cancelled) stopStream(s);
        else setScreenStream(s);
      } catch (e) {
        if (!cancelled) toast(`${t('rec.screen')}: ${errMsg(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      stopStream(s);
      setScreenStream(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sourceId, systemAudio, fps]);

  // cameras
  useEffect(() => {
    if (!active || recording) return;
    let cancelled = false;
    const opened: { choice: CameraChoice; stream: MediaStream }[] = [];
    const r = RESOLUTIONS.find((x) => x.id === res) ?? RESOLUTIONS[1]!;
    void (async () => {
      for (const id of camIds) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: id }, width: { ideal: r.w }, height: { ideal: r.h }, frameRate: { ideal: fps } },
            audio: false,
          });
          const label = devices.find((d) => d.deviceId === id)?.label ?? id;
          opened.push({ choice: { deviceId: id, label, width: r.w, height: r.h, fps }, stream });
        } catch (e) {
          toast(`${t('rec.cameras')}: ${errMsg(e)}`);
        }
      }
      if (cancelled) opened.forEach((o) => stopStream(o.stream));
      else setCamStreams([...opened]);
    })();
    return () => {
      cancelled = true;
      opened.forEach((o) => stopStream(o.stream));
      setCamStreams([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, camIds.join(','), res, fps]);

  // microphone: no echo cancellation / noise suppression / AGC (docs/03)
  useEffect(() => {
    if (!active || !micId || recording) return;
    let cancelled = false;
    let s: MediaStream | null = null;
    void (async () => {
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 },
          video: false,
        });
        if (cancelled) stopStream(s);
        else {
          setMicStream(s);
          void loadDevices(); // labels appear after the first grant
        }
      } catch (e) {
        if (!cancelled) toast(`${t('rec.mic')}: ${errMsg(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      stopStream(s);
      setMicStream(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, micId]);

  useEffect(() => {
    if (status.state !== 'recording' || status.startedAtMs === undefined) return;
    const id = window.setInterval(() => setElapsed(performance.now() - status.startedAtMs!), 250);
    return () => window.clearInterval(id);
  }, [status.state, status.startedAtMs]);

  const start = async () => {
    if (!project || !info) return;
    for (let i = countdownSec; i > 0; i--) {
      setCount(i);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCount(null);
    try {
      setElapsed(0);
      await recorder.start(
        project.dir,
        { screen: screenStream, screenSourceId: sourceId, screenFps: fps, cameras: camStreams, mic: micStream && micId ? { deviceId: micId, label: devices.find((d) => d.deviceId === micId)?.label ?? 'mic', stream: micStream } : null },
        systemAudio,
        info.version,
        info.os,
      );
    } catch (e) {
      toast(`${t('rec.error')}: ${errMsg(e)}`);
    }
  };

  const [ingesting, setIngesting] = useState(false);
  // Stop -> `solocut ingest` registers the take as sources (clock offsets, NG/important markers) -> workspace
  const stop = async () => {
    await recorder.stop();
    if (!project) return;
    setIngesting(true);
    toast(t('rec.ingesting'));
    const r = await api.invoke('project:cli', project.dir, ['ingest']);
    setIngesting(false);
    if (!r.ok) {
      toast(`${t('rec.ingestFailed')}: ${r.error ?? ''}`);
      return;
    }
    toast(t('rec.saved'));
    // faces / on-screen PII / cursor logs for zoom, reframing and masks (cancellable from the workspace)
    void api.invoke('analysis:start', project.dir).catch(() => undefined);
    onIngested();
  };

  // the shell's title-bar Record button (and ⌘⇧R) toggles recording through this event
  const toggleRef = useRef<() => void>(() => undefined);
  toggleRef.current = () => {
    if (status.state === 'recording') void stop();
    else if (status.state === 'idle' && count === null && !ingesting) void start();
  };
  useEffect(() => {
    const on = () => toggleRef.current();
    window.addEventListener('solocut:record-toggle', on);
    return () => window.removeEventListener('solocut:record-toggle', on);
  }, []);

  const askAccess = async () => {
    await api.invoke('app:askMediaAccess', 'camera');
    await api.invoke('app:askMediaAccess', 'microphone');
    setPerm(await api.invoke('app:permissions'));
    void loadDevices();
  };

  if (!project) {
    return (
      <div className="ws">
        <div className="titlebar">
          <span className="title">{t('rec.title')}</span>
        </div>
        <div className="empty">{t('rec.needProject')}</div>
      </div>
    );
  }

  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const mmss = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const mod = info?.os === 'mac' ? '⌘⇧' : 'Ctrl+Shift+';

  const ngCount = status.markers.filter((m) => m.kind === 'ng').length;
  const impCount = status.markers.filter((m) => m.kind === 'important').length;
  const canStart = !ingesting && count === null && Boolean(screenStream || camStreams.length > 0 || micStream);
  const toggleTele = () => {
    const next = !tele;
    setTele(next);
    void api.invoke('record:teleprompter', next ? project.dir : null);
  };

  return (
    <div className={`ws recx${recording ? ' is-recording' : ''}`}>
      <div className="recx__bar-wrap">
        <div className={`recx__bar${recording ? ' is-recording' : ''}`} role="toolbar" aria-label={t('rec.title')}>
          <span className="recx__timer">
            <RecordDot active={status.state === 'recording'} size={8} />
            <span>{mmss(recording ? elapsed : 0)}</span>
          </span>
          <LevelBars level={level.level} clip={level.clip} off={!micStream} />
          <span className="recx__sep" aria-hidden="true" />
          {recording ? (
            <button type="button" className="recx__go is-stop" disabled={status.state === 'stopping'} onClick={() => void stop()}>
              <Square size={11} fill="currentColor" /> {status.state === 'stopping' ? st('rec.saving') : t('rec.stop')}
            </button>
          ) : (
            <button type="button" className="recx__go" disabled={!canStart} onClick={() => void start()} data-testid="record-start">
              <Circle size={11} fill="currentColor" /> {ingesting ? t('rec.ingesting') : t('rec.start')}
            </button>
          )}
          <span className="recx__sep" aria-hidden="true" />
          <Tooltip label={st('rec.markNg', { key: `${mod}N` })}>
            <button type="button" className="recx__mark" disabled={!recording} onClick={() => recorder.mark('ng')}>
              <Flag size={13} /> NG <span className="recx__n">{ngCount}</span>
            </button>
          </Tooltip>
          <Tooltip label={st('rec.markImportant', { key: `${mod}M` })}>
            <button type="button" className="recx__mark" disabled={!recording} onClick={() => recorder.mark('important')}>
              <Star size={13} /> <span className="recx__n">{impCount}</span>
            </button>
          </Tooltip>
          <span className="recx__sep" aria-hidden="true" />
          <Tooltip label={t('rec.countdown')}>
            <span className="recx__count">
              <Timer size={13} aria-hidden="true" />
              <select value={countdownSec} disabled={recording} aria-label={t('rec.countdown')} onChange={(e) => setCountdownSec(Number(e.target.value))}>
                {[0, 3, 5, 10].map((x) => (
                  <option key={x} value={x}>
                    {x}s
                  </option>
                ))}
              </select>
            </span>
          </Tooltip>
          <Tooltip label={t('rec.teleprompter')} align="end">
            <IconButton label={t('rec.teleprompter')} icon={<FileText size={14} />} selected={tele} onClick={toggleTele} />
          </Tooltip>
          {recording && <span className="recx__size">{(status.bytes / 1e6).toFixed(1)} MB</span>}
        </div>
      </div>
      <div className="recx__body">
        <div className="recx__stage">
          {perm && perm.screen !== 'granted' && perm.screen !== 'not-determined' && (
            <div className="recx__banner is-warn">
              <ShieldAlert size={14} aria-hidden="true" />
              <span>{t('rec.permScreen')}</span>
              <Button size="sm" onClick={() => void api.invoke('app:openScreenSettings')}>
                {t('rec.permOpen')}
              </Button>
            </div>
          )}
          {perm && (perm.camera === 'not-determined' || perm.microphone === 'not-determined') && (
            <div className="recx__banner">
              <Camera size={14} aria-hidden="true" />
              <span>{st('rec.permState', { camera: permLabel(perm.camera), mic: permLabel(perm.microphone) })}</span>
              <Button size="sm" onClick={() => void askAccess()}>
                {t('rec.permCamera')}
              </Button>
            </div>
          )}
          <div className={`recx__previews${camStreams.length > 0 ? '' : ' no-cam'}`}>
            <Preview stream={screenStream} label={t('rec.screen')} />
            <div className="recx__cams">
              {camStreams.length === 0 ? (
                <Preview stream={null} label={t('rec.cameras')} />
              ) : (
                camStreams.map((c, i) => <Preview key={c.choice.deviceId} stream={c.stream} label={`camera-${i + 1} · ${c.choice.label}`} />)
              )}
            </div>
          </div>
          <div className="recx__sources">
            <div className="recx__sources-head">
              <span className="recx__h">{t('rec.screen')}</span>
              <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} disabled={recording} onClick={() => void loadSources()}>
                {t('rec.refresh')}
              </Button>
            </div>
            <div className="recx__source-grid">
              <button type="button" className={`recx__source${sourceId === null ? ' is-selected' : ''}`} disabled={recording} onClick={() => setSourceId(null)}>
                <span className="recx__source-img is-none">
                  <MonitorOff size={20} />
                </span>
                <span className="recx__source-name">{t('rec.noScreen')}</span>
              </button>
              {sources.map((src) => (
                <button key={src.id} type="button" className={`recx__source${sourceId === src.id ? ' is-selected' : ''}`} disabled={recording} onClick={() => setSourceId(src.id)}>
                  <span className="recx__source-img">
                    <img src={src.thumbnail} alt="" />
                    <span className="recx__source-kind">{src.kind === 'screen' ? <Monitor size={11} /> : <AppWindow size={11} />}</span>
                  </span>
                  <span className="recx__source-name" title={src.name}>
                    {src.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <aside className="recx__side">
          <h3 className="recx__h">{t('rec.cameras')}</h3>
          {cams.length === 0 && <p className="st-note">{st('rec.noCameras')}</p>}
          <div className="recx__chips">
            {cams.map((d) => {
              const on = camIds.includes(d.deviceId);
              return (
                <button
                  key={d.deviceId}
                  type="button"
                  className={`recx__chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  disabled={recording}
                  onClick={() => setCamIds((ids) => (on ? ids.filter((x) => x !== d.deviceId) : [...ids, d.deviceId]))}
                >
                  <Video size={13} aria-hidden="true" />
                  <span>{d.label || d.deviceId.slice(0, 8)}</span>
                  {on && <Check size={12} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          <SettingRow label={st('rec.resolution')}>
            <Select ariaLabel={st('rec.resolution')} value={res} disabled={recording} options={RESOLUTIONS.map((r) => ({ value: r.id, label: r.id }))} onChange={setRes} />
          </SettingRow>
          <SettingRow label="fps">
            <Select ariaLabel="fps" value={fps} disabled={recording} options={[24, 30, 60].map((f) => ({ value: f, label: `${f} fps` }))} onChange={setFps} />
          </SettingRow>
          <h3 className="recx__h">{t('rec.mic')}</h3>
          <Select
            ariaLabel={t('rec.mic')}
            wide
            value={micId ?? ''}
            disabled={recording}
            options={[{ value: '', label: t('rec.noMic') }, ...mics.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId.slice(0, 8) }))]}
            onChange={(v) => setMicId(v || null)}
          />
          <div className="recx__meter">
            <LevelBars level={level.level} clip={level.clip} off={!micStream} wide />
            {level.clip && <Badge tone="danger">{t('rec.clip')}</Badge>}
          </div>
          {info?.os !== 'linux' && <Switch label={t('rec.systemAudio')} checked={systemAudio} disabled={recording} onChange={setSystemAudio} />}
          <h3 className="recx__h">{t('rec.markers')}</h3>
          <p className="st-note">{t('rec.hotkeys', { ng: `${mod}N`, imp: `${mod}M` })}</p>
          {status.error && <div className="notice err">{status.error}</div>}
        </aside>
      </div>
      {count !== null && (
        <div className="recx__countdown" aria-live="assertive">
          <span>{count}</span>
        </div>
      )}
    </div>
  );
}

/** Segmented level meter (green → yellow → red), like a hardware VU. `level` is 0..1 of a -60..0 dB scale. */
function LevelBars({ level, clip, off, wide = false }: { level: number; clip: boolean; off: boolean; wide?: boolean }) {
  const n = wide ? 24 : 12;
  const lit = off ? 0 : Math.round(level * n);
  return (
    <span className={`levelbars${wide ? ' levelbars--wide' : ''}${clip ? ' is-clip' : ''}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`levelbars__seg${i < lit ? ' is-on' : ''}${i >= n * 0.85 ? ' is-hot' : i >= n * 0.65 ? ' is-warm' : ''}`} />
      ))}
    </span>
  );
}
