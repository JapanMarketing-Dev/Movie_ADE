// Pure helpers for the workspace: which video the player shows, keeping the raw take's followers on the main clock,
// the one prompt button. Unit-tested.

/** Re-seek a follower only when it is further off than this (seconds); small drift is not worth a stall. */
export const SYNC_TOLERANCE = 0.15;

export type FollowerAction =
  /** outside the follower's file: pause it (and hide a picture) */
  | { kind: 'out' }
  | { kind: 'sync'; time: number; seek: boolean; play: boolean };

/**
 * What a follower must do for the main video at `mainTime`. `start` = where the follower's t=0 sits relative to the
 * main video (seconds); `duration` is the follower's length when known.
 */
export function followerAction(
  mainTime: number,
  main: { paused: boolean; seeking?: boolean },
  f: { start: number; currentTime: number; duration?: number },
  tolerance = SYNC_TOLERANCE,
): FollowerAction {
  const time = mainTime - f.start;
  if (!Number.isFinite(time) || time < 0) return { kind: 'out' };
  if (f.duration !== undefined && Number.isFinite(f.duration) && f.duration > 0 && time >= f.duration) return { kind: 'out' };
  const seek = !!main.seeking || Math.abs(f.currentTime - time) > tolerance;
  return { kind: 'sync', time, seek, play: !main.paused };
}

/** Which video the workspace player shows: the rendered preview when there is one, else the raw take. */
export function playerSource<P, R>(snap: { preview?: P; raw?: R } | null | undefined): 'edited' | 'raw' | 'none' {
  if (snap?.preview) return 'edited';
  if (snap?.raw) return 'raw';
  return 'none';
}

/** The prompt bar's one button: the `finish` prompt (its label from prompts.json when present), autopilot style. */
export function finishPrompt<P extends { id: string; label: string; agent?: string; autopilot?: boolean }>(
  prompts: readonly P[],
  fallbackLabel: string,
): { id: 'finish'; label: string; agent?: string; autopilot: true } {
  const p = prompts.find((x) => x.id === 'finish');
  const label = p?.label?.trim() || fallbackLabel;
  return { id: 'finish', label, ...(p?.agent ? { agent: p.agent } : {}), autopilot: true };
}
