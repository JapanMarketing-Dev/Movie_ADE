// Ported from Ferret src/renderer/components/QuickLaunchButton.tsx (MIT).
// Solocut adaptations: agents come from agents:list (installed ones launch; the others show their install
// command), no agent logos (a generic icon), no URL / file search, text from terminal/strings.ts.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, Bot, Download, Plus, Search, SquareTerminal } from 'lucide-react';
import { buildQuickLaunchEntries, entryId, type QuickLaunchEntry } from '../terminal/quickLaunchSearch';
import { useTermT, type TermT } from '../terminal/strings';

/**
 * タブ列の「＋」。押すと「新しいターミナル / Claude Code / Codex / …」を選べる。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/QuickLaunchButton.tsx（MIT, Copyright 2026 Lovecast Inc.）
 * Orca の項目構成・並び・ショートカット表示をそのまま使い、Agent検出・telemetry・store は持ち込んでいない。
 *
 * メニューは popover（最上位レイヤー）に出す。タブ列は横スクロールのため overflow で切れてしまうので、
 * 位置は開く直前にボタンの座標から決める。外側クリックと Esc で閉じるのはブラウザに任せる。
 *
 * ペインの分割（右に分割／下に分割）でも、同じメニューで新しいペインの中身を選ぶ。
 * search を渡すと、一番上に検索欄を出す。入力に応じてメニューの項目・開いているタブ・インストールできる Agent を
 * 絞り込み、↑↓で選んで Enter で実行する。
 */

/** メニューに出すエージェント1件 */
export interface QuickLaunchAgent {
  id: string;
  label: string;
  version?: string;
}

/** インストールされていないエージェント（インストールのコマンド付き） */
export interface QuickLaunchInstall {
  id: string;
  label: string;
  command: string;
}

const MENU_WIDTH = 240;
const SEARCH_MENU_WIDTH = 340;

/** 検索欄の材料と、選ばれたときの動き */
export interface QuickLaunchSearch {
  tabs: ReadonlyArray<{ key: string; title: string }>;
  onSelectTab: (key: string) => void;
}

