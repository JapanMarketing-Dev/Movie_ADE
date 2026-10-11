import { useEffect, useRef, useState } from 'react';
import type { RawTake } from '@shared/types';
import { followerAction } from './workspaceModel';

/**
 * A take as recorded: the main video (screen, or the camera) with native controls, the camera as picture-in-picture
 * and the mic, both following the main video's clock (play / pause / seek / rate / volume).
 */
export function RawPlayer({ raw }: { raw: RawTake }) {
  const mainRef = useRef<HTMLVideoElement>(null);
  const pipRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [pipOut, setPipOut] = useState(false);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const followers: { el: HTMLMediaElement; start: number; onOut?: (out: boolean) => void }[] = [];
    if (pipRef.current && raw.pip) followers.push({ el: pipRef.current, start: raw.pip.start, onOut: setPipOut });
    if (audioRef.current && raw.audio) followers.push({ el: audioRef.current, start: raw.audio.start });
    const sync = () => {
      for (const f of followers) {
        const a = followerAction(main.currentTime, main, { start: f.start, currentTime: f.el.currentTime, duration: f.el.duration });
        f.onOut?.(a.kind === 'out');
        if (a.kind === 'out') {
          if (!f.el.paused) f.el.pause();
          continue;
        }
        if (f.el.playbackRate !== main.playbackRate) f.el.playbackRate = main.playbackRate;
        if (a.seek) f.el.currentTime = a.time;
        if (a.play && f.el.paused) void f.el.play().catch(() => undefined);
        else if (!a.play && !f.el.paused) f.el.pause();
      }
    };
    const volume = () => {
      if (!audioRef.current) return;
      audioRef.current.volume = main.volume;
      audioRef.current.muted = main.muted;
    };
    const events = ['play', 'pause', 'seeking', 'seeked', 'timeupdate', 'ratechange', 'waiting', 'playing', 'ended'] as const;
    for (const e of events) main.addEventListener(e, sync);
    main.addEventListener('volumechange', volume);
    volume();
    sync();
    return () => {
      for (const e of events) main.removeEventListener(e, sync);
      main.removeEventListener('volumechange', volume);
    };
  }, [raw]);

  return (
    <>
      <video ref={mainRef} key={raw.main.url} src={raw.main.url} controls preload="metadata" data-testid="raw-main" />
      {raw.pip && (
        <video
          ref={pipRef}
          key={raw.pip.url}
          className={`raw-pip${pipOut ? ' is-out' : ''}`}
          src={raw.pip.url}
          muted
          playsInline
          preload="metadata"
          data-testid="raw-pip"
        />
      )}
      {raw.audio && <audio ref={audioRef} key={raw.audio.url} src={raw.audio.url} preload="auto" />}
    </>
  );
}
