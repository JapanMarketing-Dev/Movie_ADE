import type { ReactNode } from 'react';

/**
 * List row and card (ported from Ferret src/renderer/ui/Row.tsx; renamed to .list-row / .ui-card because the older
 * screens use `.row` and `.card`). The selected row grows a thin line on its left edge instead of a filled surface.
 */
export function ListRow({
  leading,
  title,
  meta,
  description,
  trailing,
  selected = false,
  onClick,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = onClick != null;
  return (
    <div
      className={['list-row', selected ? 'is-selected' : '', interactive ? 'is-interactive' : '', className ?? ''].filter(Boolean).join(' ')}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-current={selected || undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {leading != null && <div className="list-row__leading">{leading}</div>}
      <div className="list-row__body">
        <div className="list-row__head">
          <span className="list-row__title">{title}</span>
          {meta != null && <span className="list-row__meta">{meta}</span>}
        </div>
        {description != null && <p className="list-row__description">{description}</p>}
      </div>
      {trailing != null && <div className="list-row__trailing">{trailing}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={['ui-card', className ?? ''].filter(Boolean).join(' ')}>
      {(title != null || actions != null) && (
        <header className="ui-card__head">
          {title != null && <h3 className="ui-card__title">{title}</h3>}
          {actions != null && <div className="ui-card__actions">{actions}</div>}
        </header>
      )}
      <div className="ui-card__body">{children}</div>
    </section>
  );
}
