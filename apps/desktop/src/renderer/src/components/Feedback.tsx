// Video feedback (docs/04): talk while playing the preview and mark the frame with a pen, a box or text.
// Mic goes to feedback/inbox/<id>/mic.wav (PCM), pen/play/seek events to session.json; then
// `solocut feedback import` splits them into items that the user checks before sending them to the agent.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, PenLine, Send, Square, Trash2, Type, X, Save } from 'lucide-react';
import type { FeedbackImport, FeedbackItem, FeedbackSession, Variant } from '@shared/types';
import { boxFrom, boxPoints, contentRect, feedbackAgentMessage, frameAt, normalizePoint, simplifyStroke } from '@shared/feedback';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import { SAMPLE_RATE, startPcmCapture, type PcmCapture } from '../lib/pcm-capture';
import { terminals } from '../lib/terminals';

type Tool = 'pen' | 'box' | 'text';
type Shape =
  | { kind: 'stroke'; points: [number, number][] }
  | { kind: 'box'; x: number; y: number; w: number; h: number }
  | { kind: 'text'; x: number; y: number; text: string };

interface Props {
  dir: string;
  variant: Variant;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  previewPath: string;
  fpsNum: number;
  fpsDen: number;
  lang: 'ja' | 'en';
  toast: (m: string) => void;
  active: boolean;
  onActiveChange: (on: boolean) => void;
}

