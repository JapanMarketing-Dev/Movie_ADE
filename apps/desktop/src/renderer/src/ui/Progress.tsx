// Progress indicators (ported from Ferret src/renderer/ui/Progress.tsx). Everything animates with transform / opacity only.

/** Small spinner for buttons and row ends. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Determinate (value 0..1) or indeterminate (no value) progress line. */
export function Progress({ value, label }: { value?: number; label?: string }) {
  const determinate = typeof value === 'number';
  return (
    <div
      className={`ui-progress${determinate ? '' : ' ui-progress--indeterminate'}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
    >
      <span className="ui-progress__bar" style={determinate ? { transform: `scaleX(${Math.min(1, Math.max(0, value))})` } : undefined} />
    </div>
  );
}

/** Placeholder bar while a list loads. */
export function Skeleton({ width, height = 12 }: { width?: number | string; height?: number }) {
  return <span className="skeleton" style={{ width: width ?? '100%', height }} aria-hidden="true" />;
}

/** The recording dot. Breathes slowly so it is noticed even in a screen share. */
export function RecordDot({ active = false, size = 8 }: { active?: boolean; size?: number }) {
  return <span className={`record-dot${active ? ' record-dot--active' : ''}`} style={{ width: size, height: size }} aria-hidden="true" />;
}
