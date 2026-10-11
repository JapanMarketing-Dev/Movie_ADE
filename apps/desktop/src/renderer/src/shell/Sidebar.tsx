import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronDown,
  Clapperboard,
  Film,
  FolderOpen,
  Home,
  MessageSquareText,
  Package,
  Plus,
  RefreshCw,
  Search,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ArchiveListItem, ProjectInfo, ProjectSnapshot, RecentProject, Variant } from '@shared/types';
import { api } from '../lib/api';
import { IconButton, TextField, Tooltip } from '../ui';
import { dayBucket, initialOf } from './format';
import { useST, type SKey } from './i18n';
import { VARIANT_ORDER, type Screen } from './modes';
import { matchesAll } from './search';
import { shortcutLabel } from './shortcut';
import { parseFeedbackList, parseTakes, type FeedbackEntry, type TakeEntry } from './projectItems';

/**
 * Left sidebar (ported from Ferret src/renderer/components/Sidebar.tsx; Orca由来の寸法: 見出し 32px・行 28px・
 * 子の行は 18px 字下げ、MIT、Ferret 経由).
 *
 *   pages     … ホーム / 過去の動画 / ライブラリ
 *   projects  … recent projects with search; the open project expands into
 *               takes, the three renders (YouTube / TikTok / Shorts), feedback sessions and its archive entries.
 * Sections collapse; the state is kept per section in localStorage.
 */
type SectionKey = 'takes' | 'renders' | 'feedback' | 'archive';

const COLLAPSE_KEY = 'solocut.sidebar.collapsed';

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
  snapshots,
  variant,
  onNavigate,
  onOpenProject,
  onNewProject,
  onOpenFolder,
  onVariant,
  onRefreshRecent,
}: {
  screen: Screen;
  project: ProjectInfo | null;
  recent: RecentProject[];
  /** snapshots of the open project per variant (renders) */
  snapshots: Partial<Record<Variant, ProjectSnapshot>>;
  variant: Variant;
  onNavigate: (s: Screen) => void;
  onOpenProject: (dir: string) => void;
  onNewProject: () => void;
  onOpenFolder: () => void;
  onVariant: (v: Variant) => void;
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

  const pages: { id: Screen; icon: LucideIcon; key: SKey }[] = [
    { id: 'home', icon: Home, key: 'nav.home' },
    { id: 'archive', icon: Archive, key: 'nav.archive' },
    { id: 'library', icon: Package, key: 'nav.library' },
  ];

  return (
    <aside className="sidebar" data-testid="sidebar" aria-label={t('sidebar.label')}>
      <div className="sidebar__list">
        <nav className="sb-pages" aria-label={t('sidebar.pages')}>
          {pages.map(({ id, icon: Icon, key }) => (
            <button key={id} type="button" className={`sb-page${screen === id ? ' is-active' : ''}`} aria-current={screen === id || undefined} onClick={() => onNavigate(id)}>
              <Icon size={14} />
              <span>{t(key)}</span>
            </button>
          ))}
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
                        {active && snapshots.main?.next?.state === 'needs-human' && <span className="sb-project__attention" title={t('sidebar.needsHuman')} />}
                      </div>
                      {active && (
                        <ProjectChildren
                          dir={r.dir}
                          screen={screen}
                          snapshots={snapshots}
                          variant={variant}
                          collapsed={collapsed}
                          onToggle={toggle}
                          onNavigate={onNavigate}
                          onVariant={onVariant}
                        />
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
  snapshots,
  variant,
  collapsed,
  onToggle,
  onNavigate,
  onVariant,
}: {
  dir: string;
  screen: Screen;
  snapshots: Partial<Record<Variant, ProjectSnapshot>>;
  variant: Variant;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  onNavigate: (s: Screen) => void;
  onVariant: (v: Variant) => void;
}) {
  const t = useST();
  const [takes, setTakes] = useState<TakeEntry[] | null>(null);
  const [feedback, setFeedback] = useState<FeedbackEntry[] | null>(null);
  const [archive, setArchive] = useState<ArchiveListItem[] | null>(null);

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      api.invoke('project:cli', dir, ['takes']).catch(() => null),
      api.invoke('project:cli', dir, ['feedback', 'list']).catch(() => null),
      api.invoke('archive:list').catch(() => [] as ArchiveListItem[]),
    ]);
    setTakes(a?.ok ? parseTakes(a.data) : []);
    setFeedback(b?.ok ? parseFeedbackList(b.data) : []);
    setArchive(c.filter((x) => x.projectDir === dir));
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
        VARIANT_ORDER.map((v) => {
          const s = snapshots[v];
          const exists = v === 'main' || (snapshots.main?.variants.includes(v) ?? false);
          const rendered = !!s?.preview;
          const stale = !!s?.stale;
          const sel = variant === v && (screen === 'workspace' || screen === 'review');
          return (
            <button
              key={v}
              type="button"
              className={`sb-item${sel ? ' is-selected' : ''}`}
              onClick={() => {
                onVariant(v);
                onNavigate('workspace');
              }}
              title={s?.preview?.path ?? t(`variant.${v}.title`)}
            >
              <Film size={13} aria-hidden="true" />
              <span className="sb-item__label">{t(`variant.${v}`)}</span>
              <span className={`sb-item__state is-${!exists ? 'none' : stale ? 'stale' : rendered ? 'ok' : 'todo'}`}>
                {t(!exists ? 'sidebar.render.notDerived' : stale ? 'sidebar.render.stale' : rendered ? 'sidebar.render.ready' : 'sidebar.render.none')}
              </span>
            </button>
          );
        }),
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
      {section(
        'archive',
        'sidebar.archive',
        archive?.length ?? null,
        archive === null ? (
          <p className="sb-project__empty">…</p>
        ) : archive.length === 0 ? (
          <p className="sb-project__empty">{t('sidebar.noArchive')}</p>
        ) : (
          archive.map((a) => (
            <button key={a.id} type="button" className="sb-item" onClick={() => onNavigate('archive')} title={a.title}>
              <Archive size={13} aria-hidden="true" />
              <span className="sb-item__label">{a.title}</span>
              {a.createdAt && <span className="sb-item__meta">{a.createdAt.slice(5, 10)}</span>}
            </button>
          ))
        ),
      )}
    </div>
  );
}
