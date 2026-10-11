import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Clapperboard,
  Film,
  FolderOpen,
  Home,
  ListChecks,
  MessageSquareText,
  Package,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ProjectInfo, ProjectSnapshot, RecentProject } from '@shared/types';
import { api } from '../lib/api';
import { IconButton, TextField, Tooltip } from '../ui';
import { dayBucket, initialOf } from './format';
import { useST, type SKey } from './i18n';
import { sidebarActive, sidebarPages, type Screen } from './modes';
import { matchesAll } from './search';
import { shortcutLabel } from './shortcut';
import { parseFeedbackList, parseTakes, type FeedbackEntry, type TakeEntry } from './projectItems';

/**
 * Left sidebar (ported from Ferret src/renderer/components/Sidebar.tsx; Orca由来の寸法: 見出し 32px・行 28px・
 * 子の行は 18px 字下げ、MIT、Ferret 経由).
 *
 *   pages     … ホーム / 撮影 / 編集 / 確認 / 投稿 / ライブラリ / 設定
 *   projects  … recent videos with search; the open one expands into its finished video, takes and feedback sessions.
 * Sections collapse; the state is kept per section in localStorage.
 */
type SectionKey = 'takes' | 'renders' | 'feedback';

const COLLAPSE_KEY = 'solocut.sidebar.collapsed';

const PAGE_ICON: Partial<Record<Screen, LucideIcon>> = {
  home: Home,
  record: Video,
  workspace: Clapperboard,
  review: ListChecks,
  publish: Send,
  library: Package,
  settings: Settings,
};

