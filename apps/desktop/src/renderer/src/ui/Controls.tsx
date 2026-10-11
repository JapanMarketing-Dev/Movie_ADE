import type { ReactNode } from 'react';

// Settings-style rows (ported from Ferret's SettingsPage Switch / SelectRow and the st-* controls of review.css).

export function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="st-row st-row--switch" data-disabled={disabled || undefined}>
      <span className="st-row__label">
        {label}
        {hint}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="st-switch"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** A labelled row whose control (select, segmented, button) sits on the right. */
export function SettingRow({ label, children, stack = false }: { label: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`st-row${stack ? ' st-row--stack' : ''}`}>
      <span className="st-row__label">{label}</span>
      {children}
    </div>
  );
}

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** Native select in the st-select look, with the chevron of .rv-select. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  wide = false,
}: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  wide?: boolean;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <span className="rv-select">
      <select
        className={`st-select${wide ? ' st-select--wide' : ''}`}
        aria-label={ariaLabel}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const hit = options.find((o) => String(o.value) === e.target.value);
          if (hit) onChange(hit.value);
        }}
      >
        {!known && <option value={String(value)}>{String(value)}</option>}
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function Note({ tone, children }: { tone?: 'ok' | 'warn'; children: ReactNode }) {
  return <p className={`st-note${tone ? ` st-note--${tone}` : ''}`}>{children}</p>;
}
