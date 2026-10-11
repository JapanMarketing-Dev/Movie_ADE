import { Square } from 'lucide-react';

/**
 * The record button, the most prominent action in the title bar (ported from Ferret src/renderer/ui/RecordButton.tsx).
 * Before recording it is filled red with a white dot; while recording the fill becomes an outline with a red stop
 * square, so the two states never look alike even though both are red.
 */
export function RecordButton({
  recording,
  compact = false,
  disabled = false,
  label,
  title,
  onClick,
}: {
  recording: boolean;
  compact?: boolean;
  disabled?: boolean;
  /** e.g. "録画" / "停止 00:12" */
  label: string;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={['record-btn', recording ? 'is-recording' : '', compact ? 'record-btn--compact' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={recording}
      title={title}
      data-testid="record-button"
    >
      <span className="record-btn__mark" aria-hidden="true">
        {recording ? <Square size={9} strokeWidth={0} fill="currentColor" /> : null}
      </span>
      <span className="record-btn__label">{label}</span>
    </button>
  );
}
