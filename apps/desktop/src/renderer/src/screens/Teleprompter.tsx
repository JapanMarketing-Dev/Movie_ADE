import { useEffect, useRef, useState } from 'react';
import { Minus, Pause, Play, Plus } from 'lucide-react';
import { api } from '../lib/api';

/** Separate always-on-top window that scrolls script.md (docs/03). */
export function Teleprompter({ dir }: { dir: string }) {
  const [text, setText] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(30); // px per second
  const [size, setSize] = useState(30);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.invoke('project:readScript', dir).then((s) => setText(s ?? 'script.md がありません / No script.md in this project.'));
  }, [dir]);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let raf = 0;
    let acc = 0;
    const loop = (now: number) => {
      acc += ((now - last) / 1000) * speed;
      last = now;
      if (ref.current && acc >= 1) {
        ref.current.scrollTop += Math.floor(acc);
        acc -= Math.floor(acc);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') setRunning((r) => !r);
      if (e.key === 'ArrowUp') setSpeed((s) => Math.min(300, s + 10));
      if (e.key === 'ArrowDown') setSpeed((s) => Math.max(0, s - 10));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className="teleprompter" ref={ref} style={{ fontSize: size }}>
        {text}
      </div>
      <div className="teleprompter-bar">
        <button className="btn small icon" onClick={() => setRunning((r) => !r)}>
          {running ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button className="btn small" onClick={() => setSpeed((s) => Math.max(0, s - 10))}>
          <Minus size={12} /> {speed}
        </button>
        <button className="btn small icon" onClick={() => setSpeed((s) => s + 10)}>
          <Plus size={12} />
        </button>
        <button className="btn small" onClick={() => setSize((s) => Math.max(14, s - 4))}>
          A-
        </button>
        <button className="btn small" onClick={() => setSize((s) => Math.min(80, s + 4))}>
          A+
        </button>
      </div>
    </>
  );
}
