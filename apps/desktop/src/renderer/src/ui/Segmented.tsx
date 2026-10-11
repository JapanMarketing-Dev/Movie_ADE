import type { CSSProperties, ReactNode } from 'react';

/**
 * Segmented control (ported from Ferret src/renderer/ui/Segmented.tsx).
 *
 * The selection is one "thumb" that slides with transform, so you can see which way it moved.
 * `value` may be null (nothing selected, e.g. a page outside the four modes): the thumb fades out.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  title?: string;
  disabled?: boolean;
  /** small mark after the label (e.g. "not derived yet") */
  suffix?: ReactNode;
  testId?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  size = 'md',
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const index = value === null ? -1 : options.findIndex((o) => o.value === value);
  return (
    <div
      className={['segmented', size === 'sm' ? 'segmented--sm' : '', className ?? ''].filter(Boolean).join(' ')}
      role="group"
      aria-label={ariaLabel}
      style={{ '--segmented-count': options.length } as CSSProperties}
    >
      <span
        className="segmented__thumb"
        style={{ transform: `translateX(${Math.max(0, index) * 100}%)`, opacity: index < 0 ? 0 : 1 }}
        aria-hidden="true"
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented__item"
          aria-pressed={o.value === value}
          title={o.title}
          disabled={o.disabled}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
          {o.suffix}
        </button>
      ))}
    </div>
  );
}