function loadCollapsed(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function Sidebar({
  screen,
  project,
  recent,
  snapshot,
  onNavigate,
  onOpenProject,
  onNewProject,
  onOpenFolder,
  onRefreshRecent,
}: {
  screen: Screen;
  project: ProjectInfo | null;
  recent: RecentProject[];
  /** snapshot of the open project (its finished video) */
  snapshot: ProjectSnapshot | null;
  onNavigate: (s: Screen) => void;
  onOpenProject: (dir: string) => void;
  onNewProject: () => void;
  onOpenFolder: () => void;
  onRefreshRecent: () => void;
}) {
  const t = useST();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const searchRef = useRef<HTMLInputElement>(null);

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: keep in memory
      }
      return next;
    });

  // the open project first, then the others in recent order
  const projects = useMemo(() => {
    const list = recent.filter((r) => matchesAll(query, r.title, r.dir));
    if (project && !list.some((r) => r.dir === project.dir) && matchesAll(query, project.title, project.dir)) {
      list.unshift({ dir: project.dir, title: project.title, openedAt: new Date().toISOString(), exists: true });
    }
    return list;
  }, [recent, project, query]);

  const groups = useMemo(() => {
    const today: RecentProject[] = [];
    const older: RecentProject[] = [];
    for (const r of projects) (dayBucket(r.openedAt) === 'today' || r.dir === project?.dir ? today : older).push(r);
    return { today, older };
  }, [projects, project?.dir]);

  const pages = sidebarPages(!!project);

  return (
    <aside className="sidebar" data-testid="sidebar" aria-label={t('sidebar.label')}>
      <div className="sidebar__list">
        <nav className="sb-pages" aria-label={t('sidebar.pages')}>
          {pages.map(({ screen: id, key, disabled }) => {
            const Icon = PAGE_ICON[id] ?? Home;
            const active = sidebarActive(id, screen);
            return (
              <button key={id} type="button" className={`sb-page${active ? ' is-active' : ''}`} aria-current={active || undefined} disabled={disabled} onClick={() => onNavigate(id)} data-testid={`sb-page-${id}`}>
                <Icon size={14} />
                <span>{t(key)}</span>
              </button>
            );
          })}
        </nav>

        <div className="sb-head">
          <span className="sb-head__title">{t('sidebar.projects')}</span>
          <Tooltip label={t('sidebar.refresh')}>
            <IconButton size="sm" label={t('sidebar.refresh')} icon={<RefreshCw size={13} />} onClick={onRefreshRecent} />
          </Tooltip>
          <Tooltip label={t('projectMenu.openFolder')} shortcut={shortcutLabel('openProject')}>
            <IconButton size="sm" label={t('projectMenu.openFolder')} icon={<FolderOpen size={13} />} onClick={onOpenFolder} />
          </Tooltip>
          <Tooltip label={t('projectMenu.new')} shortcut={shortcutLabel('newProject')} align="end">
            <IconButton size="sm" label={t('projectMenu.new')} icon={<Plus size={14} />} onClick={onNewProject} data-testid="sidebar-new" />
          </Tooltip>
        </div>
        <div className="sb-search">
          <TextField
            ref={searchRef}
            icon={<Search size={13} />}
            type="search"
            placeholder={t('sidebar.search')}
            aria-label={t('sidebar.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            trailing={
              query ? (
                <button type="button" className="sb-search__clear" aria-label={t('common.clear')} onClick={() => setQuery('')}>
                  <X size={12} />
                </button>
              ) : undefined
            }
          />
        </div>

        <button type="button" className="sb-new" onClick={onNewProject}>
          <Plus size={13} />
          <span>{t('projectMenu.new')}</span>
          <kbd className="sb-new__kbd">{shortcutLabel('newProject')}</kbd>
        </button>

        {projects.length === 0 && <p className="sb-tree__empty">{query ? t('sidebar.noMatch', { query }) : t('sidebar.empty')}</p>}

        {(['today', 'older'] as const).map((g) =>
          groups[g].length === 0 ? null : (
            <div key={g} className="sidebar__group">
              <div className="sb-group">{t(g === 'today' ? 'sidebar.group.today' : 'sidebar.group.recent')}</div>
              <div className="sb-tree">
                {groups[g].map((r) => {
                  const active = r.dir === project?.dir;
                  return (
                    <div key={r.dir} className={`sb-project${active ? ' is-active' : ''}${r.exists ? '' : ' is-missing'}`}>
                      <div
                        className="sb-project__row"
                        role="button"
                        tabIndex={0}
                        title={r.dir}
                        onClick={() => (r.exists ? (active ? onNavigate('workspace') : onOpenProject(r.dir)) : undefined)}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && r.exists) {
                            e.preventDefault();
                            if (active) onNavigate('workspace');
                            else onOpenProject(r.dir);
                          }
                        }}
                      >
                        <span className="sb-project__tile" aria-hidden="true">
                          {initialOf(r.title)}
                        </span>
                        <span className="sb-project__name">{r.title}</span>
                        {!r.exists && <span className="sb-project__missing">{t('projectMenu.missing')}</span>}
                        {active && snapshot?.next?.state === 'needs-human' && <span className="sb-project__attention" title={t('sidebar.needsHuman')} />}
                      </div>
                      {active && (
                        <ProjectChildren dir={r.dir} screen={screen} snapshot={snapshot} collapsed={collapsed} onToggle={toggle} onNavigate={onNavigate} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ),
        )}
      </div>
    </aside>
  );
}

function ProjectChildren({
  dir,
  screen,
  snapshot,
  collapsed,
  onToggle,
  onNavigate,
}: {
  dir: string;
  screen: Screen;
  snapshot: ProjectSnapshot | null;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onNavigate: (s: Screen) => void;
}) {
  const t = useST();
  const [takes, setTakes] = useState<TakeEntry[] | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[] | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      api.invoke('project:cli', dir, ['takes']).catch(() => null),
      api.invoke('project:cli', dir, ['feedback', 'list']).catch(() => null),
    ]);
    setTakes(a?.ok ? parseTakes(a.data) : []);
    setFeedback(b?.ok ? parseFeedbackList(b.data) : []);
  }, [dir]);

  useEffect(() => {
    void load();
    let timer = 0;
    const off = api.on('project:changed', (d) => {
      if (d !== dir) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 600);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [dir, load]);

  const section = (key: SectionKey, label: SKey, count: number | null, body: React.ReactNode) => {
    const id = `${key}`;
    const isCollapsed = collapsed[id] ?? false;
    return (
      <div className="sb-section">
        <button type="button" className="sb-section__head" aria-expanded={!isCollapsed} onClick={() => onToggle(id)}>
          <ChevronDown size={12} className={isCollapsed ? 'is-collapsed' : ''} aria-hidden="true" />
          <span className="sb-section__title">{t(label)}</span>
          {count !== null && <span className="sidebar__section-count">{count}</span>}
        </button>
        {!isCollapsed && <div className="sb-section__body">{body}</div>}
      </div>
    );
  };

  return (
    <div className="sb-project__children">
      {section(
        'renders',
        'sidebar.renders',
        null,
        (() => {
          const rendered = !!snapshot?.preview;
          const stale = !!snapshot?.stale;
          const sel = screen === 'workspace' || screen === 'review';
          return (
            <button type="button" className={`sb-item${sel ? ' is-selected' : ''}`} onClick={() => onNavigate('workspace')} title={snapshot?.preview?.path ?? t('sidebar.render.video')}>
              <Film size={13} aria-hidden="true" />
              <span className="sb-item__label">{t('sidebar.render.video')}</span>
              <span className={`sb-item__state is-${stale ? 'stale' : rendered ? 'ok' : 'todo'}`}>
                {t(stale ? 'sidebar.render.stale' : rendered ? 'sidebar.render.ready' : 'sidebar.render.none')}
              </span>
            </button>
          );
        })(),
      )}
      {section(
        'takes',
        'sidebar.takes',
        takes?.length ?? null,
        takes === null ? (
          <p className="sb-project__empty">…</p>
        ) : takes.length === 0 ? (
          <button type="button" className="sb-item sb-item--hint" onClick={() => onNavigate('record')}>
            <Video size={13} aria-hidden="true" />
            <span className="sb-item__label">{t('sidebar.noTakes')}</span>
          </button>
        ) : (
          takes.map((tk) => (
            <button key={tk.id} type="button" className="sb-item" title={tk.files.join(', ')} onClick={() => void api.invoke('app:showInFolder', `${dir}/media/takes/${tk.id}`)}>
              <Clapperboard size={13} aria-hidden="true" />
              <span className="sb-item__label sb-item__label--mono">{tk.id}</span>
              {tk.markers > 0 && <span className="sb-item__meta">◆{tk.markers}</span>}
              <span className={`sb-item__state is-${tk.ingested ? 'ok' : tk.complete === false ? 'stale' : 'todo'}`}>
                {t(tk.ingested ? 'sidebar.take.ingested' : tk.complete === false ? 'sidebar.take.partial' : 'sidebar.take.new')}
              </span>
            </button>
          ))
        ),
      )}
      {section(
        'feedback',
        'sidebar.feedback',
        feedback?.length ?? null,
        feedback === null ? (
          <p className="sb-project__empty">…</p>
        ) : feedback.length === 0 ? (
          <p className="sb-project__empty">{t('sidebar.noFeedback')}</p>
        ) : (
          feedback.map((f) => (
            <button key={f.id} type="button" className="sb-item" onClick={() => onNavigate('review')} title={f.path}>
              <MessageSquareText size={13} aria-hidden="true" />
              <span className="sb-item__label sb-item__label--mono">{f.id}</span>
              <span className="sb-item__meta">{t('sidebar.items', { n: String(f.items) })}</span>
              <span className={`sb-item__state is-${f.status === 'open' ? 'todo' : 'ok'}`}>{t(f.status === 'open' ? 'sidebar.fb.open' : 'sidebar.fb.done')}</span>
            </button>
          ))
        ),
      )}
    </div>
  );
}
