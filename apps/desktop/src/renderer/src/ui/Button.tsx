import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Progress';

/**
 * Button (ported from Ferret src/renderer/ui/Button.tsx).
 *
 * `variant` says how strongly it invites a click. One primary per screen.
 *   primary … the main action; the only filled button
 *   default … normal
 *   ghost   … quiet; toolbars
 *   danger  … cannot be undone
 *   record  … recording (its own red)
 */
export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'record';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  /** icon left of the label (lucide, 14px) */
  icon?: ReactNode;
  /** busy: shows a spinner and disables the button */
  busy?: boolean;
  /** toggle state; also sets aria-pressed */
  selected?: boolean;
  size?: 'sm' | 'md';
  'data-testid'?: string;
  children?: ReactNode;
}

export function Button({ variant = 'default', icon, busy = false, selected, size = 'md', className, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', busy ? 'is-busy' : '', className ?? ''].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-pressed={selected}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
      {children != null && <span className="btn__label">{children}</span>}
    </button>
  );
}

/** Icon-only button. `label` is required for screen readers and the native title. */
export function IconButton({
  variant = 'ghost',
  label,
  icon,
  busy = false,
  selected,
  size = 'md',
  className,
  disabled,
  ...rest
}: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: ReactNode }) {
  return (
    <button
      type="button"
      className={['btn', 'btn--icon', `btn--${variant}`, size === 'sm' ? 'btn--icon-sm' : '', busy ? 'is-busy' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || busy}
      aria-label={label}
      aria-pressed={selected}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
    </button>
  );
}