export function FeedbackLayer({ dir, variant, videoRef, previewPath, fpsNum, fpsDen, lang, toast, active, onActiveChange }: Props) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [textAt, setTextAt] = useState<{ px: number; py: number; nx: number; ny: number } | null>(null);
  const [result, setResult] = useState<FeedbackImport | null>(null);
  const shapes = useRef<Shape[]>([]);
  const drawing = useRef<{ start: [number, number]; points: [number, number][]; atMs: number } | null>(null);
  const session = useRef<{
    id: string;
    startMs: number;
    data: Pick<FeedbackSession, 'playback' | 'strokes' | 'notes'>;
    cap: PcmCapture | null;
    ctx: AudioContext | null;
    stream: MediaStream | null;
    queue: Promise<unknown>;
  } | null>(null);

  const now = () => (session.current ? performance.now() - session.current.startMs : 0);
  const frameNow = () => frameAt(videoRef.current?.currentTime ?? 0, fpsNum, fpsDen);
  const playback = useCallback(
    (state?: 'playing' | 'paused') => {
      const s = session.current;
      const v = videoRef.current;
      if (!s || !v) return;
      s.data.playback.push({ atMs: Math.round(now()), state: state ?? (v.paused ? 'paused' : 'playing'), frame: frameNow() });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fpsNum, fpsDen],
  );

  const rect = () => {
    const c = canvas.current;
    const v = videoRef.current;
    if (!c || !v) return { x: 0, y: 0, w: 1, h: 1 };
    return contentRect(c.clientWidth, c.clientHeight, v.videoWidth, v.videoHeight);
  };

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== c.clientWidth * dpr || c.height !== c.clientHeight * dpr) {
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, c.clientWidth, c.clientHeight);
    const r = rect();
    const X = (x: number) => r.x + x * r.w;
    const Y = (y: number) => r.y + y * r.h;
    g.strokeStyle = '#ff4a3d';
    g.fillStyle = '#ff4a3d';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.font = '600 22px -apple-system, "Hiragino Sans", sans-serif';
    const all = [...shapes.current];
    const d = drawing.current;
    if (d && tool === 'pen') all.push({ kind: 'stroke', points: d.points });
    if (d && tool === 'box' && d.points.length > 0) all.push({ kind: 'box', ...boxFrom(d.start, d.points[d.points.length - 1]!) });
    for (const s of all) {
      if (s.kind === 'stroke') {
        g.beginPath();
        s.points.forEach(([x, y], i) => (i === 0 ? g.moveTo(X(x), Y(y)) : g.lineTo(X(x), Y(y))));
        g.stroke();
      } else if (s.kind === 'box') {
        g.strokeRect(X(s.x), Y(s.y), s.w * r.w, s.h * r.h);
      } else {
        g.lineWidth = 5;
        g.strokeStyle = 'rgba(0,0,0,0.8)';
        g.strokeText(s.text, X(s.x), Y(s.y));
        g.fillText(s.text, X(s.x), Y(s.y));
        g.lineWidth = 4;
        g.strokeStyle = '#ff4a3d';
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // play / pause / seek events; drawings belong to the frame they were made on
  useEffect(() => {
    const v = videoRef.current;
    if (!active || !v) return;
    const clear = () => {
      shapes.current = [];
      redraw();
    };
    const onPlay = () => (playback('playing'), clear());
    const onPause = () => playback('paused');
    const onSeeked = () => (playback(), clear());
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    const ro = new ResizeObserver(redraw);
    if (canvas.current) ro.observe(canvas.current);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      ro.disconnect();
    };
  }, [active, videoRef, playback, redraw]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setElapsed(now()), 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const start = async () => {
    try {
      const { id } = await api.invoke('feedback:begin', dir);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await api.invoke('record:openTrack', { takeId: id, file: 'mic.wav', kind: 'mic', wav: { sampleRate: ctx.sampleRate, channels: 1 } });
      const s = {
        id,
        startMs: performance.now(),
        data: { playback: [], strokes: [], notes: [] } as Pick<FeedbackSession, 'playback' | 'strokes' | 'notes'>,
        cap: null as PcmCapture | null,
        ctx,
        stream,
        queue: Promise.resolve() as Promise<unknown>,
      };
      session.current = s;
      playback('paused');
      s.cap = await startPcmCapture(ctx, stream.getAudioTracks()[0]!, (pcm) => {
        s.queue = s.queue.then(() => api.invoke('record:append', id, 'mic.wav', pcm)).catch((e: unknown) => toast(errMsg(e)));
      }, { maxChannels: 1 });
      shapes.current = [];
      onActiveChange(true);
      videoRef.current?.pause();
    } catch (e) {
      toast(`${t('fb.error')}: ${errMsg(e)}`);
      session.current = null;
    }
  };

  const stop = async () => {
    const s = session.current;
    if (!s) return;
    setBusy(true);
    onActiveChange(false);
    s.cap?.stop();
    await s.queue;
    s.stream?.getTracks().forEach((tr) => tr.stop());
    await s.ctx?.close().catch(() => undefined);
    const first = s.cap?.firstSampleMs();
    const body: FeedbackSession = {
      schema: 1,
      createdAt: new Date().toISOString(),
      audio: 'mic.wav',
      // where the first mic sample sits on the session clock (ms since we started)
      audioStartMs: first !== undefined ? Math.max(0, Math.round(first - s.startMs)) : 0,
      ...s.data,
      ...(variant !== 'main' ? { variant } : {}),
    };
    session.current = null;
    shapes.current = [];
    redraw();
    try {
      const r = await api.invoke('feedback:finish', dir, s.id, body, variant);
      if (!r.ok || !r.data) toast(`${t('fb.importFailed')}: ${r.error ?? ''} (feedback/inbox/${s.id})`);
      else setResult(r.data);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const pos = (e: React.PointerEvent) => {
    const b = canvas.current!.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    return { px, py, n: normalizePoint(px, py, rect()) };
  };

  const down = (e: React.PointerEvent) => {
    if (!active) return;
    videoRef.current?.pause();
    const p = pos(e);
    if (tool === 'text') {
      setTextAt({ px: p.px, py: p.py, nx: p.n[0], ny: p.n[1] });
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    drawing.current = { start: p.n, points: [p.n], atMs: now() };
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current.points.push(pos(e).n);
    redraw();
  };
  const up = () => {
    const d = drawing.current;
    drawing.current = null;
    if (!d) return;
    const s = session.current;
    const stroke = (points: [number, number][]) =>
      s?.data.strokes.push({ startMs: Math.round(d.atMs), endMs: Math.round(now()), frame: frameNow(), color: '#FF4A3D', width: 0.005, points });
    if (tool === 'pen' && d.points.length > 1) {
      const points = simplifyStroke(d.points);
      shapes.current.push({ kind: 'stroke', points });
      stroke(points);
    } else if (tool === 'box') {
      const b = boxFrom(d.start, d.points[d.points.length - 1]!);
      if (b.w > 0.005 && b.h > 0.005) {
        shapes.current.push({ kind: 'box', ...b });
        stroke(boxPoints(b)); // the CLI knows strokes only: a box is a closed outline
      }
    }
    redraw();
  };
  const commitText = (text: string) => {
    if (textAt && text.trim()) {
      shapes.current.push({ kind: 'text', x: textAt.nx, y: textAt.ny, text: text.trim() });
      session.current?.data.notes.push({ atMs: Math.round(now()), text: text.trim(), frame: frameNow() });
      redraw();
    }
    setTextAt(null);
  };

  const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

  return (
    <>
      {active && (
        <canvas
          ref={canvas}
          className={`fb-canvas tool-${tool}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      )}
      {active && textAt && (
        <input
          className="input fb-text"
          autoFocus
          style={{ left: textAt.px, top: textAt.py - 16 }}
          placeholder={t('fb.textPlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText(e.currentTarget.value);
            if (e.key === 'Escape') setTextAt(null);
          }}
          onBlur={(e) => commitText(e.currentTarget.value)}
        />
      )}
      <div className="fb-bar">
        {!active ? (
          <button className="btn small" disabled={busy} onClick={() => void start()} title={t('fb.hint')}>
            <Mic size={13} /> {busy ? t('fb.processing') : t('fb.start')}
          </button>
        ) : (
          <>
            <span className="pill accent">● {mmss(elapsed)}</span>
            <div className="segmented">
              <button className={tool === 'pen' ? 'on' : ''} onClick={() => setTool('pen')} title={t('fb.pen')}>
                <PenLine size={13} />
              </button>
              <button className={tool === 'box' ? 'on' : ''} onClick={() => setTool('box')} title={t('fb.box')}>
                <Square size={13} />
              </button>
              <button className={tool === 'text' ? 'on' : ''} onClick={() => setTool('text')} title={t('fb.text')}>
                <Type size={13} />
              </button>
            </div>
            <button className="btn small primary" onClick={() => void stop()}>
              <Square size={12} fill="currentColor" /> {t('fb.stop')}
            </button>
          </>
        )}
      </div>
      {result && <FeedbackReview dir={dir} variant={variant} data={result} lang={lang} toast={toast} onClose={() => setResult(null)} />}
    </>
  );
}

export function FeedbackReview({ dir, variant, data, lang, toast, onClose }: { dir: string; variant: Variant; data: FeedbackImport; lang: 'ja' | 'en'; toast: (m: string) => void; onClose: () => void }) {
  const t = useT();
  const [items, setItems] = useState<FeedbackItem[]>(data.items);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    setSaving(true);
    try {
      const r = await api.invoke('feedback:update', dir, data.id, items, variant);
      if (!r.ok) {
        toast(`${t('fb.saveFailed')}: ${r.error ?? ''}`);
        return false;
      }
      if (r.data) setItems(r.data.items);
      setDirty(false);
      return true;
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    const tab = terminals.targetFor();
    if (!tab) return toast(t('prompts.noTerminal'));
    if (!(await save())) return;
    terminals.paste(tab, feedbackAgentMessage(data.dir, lang));
    toast(`${t('prompts.sent')} → ${tab.title}`);
    onClose();
  };

  const edit = (i: number, request: string) => {
    setItems((xs) => xs.map((x, k) => (k === i ? { ...x, request } : x)));
    setDirty(true);
  };
  const remove = (i: number) => {
    setItems((xs) => xs.filter((_, k) => k !== i)); // numbers are reassigned when saved
    setDirty(true);
  };
  const imgUrl = (p: string) => api.mediaUrl(/^([A-Za-z]:)?[\\/]/.test(p) ? p : `${dir}/${p}`);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <strong>
            {t('fb.items')} <span className="pill">{items.length}</span> <span className="dim mono">{data.dir}</span>
          </strong>
          <button className="btn ghost small icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={15} />
          </button>
        </div>
        <div className="fb-items">
          {items.length === 0 && <div className="empty">{t('fb.noItems')}</div>}
          {items.map((it, i) => (
            <div key={`${it.n}-${it.frame}`} className="fb-item">
              <div className="fb-img">{it.image ? <img src={imgUrl(it.image)} alt="" /> : null}</div>
              <div className="fb-body">
                <div className="row">
                  <span className="pill mono">
                    {i + 1}. {it.timecode || it.frame}
                  </span>
                  {it.title && <strong style={{ fontSize: 12.5 }}>{it.title}</strong>}
                  {it.targets.map((tg) => (
                    <span key={tg.id} className="pill" title={tg.label}>
                      {tg.kind} {tg.id}
                    </span>
                  ))}
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost small icon" title={t('fb.delete')} onClick={() => remove(i)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <textarea className="input" rows={2} value={it.request} onChange={(e) => edit(i, e.target.value)} />
                {it.spoken && <div className="dim" style={{ fontSize: 12 }}>「{it.spoken}」</div>}
                {it.notes.map((n) => (
                  <div key={n} className="dim" style={{ fontSize: 12 }}>
                    ✎ {n}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} /> {t('set.save')}
          </button>
          <button className="btn primary" disabled={items.length === 0 || saving} onClick={() => void send()}>
            <Send size={13} /> {t('fb.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
