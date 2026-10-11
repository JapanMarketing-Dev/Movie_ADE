import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, FileText, Monitor, RefreshCw, Square } from 'lucide-react';
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
        { screen: screenStream, screenFps: fps, cameras: camStreams, mic: micStream && micId ? { deviceId: micId, label: devices.find((d) => d.deviceId === micId)?.label ?? 'mic', stream: micStream } : null },
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
    onIngested();
  };

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

  return (
    <div className="ws">
      <div className="titlebar">
        <span className="title">{t('rec.title')}</span>
        <span className="dim">{project.title}</span>
        <span className="grow" />
        {recording && <span className="pill accent">● {t('rec.recording')}</span>}
      </div>
      <div className="rec" style={{ flex: 1, minHeight: 0 }}>
        <div className={`rec-stage ${status.state === 'recording' ? 'live' : ''}`}>
          {perm && perm.screen !== 'granted' && perm.screen !== 'not-determined' && (
            <div className="notice err row" style={{ justifyContent: 'space-between' }}>
              <span>{t('rec.permScreen')}</span>
              <button className="btn small" onClick={() => void api.invoke('app:openScreenSettings')}>
                {t('rec.permOpen')}
              </button>
            </div>
          )}
          {perm && (perm.camera === 'not-determined' || perm.microphone === 'not-determined') && (
            <div className="notice row" style={{ justifyContent: 'space-between' }}>
              <span>camera: {perm.camera} / mic: {perm.microphone}</span>
              <button className="btn small" onClick={() => void askAccess()}>
                {t('rec.permCamera')}
              </button>
            </div>
          )}
          <div className="previews">
            <Preview stream={screenStream} label={t('rec.screen')} />
            <div className="cams">
              {camStreams.length === 0 ? (
                <Preview stream={null} label={t('rec.cameras')} />
              ) : (
                camStreams.map((c, i) => <Preview key={c.choice.deviceId} stream={c.stream} label={`camera-${i + 1} · ${c.choice.label}`} />)
              )}
            </div>
          </div>
          <div className="field">
            <label>
              {t('rec.screen')}{' '}
              <button className="btn ghost small" onClick={() => void loadSources()} disabled={recording}>
                <RefreshCw size={12} /> {t('rec.refresh')}
              </button>
            </label>
            <div className="sources">
              <button className={`source ${sourceId === null ? 'selected' : ''}`} disabled={recording} onClick={() => setSourceId(null)}>
                <div style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: '#000', borderRadius: 4 }}>
                  <Monitor size={22} color="#6f727a" />
                </div>
                <div className="n">{t('rec.noScreen')}</div>
              </button>
              {sources.map((s) => (
                <button key={s.id} className={`source ${sourceId === s.id ? 'selected' : ''}`} disabled={recording} onClick={() => setSourceId(s.id)}>
                  <img src={s.thumbnail} alt="" />
                  <div className="n">{s.name}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <aside className="rec-side">
          <div className="field">
            <label>{t('rec.cameras')}</label>
            {cams.length === 0 && <span className="dim">—</span>}
            {cams.map((d) => (
              <label key={d.deviceId} className="check">
                <input
                  type="checkbox"
                  disabled={recording}
                  checked={camIds.includes(d.deviceId)}
                  onChange={(e) => setCamIds((ids) => (e.target.checked ? [...ids, d.deviceId] : ids.filter((x) => x !== d.deviceId)))}
                />
                {d.label || d.deviceId.slice(0, 8)}
              </label>
            ))}
            <div className="row">
              <select className="input" value={res} disabled={recording} onChange={(e) => setRes(e.target.value)}>
                {RESOLUTIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
              <select className="input" value={fps} disabled={recording} onChange={(e) => setFps(Number(e.target.value))}>
                {[24, 30, 60].map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>{t('rec.mic')}</label>
            <select className="input" value={micId ?? ''} disabled={recording} onChange={(e) => setMicId(e.target.value || null)}>
              <option value="">{t('rec.noMic')}</option>
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
            </select>
            <div className="row">
              <div className="meter" style={{ flex: 1 }}>
                <div className="fill" style={{ width: `${level.level * 100}%` }} />
              </div>
              {level.clip && <span className="pill accent">{t('rec.clip')}</span>}
            </div>
          </div>
          {info?.os !== 'linux' && (
            <label className="check">
              <input type="checkbox" checked={systemAudio} disabled={recording} onChange={(e) => setSystemAudio(e.target.checked)} />
              {t('rec.systemAudio')}
            </label>
          )}
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t('rec.countdown')}</label>
              <select className="input" value={countdownSec} disabled={recording} onChange={(e) => setCountdownSec(Number(e.target.value))}>
                {[0, 3, 5, 10].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => void api.invoke('record:teleprompter', project.dir)}>
              <FileText size={14} /> {t('rec.teleprompter')}
            </button>
          </div>
          <div className="dim" style={{ fontSize: 12 }}>
            {t('rec.hotkeys', { ng: `${mod}N`, imp: `${mod}M` })}
          </div>
          <div style={{ flex: 1 }} />
          {recording && (
            <>
              <div className="timer">{mmss(elapsed)}</div>
              <div className="row" style={{ justifyContent: 'center' }}>
                <span className="pill">{(status.bytes / 1e6).toFixed(1)} MB</span>
                <span className="pill">
                  {t('rec.markers')}: NG {status.markers.filter((m) => m.kind === 'ng').length} / ★ {status.markers.filter((m) => m.kind === 'important').length}
                </span>
              </div>
            </>
          )}
          {status.error && <div className="notice err">{status.error}</div>}
          {recording ? (
            <button className="recbtn stop" disabled={status.state === 'stopping'} onClick={() => void stop()}>
              <Square size={16} fill="currentColor" /> {t('rec.stop')}
            </button>
          ) : (
            <button className="recbtn" disabled={ingesting || count !== null || (!screenStream && camStreams.length === 0 && !micStream)} onClick={() => void start()}>
              <Circle size={16} fill="currentColor" /> {ingesting ? t('rec.ingesting') : t('rec.start')}
            </button>
          )}
        </aside>
      </div>
      {count !== null && <div className="countdown">{count}</div>}
    </div>
  );
}
