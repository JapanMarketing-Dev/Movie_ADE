import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

/**
 * Text input with an optional leading icon and trailing text (ported from Ferret src/renderer/ui/Field.tsx; renamed
 * because the older screens use `.field` for label + input columns).
 */
export function TextField({
  icon,
  trailing,
  invalid = false,
  className,
  inputClassName,
  mono = false,
  ref,
  'data-testid': testId,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  mono?: boolean;
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
  'data-testid'?: string;
}) {
  return (
    <div className={['text-field', invalid ? 'is-invalid' : '', className ?? ''].filter(Boolean).join(' ')} data-disabled={rest.disabled || undefined}>
      {icon != null && <span className="text-field__icon">{icon}</span>}
      <input
        ref={ref}
        className={['text-field__input', mono ? 'text-field__input--mono' : '', inputClassName ?? ''].filter(Boolean).join(' ')}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        {...rest}
      />
      {trailing != null && <span className="text-field__trailing">{trailing}</span>}
    </div>
  );
}
