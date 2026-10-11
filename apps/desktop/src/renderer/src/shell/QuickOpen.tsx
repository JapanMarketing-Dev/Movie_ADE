import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Clapperboard, Command, CornerDownLeft, FolderOpen, Search, Settings, Sparkles } from 'lucide-react';
import { Modal } from '../ui';
import { useST } from './i18n';
import { rankItems, type Searchable } from './search';

/**
 * ⌘P quick open / ⌘⇧P command palette (ported from Ferret src/renderer/components/QuickOpen.tsx; Orca由来:
 * ~/bench/orca/src/renderer/src/components/quick-open-file-list.ts、MIT、Ferret 経由).
 * One list of projects, prompts (sent to the agent terminal), screens and settings sections, filtered by fuzzy match.
 * Typing ">" first narrows to commands (screens, settings, prompts), like VS Code.
 */
export type PaletteKind = 'project' | 'prompt' | 'screen' | 'setting' | 'action';

export interface PaletteItem extends Searchable {
  kind: PaletteKind;
  /** right-hand hint (path, shortcut) */
  hint?: string;
  run: () => void;
}

const ICON: Record<PaletteKind, ReactNode> = {
  project: <Clapperboard size={14} aria-hidden="true" />,
  prompt: <Sparkles size={14} aria-hidden="true" />,
  screen: <Command size={14} aria-hidden="true" />,
  setting: <Settings size={14} aria-hidden="true" />,
  action: <FolderOpen size={14} aria-hidden="true" />,
};

export function QuickOpen({ items, initialQuery = '', onClose }: { items: PaletteItem[]; initialQuery?: string; onClose: () => void }) {
  const t = useST();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const commandsOnly = query.startsWith('>');
  const q = commandsOnly ? query.slice(1) : query;
  const results = useMemo(() => rankItems(q, commandsOnly ? items.filter((i) => i.kind !== 'project') : items, 60), [q, commandsOnly, items]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <Modal className="quick-open-modal" label={t('quick.title')} onClose={onClose}>
      <div
        className="quick-open-shade"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="quick-open" data-testid="quick-open">
          <div className="quick-open__input">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              placeholder={t('quick.placeholder')}
              aria-label={t('quick.placeholder')}
              aria-controls="quick-open-list"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelected((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelected((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  choose(results[selected]);
                }
              }}
              data-testid="quick-open-input"
            />
          </div>
          {results.length === 0 ? (
            <p className="quick-open__note">{t('quick.noMatch')}</p>
          ) : (
            <ul className="quick-open__list" id="quick-open-list" role="listbox" ref={listRef}>
              {results.map((item, index) => (
                <li
                  key={`${item.kind}:${item.id}`}
                  role="option"
                  aria-selected={index === selected}
                  className="quick-open__item"
                  onMouseMove={() => setSelected(index)}
                  onClick={() => choose(item)}
                >
                  <span className="quick-open__icon">{ICON[item.kind]}</span>
                  <span className="quick-open__name">{item.label}</span>
                  <span className="quick-open__kind">{t(`quick.kind.${item.kind}`)}</span>
                  {item.hint && <span className="quick-open__dir">{item.hint}</span>}
                  {index === selected && <CornerDownLeft size={12} className="quick-open__enter" aria-hidden="true" />}
                </li>
              ))}
            </ul>
          )}
          <p className="quick-open__note quick-open__note--foot">{t('quick.foot')}</p>
        </div>
      </div>
    </Modal>
  );
}
