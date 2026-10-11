import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, Circle, Crop, Flag, Maximize, Monitor, MonitorOff, RefreshCw, ShieldAlert, Square, Star, Timer, User } from 'lucide-react';
import { Badge, Button, IconButton, RecordDot, Select, SettingRow, Switch, Tooltip } from '../ui';
import { setSetting, settingsStore, useStore } from '../shell/stores';
import { useST } from '../shell/i18n';
import type { AppInfo, CaptureSource, MediaPermissionState, ProjectInfo } from '@shared/types';
import { displayIdOf } from '@shared/analysis';
import { displayPixels, fitRegion, isWholeDisplay, parseRegion, regionPercent, streamCrop, type DisplayInfo, type Region } from '@shared/region';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import { recorder, type CameraChoice, type RecStatus } from '../lib/recorder';
import { keepAvailable, mainCamera, recordingOrder, toggleCamera } from '../lib/cameras';
import { runAutoFinish, sentTakes } from '../lib/autoFinish';
import { sendToAgent } from '../terminal/agentSend';

const RESOLUTIONS = [
  { id: '720p', w: 1280, h: 720 },
  { id: '1080p', w: 1920, h: 1080 },
  { id: '4k', w: 3840, h: 2160 },
];

function stopStream(s: MediaStream | null | undefined): void {
  s?.getTracks().forEach((t) => t.stop());
}

