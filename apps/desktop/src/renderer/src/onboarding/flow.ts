// First-run flow (ported in spirit from Ferret src/renderer/onboarding/onboardingFlowState.ts, adapted to Solocut):
// language → agents (detected) → tools (ffmpeg / whisper / fonts via `solocut lib install`) → permissions → first project.
// Pure state functions only (unit-tested); the screens live in OnboardingFlow.tsx.

export const ONBOARDING_STEPS = ['language', 'agents', 'tools', 'permissions', 'project'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  step: OnboardingStep;
  /** steps the user has been through (for the step dots) */
  visited: OnboardingStep[];
}

export function initialOnboarding(): OnboardingState {
  return { step: 'language', visited: ['language'] };
}

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

export function isLastStep(step: OnboardingStep): boolean {
  return stepIndex(step) === ONBOARDING_STEPS.length - 1;
}

export function nextStep(s: OnboardingState): OnboardingState {
  const i = stepIndex(s.step);
  const step = ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)]!;
  return { step, visited: s.visited.includes(step) ? s.visited : [...s.visited, step] };
}

export function prevStep(s: OnboardingState): OnboardingState {
  const i = stepIndex(s.step);
  return { ...s, step: ONBOARDING_STEPS[Math.max(i - 1, 0)]! };
}

/** Jump only to a step already visited (the dots are not a shortcut past unfinished steps). */
export function goToStep(s: OnboardingState, step: OnboardingStep): OnboardingState {
  return s.visited.includes(step) ? { ...s, step } : s;
}

// ---- "done" flag ----
// The source of truth is settings.json `onboarding.completedAt` (set when the flow is finished or skipped).
// The old localStorage flag of the first shell port is still honoured so nobody sees the flow twice.
export const ONBOARDING_KEY = 'solocut.onboarding.v1';

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function legacyFlag(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(ONBOARDING_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Should the flow open at start? Not when settings.json says it was completed, not when the legacy flag says done /
 * skipped, and not when the user already has projects.
 */
export function shouldShowOnboarding(o: { completedAt: unknown; storage: StorageLike | null; recentCount: number }): boolean {
  if (typeof o.completedAt === 'string' && o.completedAt) return false;
  const flag = legacyFlag(o.storage);
  if (flag === 'done' || flag === 'skipped') return false;
  return o.recentCount === 0;
}

/** Remember locally too (settings.json is written by the caller through settings:set). */
export function markOnboarding(storage: StorageLike | null, how: 'done' | 'skipped'): void {
  try {
    storage?.setItem(ONBOARDING_KEY, how);
  } catch {
    // storage unavailable: settings.json still has completedAt
  }
}

/** Agents worth suggesting when none is installed, in the order of docs/11 `agents.order`. */
export const SUGGESTED_AGENTS = ['claude', 'codex', 'gemini'] as const;
