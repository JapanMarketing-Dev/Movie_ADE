import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Clapperboard, FolderOpen, Plus } from 'lucide-react';
import type { ProjectInfo, RecentProject } from '@shared/types';
import { Tooltip } from '../ui';
import { useST } from './i18n';
import { shortcutLabel } from './shortcut';

/**
 * Project switcher in the title bar (ported from Ferret src/renderer/components/ProjectMenu.tsx).
 * Lists recent projects (`project:recent`); the full list with search lives in the sidebar.
 */
export function ProjectMenu({
  project,
  recent,
  onOpen,
  onOpenFolder,
  onNew,
  onMenuOpen,
}: {
  project: ProjectInfo | null;
  recent: RecentProject[];
  onOpen: (dir: string) => void;
  onOpenFolder: () => void;
  onNew: () => void;
  /** refresh the recent list when the menu opens */
  onMenuOpen?: () => void;
}) {
  const t = useST();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open) onMenuOpen?.();
    setOpen(!open);
  };
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div className="project-menu" ref={rootRef}>
      <Tooltip label={t('projectMenu.switch')}>
        <button
          type="button"
          className="app-titlebar__project"
          title={project?.dir}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          data-testid="project-button"
        >
          <Clapperboard className="app-titlebar__project-icon" size={13} />
          <span className={`app-titlebar__project-name${project ? '' : ' is-empty'}`}>{project?.title ?? t('projectMenu.none')}</span>
          {project?.template && <span className="app-titlebar__template">{project.template.id}</span>}
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </Tooltip>

      {open && (
        <div className="project-menu__panel" role="menu" aria-label={t('projectMenu.label')} data-testid="project-menu">
          {recent.length > 0 ? (
            <ul className="project-menu__list">
              {recent.map((r) => {
                const active = r.dir === project?.dir;
                return (
                  <li key={r.dir} className={`project-menu__item${active ? ' is-active' : ''}${r.exists ? '' : ' is-missing'}`}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className="project-menu__row"
                      title={r.dir}
                      disabled={!r.exists}
                      onClick={() => pick(() => (active ? undefined : onOpen(r.dir)))}
                    >
                      <span className="project-menu__check" aria-hidden="true">
                        {active && <Check size={13} strokeWidth={2} />}
                      </span>
                      <span className="project-menu__text">
                        <span className="project-menu__name">{r.title}</span>
                        <span className="project-menu__path">{r.exists ? r.dir : `${t('projectMenu.missing')} · ${r.dir}`}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="project-menu__empty">{t('projectMenu.empty')}</p>
          )}
          <button type="button" role="menuitem" className="project-menu__add" onClick={() => pick(onNew)}>
            <Plus size={14} />
            <span>{t('projectMenu.new')}</span>
            <kbd className="project-menu__kbd">{shortcutLabel('newProject')}</kbd>
          </button>
          <button type="button" role="menuitem" className="project-menu__add project-menu__add--plain" onClick={() => pick(onOpenFolder)}>
            <FolderOpen size={14} />
            <span>{t('projectMenu.openFolder')}</span>
            <kbd className="project-menu__kbd">{shortcutLabel('openProject')}</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