export function QuickLaunchButton({
  agents,
  installable = [],
  onNewTerminal,
  onLaunchAgent,
  onInstall,
  icon = <Plus size={14} strokeWidth={2} />,
  label: labelProp,
  testId = 'terminal-add-tab',
  disabled = false,
  search,
}: {
  agents: readonly QuickLaunchAgent[];
  /** 渡すと、インストールのコマンドを新しいタブに入れる項目を出す */
  installable?: readonly QuickLaunchInstall[];
  onNewTerminal: () => void;
  onLaunchAgent: (agent: string) => void;
  onInstall?: (agent: QuickLaunchInstall) => void;
  icon?: ReactNode;
  /** ボタンとメニューの名前 */
  label?: string;
  testId?: string;
  disabled?: boolean;
  /** 渡すと一番上に検索欄を出す */
  search?: QuickLaunchSearch;
}) {
  const t = useTermT();
  const label = labelProp ?? t('newTab');
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const width = search ? SEARCH_MENU_WIDTH : MENU_WIDTH;

  const entries = useMemo(
    () =>
      buildQuickLaunchEntries(search ? query : '', {
        agents,
        installable: onInstall ? installable : [],
        tabs: search?.tabs ?? [],
      }),
    [agents, installable, onInstall, search, query],
  );

  useEffect(() => setHighlight(0), [query]);

  // 開く直前に位置を決め、開いたら検索欄（無ければ最初の項目）へ焦点を移す
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const onBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') return;
      const button = buttonRef.current;
      if (!button) return;
      setQuery('');
      setHighlight(0);
      const rect = button.getBoundingClientRect();
      const pane = button.closest('.terminal-pane')?.getBoundingClientRect();
      const minLeft = (pane?.left ?? 0) + 4;
      const maxLeft = window.innerWidth - width - 8;
      menu.style.left = `${Math.max(minLeft, Math.min(rect.left, maxLeft))}px`;
      menu.style.top = `${rect.bottom + 4}px`;
    };
    const onToggle = (event: Event) => {
      const open = (event as ToggleEvent).newState === 'open';
      buttonRef.current?.setAttribute('aria-expanded', String(open));
      if (!open) return;
      if (inputRef.current) inputRef.current.focus();
      else menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    };
    menu.addEventListener('beforetoggle', onBeforeToggle);
    menu.addEventListener('toggle', onToggle);
    return () => {
      menu.removeEventListener('beforetoggle', onBeforeToggle);
      menu.removeEventListener('toggle', onToggle);
    };
  }, [width]);

  const runEntry = (entry: QuickLaunchEntry) => {
    menuRef.current?.hidePopover();
    switch (entry.kind) {
      case 'shell':
        return onNewTerminal();
      case 'agent':
        return onLaunchAgent(entry.agent);
      case 'install':
        return onInstall?.({ id: entry.agent, label: entry.label, command: entry.command });
      case 'tab':
        return search?.onSelectTab(entry.tabKey);
    }
  };

  // 検索欄があるときは焦点を欄に置いたまま、↑↓で選んで Enter で実行する。
  // 無いときは上下キーで項目へ焦点を移す（Tab で抜けられるよう、ほかのキーは触らない）
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (search) {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target === inputRef.current) {
        event.preventDefault();
        const entry = entries[highlight];
        if (entry) runEntry(entry);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (entries.length === 0) return;
      const next = event.key === 'ArrowDown' ? highlight + 1 : highlight - 1;
      setHighlight((next + entries.length) % entries.length);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  // 選んでいる項目が見えるようにする
  useEffect(() => {
    if (!search) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight, search]);

  const renderEntry = (entry: QuickLaunchEntry, index: number) => {
    const view = entryView(entry, t);
    const active = Boolean(search) && index === highlight;
    const firstInstall = entry.kind === 'install' && entries[index - 1]?.kind !== 'install';
    return (
      <div key={entryId(entry)} className="quick-launch__row">
        {firstInstall && <div className="quick-launch__separator" role="separator" />}
        <button
          type="button"
          role="menuitem"
          id={`${menuId}-${index}`}
          data-index={index}
          className={`quick-launch__item${entry.kind === 'install' ? ' quick-launch__item--muted' : ''}${active ? ' is-active' : ''}`}
          title={view.title}
          tabIndex={search ? -1 : undefined}
          onMouseMove={() => search && index !== highlight && setHighlight(index)}
          onClick={() => runEntry(entry)}
          data-testid={`${testId}-${view.testSuffix}`}
        >
          {view.icon}
          <span className="quick-launch__label">{view.label}</span>
          {view.detail && <span className="quick-launch__detail">{view.detail}</span>}
        </button>
      </div>
    );
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="terminal-tabs__add"
        popoverTarget={menuId}
        aria-haspopup="menu"
        aria-expanded="false"
        title={label}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
      >
        {icon}
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={label}
        className="quick-launch"
        style={{ width }}
        onKeyDown={onKeyDown}
        data-testid={`${testId}-menu`}
      >
        {search && (
          <div className="quick-launch__search">
            <Search size={14} strokeWidth={1.75} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              className="quick-launch__input"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              aria-activedescendant={entries.length > 0 ? `${menuId}-${highlight}` : undefined}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              data-testid={`${testId}-search`}
            />
          </div>
        )}
        <div className="quick-launch__list">
          {entries.map(renderEntry)}
          {entries.length === 0 && <div className="quick-launch__empty">{t('noMatches')}</div>}
        </div>
      </div>
    </>
  );
}

function entryView(entry: QuickLaunchEntry, t: TermT): { icon: ReactNode; label: string; detail?: string; title?: string; testSuffix: string } {
  switch (entry.kind) {
    case 'shell':
      return { icon: <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" />, label: t('newTerminal'), testSuffix: 'shell' };
    case 'agent':
      return {
        icon: <Bot size={14} strokeWidth={1.75} aria-hidden="true" />,
        label: entry.label,
        ...(entry.version ? { detail: entry.version } : {}),
        title: t('launchAgent', { agent: entry.label }),
        testSuffix: entry.agent.replace(':', '-'),
      };
    case 'install':
      return {
        icon: <Download size={14} strokeWidth={1.75} aria-hidden="true" />,
        label: entry.label,
        detail: entry.command,
        title: t('installHint', { agent: entry.label }),
        testSuffix: `install-${entry.agent}`,
      };
    case 'tab':
      return { icon: <AppWindow size={14} strokeWidth={1.75} aria-hidden="true" />, label: entry.title, detail: t('tab'), testSuffix: `tab-${entry.tabKey}` };
  }
}