function Video({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted />;
}

function Preview({ stream, label, aspect }: { stream: MediaStream | null; label: string; aspect?: string }) {
  return (
    <div className="preview-box" style={aspect ? { aspectRatio: aspect } : undefined}>
      {stream ? <Video stream={stream} /> : <span>{label}</span>}
      {stream && <span className="tag">{label}</span>}
    </div>
  );
}

/** The screen preview with the recording region drawn as a frame (outside dimmed). */
function ScreenPreview({ stream, label, display, region }: { stream: MediaStream | null; label: string; display: DisplayInfo | null; region: Region | null }) {
  const px = display ? displayPixels(display) : null;
  const pct = region && display ? regionPercent(region, display) : null;
  return (
    <div className="preview-box recx__screen" style={px ? { aspectRatio: `${px.width} / ${px.height}` } : undefined}>
      {stream ? <Video stream={stream} /> : <span>{label}</span>}
      {stream && pct && (
        <span
          className="recx__region"
          aria-hidden="true"
          style={{ left: `${pct.left}%`, top: `${pct.top}%`, width: `${pct.width}%`, height: `${pct.height}%` }}
        />
      )}
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
  const settings = useStore(settingsStore);
  const permLabel = (x: string) => (x === 'granted' ? st('rec.perm.granted') : x === 'denied' ? st('rec.perm.denied') : st('rec.perm.unknown'));
  const [status, setStatus] = useState<RecStatus>(recorder.get());
  const [perm, setPerm] = useState<MediaPermissionState | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [systemAudio, setSystemAudio] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [camIds, setCamIds] = useState<string[]>([]);
  const [mainCamId, setMainCamId] = useState<string | null>(null);
  const camInit = useRef(false);
  const [micId, setMicId] = useState<string | null>(null);
  const [res, setRes] = useState('1080p');
  const [fps, setFps] = useState(30);
  const [countdownSec, setCountdownSec] = useState(3);
  const [count, setCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [picking, setPicking] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  // every connected camera is opened while the screen is shown (live thumbnails); only the selected ones are recorded
  const [camStreams, setCamStreams] = useState<{ choice: CameraChoice; stream: MediaStream }[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const recording = status.state !== 'idle';
  const active = visible || recording;
  const level = useLevel(micStream);

  useEffect(() => recorder.subscribe(setStatus), []);

  const cams = useMemo(() => devices.filter((d) => d.kind === 'videoinput' && d.deviceId), [devices]);
  const camKey = cams.map((d) => d.deviceId).join(',');

  const loadDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list);
    setMicId((m) => m ?? list.find((d) => d.kind === 'audioinput')?.deviceId ?? null);
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([api.invoke('record:sources'), api.invoke('record:displays')]);
      const screens = s.filter((x) => x.kind === 'screen');
      setSources(screens);
      setDisplays(d);
      setSourceId((cur) => (cur && screens.some((x) => x.id === cur) ? cur : (screens[0]?.id ?? null)));
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

  // first camera on by default; unplugged cameras drop out of the selection
  useEffect(() => {
    const ids = cams.map((d) => d.deviceId);
    if (!camInit.current && ids.length > 0) {
      camInit.current = true;
      setCamIds([ids[0]!]);
      return;
    }
    setCamIds((cur) => keepAvailable(cur, ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camKey]);

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
      for (const d of cams) {
        if (cancelled) break;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: d.deviceId }, width: { ideal: r.w }, height: { ideal: r.h }, frameRate: { ideal: fps } },
            audio: false,
          });
          opened.push({ choice: { deviceId: d.deviceId, label: d.label || d.deviceId.slice(0, 8), width: r.w, height: r.h, fps }, stream });
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
  }, [active, camKey, res, fps]);

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

  // the selected display and the region that applies to it (record.region of another display = whole screen)
  const source = sources.find((s) => s.id === sourceId) ?? null;
  const displayId = source ? source.displayId || displayIdOf(source.id) : null;
  const display = displays.find((d) => d.id === displayId) ?? null;
  const savedRegion = parseRegion((settings.json?.record as { region?: unknown } | undefined)?.region);
  const fitted = savedRegion && display ? fitRegion(savedRegion, display) : null;
  const region = fitted && display && !isWholeDisplay(fitted, display) ? fitted : null;
  const canPickRegion = Boolean(display) && info?.os !== 'linux';

  const pickRegion = async () => {
    if (!display) return;
    setPicking(true);
    try {
      const r = await api.invoke('record:pickRegion', display.id);
      if (r) {
        const err = await setSetting('record.region', r);
        if (err) toast(`${t('rec.regionFailed')}: ${err}`);
      }
    } catch (e) {
      toast(`${t('rec.regionFailed')}: ${errMsg(e)}`);
    } finally {
      setPicking(false);
    }
  };
  const clearRegion = async () => {
    const err = await setSetting('record.region', null);
    if (err) toast(err);
  };

  const mainId = mainCamera(camIds, mainCamId);
  const selectedCams = recordingOrder(camIds, mainCamId)
    .map((id) => camStreams.find((c) => c.choice.deviceId === id))
    .filter((c): c is { choice: CameraChoice; stream: MediaStream } => Boolean(c));

  const start = async () => {
    if (!project || !info) return;
    for (let i = countdownSec; i > 0; i--) {
      setCount(i);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCount(null);
    try {
      setElapsed(0);
      const v = screenStream?.getVideoTracks()[0];
      const vs = v?.getSettings();
      const crop = region && display && vs?.width && vs.height ? streamCrop(region, display, vs.width, vs.height) : null;
      await recorder.start(
        project.dir,
        {
          screen: screenStream,
          screenSourceId: sourceId,
          screenFps: fps,
          screenRegion: region && crop ? { region, crop } : null,
          cameras: selectedCams.map((c, i) => ({ stream: c.stream, choice: i === 0 ? { ...c.choice, role: 'main' as const } : c.choice })),
          mic: micStream && micId ? { deviceId: micId, label: devices.find((d) => d.deviceId === micId)?.label ?? 'mic', stream: micStream } : null,
        },
        systemAudio,
        info.version,
        info.os,
      );
    } catch (e) {
      toast(`${t('rec.error')}: ${errMsg(e)}`);
    }
  };

  const [ingesting, setIngesting] = useState(false);
  // Stop -> `solocut ingest` registers the take as sources (clock offsets, NG/important markers) -> workspace ->
  // the agent is asked to finish the video (autopilot.autoStart)
  const stop = async () => {
    const takeId = recorder.get().takeId ?? null;
    await recorder.stop();
    if (!project) return;
    const dir = project.dir;
    setIngesting(true);
    toast(t('rec.ingesting'));
    const r = await api.invoke('project:cli', dir, ['ingest']);
    setIngesting(false);
    if (!r.ok) {
      toast(`${t('rec.ingestFailed')}: ${r.error ?? ''}`);
      return;
    }
    toast(t('rec.saved'));
    // faces / on-screen PII / cursor logs for zoom, reframing and masks (cancellable from the workspace)
    void api.invoke('analysis:start', dir).catch(() => undefined);
    onIngested();
    await runAutoFinish(dir, takeId, {
      settings: () => settingsStore.get().json,
      render: (d) => api.invoke('prompts:render', 'finish', d, {}),
      send: (text, agent, d) => sendToAgent({ text, agent, projectDir: d }, { launch: agent }),
      toast,
      sent: sentTakes,
      messages: {
        started: (agent) => t('rec.autoStarted', { agent }),
        failed: (error) => t('rec.autoFailed', { error }),
      },
    });
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

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const mmss = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const mod = info?.os === 'mac' ? '⌘⇧' : 'Ctrl+Shift+';

  const ngCount = status.markers.filter((m) => m.kind === 'ng').length;
  const impCount = status.markers.filter((m) => m.kind === 'important').length;
  const canStart = !ingesting && !picking && count === null && Boolean(screenStream || selectedCams.length > 0 || micStream);
  const regionLabel = region ? t('rec.regionSize', { w: String(region.width), h: String(region.height) }) : t('rec.wholeScreen');

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
          <Tooltip label={t('rec.countdown')} align="end">
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
          <div className={`recx__previews${selectedCams.length > 0 ? '' : ' no-cam'}`}>
            <ScreenPreview stream={screenStream} label={region ? `${t('rec.screen')} · ${regionLabel}` : t('rec.screen')} display={display} region={region} />
            <div className="recx__cams">
              {selectedCams.length === 0 ? (
                <Preview stream={null} label={t('rec.cameras')} />
              ) : (
                selectedCams.map((c) => <Preview key={c.choice.deviceId} stream={c.stream} label={c.choice.deviceId === mainId ? `${t('rec.mainCam')} · ${c.choice.label}` : c.choice.label} />)
              )}
            </div>
          </div>
        </div>
        <aside className="recx__side">
          <section className="recx__step">
            <div className="recx__step-head">
              <span className="recx__step-n">1</span>
              <h3 className="recx__h">{t('rec.step.screen')}</h3>
              <IconButton label={t('rec.refresh')} size="sm" icon={<RefreshCw size={12} />} disabled={recording} onClick={() => void loadSources()} />
            </div>
            <div className="recx__source-grid">
              {sources.map((src) => (
                <button key={src.id} type="button" className={`recx__source${sourceId === src.id ? ' is-selected' : ''}`} disabled={recording} onClick={() => setSourceId(src.id)}>
                  <span className="recx__source-img">
                    <img src={src.thumbnail} alt="" />
                    <span className="recx__source-kind">
                      <Monitor size={11} />
                    </span>
                  </span>
                  <span className="recx__source-name" title={src.name}>
                    {src.name}
                  </span>
                </button>
              ))}
              <button type="button" className={`recx__source${sourceId === null ? ' is-selected' : ''}`} disabled={recording} onClick={() => setSourceId(null)}>
                <span className="recx__source-img is-none">
                  <MonitorOff size={18} />
                </span>
                <span className="recx__source-name">{t('rec.noScreen')}</span>
              </button>
            </div>
            {sourceId !== null && canPickRegion && (
              <div className="recx__region-row">
                <Button size="sm" icon={<Crop size={13} />} busy={picking} disabled={recording} onClick={() => void pickRegion()} data-testid="record-pick-region">
                  {region ? t('rec.repickRegion') : t('rec.pickRegion')}
                </Button>
                <Button size="sm" variant="ghost" icon={<Maximize size={13} />} selected={!region} disabled={recording || !region} onClick={() => void clearRegion()}>
                  {t('rec.wholeScreen')}
                </Button>
                {region && <span className="recx__region-size">{region.width} × {region.height}</span>}
              </div>
            )}
          </section>

          <section className="recx__step">
            <div className="recx__step-head">
              <span className="recx__step-n">2</span>
              <h3 className="recx__h">{t('rec.step.camera')}</h3>
            </div>
            {cams.length === 0 && <p className="st-note">{st('rec.noCameras')}</p>}
            <div className="recx__camgrid">
              {cams.map((d) => {
                const on = camIds.includes(d.deviceId);
                const isMain = on && d.deviceId === mainId;
                const live = camStreams.find((c) => c.choice.deviceId === d.deviceId);
                const label = d.label || d.deviceId.slice(0, 8);
                return (
                  <div key={d.deviceId} className={`recx__cam${on ? ' is-on' : ''}${isMain ? ' is-main' : ''}`}>
                    <button
                      type="button"
                      className="recx__cam-toggle"
                      aria-pressed={on}
                      disabled={recording}
                      onClick={() => setCamIds((ids) => toggleCamera(ids, d.deviceId))}
                    >
                      <span className="recx__cam-img">
                        {live ? <Video stream={live.stream} /> : <Camera size={16} aria-hidden="true" />}
                        {on && (
                          <span className="recx__cam-check">
                            <Check size={11} aria-hidden="true" />
                          </span>
                        )}
                      </span>
                      <span className="recx__cam-name" title={label}>
                        {label}
                      </span>
                    </button>
                    {isMain ? (
                      <Badge tone="brand" icon={<User size={11} />} className="recx__cam-main">
                        {t('rec.mainCam')}
                      </Badge>
                    ) : on ? (
                      <button type="button" className="recx__cam-setmain" disabled={recording} onClick={() => setMainCamId(d.deviceId)}>
                        {t('rec.setMainCam')}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="recx__step">
            <div className="recx__step-head">
              <span className="recx__step-n">3</span>
              <h3 className="recx__h">{t('rec.step.mic')}</h3>
            </div>
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
          </section>

          {recording ? (
            <button type="button" className="recx__big-go is-stop" disabled={status.state === 'stopping'} onClick={() => void stop()}>
              <Square size={14} fill="currentColor" /> {status.state === 'stopping' ? st('rec.saving') : t('rec.stop')}
            </button>
          ) : (
            <button type="button" className="recx__big-go" disabled={!canStart} onClick={() => void start()} data-testid="record-start">
              <Circle size={14} fill="currentColor" /> {ingesting ? t('rec.ingesting') : count !== null ? String(count) : t('rec.start')}
            </button>
          )}
          <p className="st-note">{t('rec.hotkeys', { ng: `${mod}N`, imp: `${mod}M` })}</p>

          <details className="recx__details">
            <summary>{t('rec.details')}</summary>
            <SettingRow label={st('rec.resolution')}>
              <Select ariaLabel={st('rec.resolution')} value={res} disabled={recording} options={RESOLUTIONS.map((r) => ({ value: r.id, label: r.id }))} onChange={setRes} />
            </SettingRow>
            <SettingRow label="fps">
              <Select ariaLabel="fps" value={fps} disabled={recording} options={[24, 30, 60].map((f) => ({ value: f, label: `${f} fps` }))} onChange={setFps} />
            </SettingRow>
          </details>
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
