import { PanelBottom, PanelBottomDashed, PanelLeft, PanelLeftDashed, PanelRight, PanelRightDashed, type LucideIcon } from 'lucide-react';
import { IconButton, Tooltip } from '../ui';
import { useST, type SKey } from './i18n';
import { layoutStore, useLayout, type Panel } from './layout';
import { shortcutLabel, type ShortcutId } from './shortcut';

/**
 * Panel toggles in the title bar, like the VS Code layout controls (ported from Ferret
 * src/renderer/components/LayoutToggles.tsx). Left to right in screen order: sidebar, center (preview / timeline),
 * terminal panel. Open = filled icon, closed = dashed icon. The center and terminal cannot both be closed.
 */
const ICON_OPEN: Record<Panel, LucideIcon> = { sidebar: PanelLeft, center: PanelBottom, terminal: PanelRight };
const ICON_CLOSED: Record<Panel, LucideIcon> = { sidebar: PanelLeftDashed, center: PanelBottomDashed, terminal: PanelRightDashed };
const SHORTCUT: Record<Panel, ShortcutId> = { sidebar: 'toggleSidebar', center: 'toggleCenter', terminal: 'toggleTerminal' };
const NAME: Record<Panel, SKey> = { sidebar: 'layout.panel.sidebar', center: 'layout.panel.center', terminal: 'layout.panel.terminal' };

export function LayoutToggles({ panels = ['sidebar', 'center', 'terminal'] }: { panels?: Panel[] }) {
  const t = useST();
  const layout = useLayout();
  return (
    <div className="layout-toggles" role="group" aria-label={t('layout.group')}>
      {panels.map((id) => {
        const visible = layout[id];
        const Icon = visible ? ICON_OPEN[id] : ICON_CLOSED[id];
        const label = t(visible ? 'layout.hide' : 'layout.show', { panel: t(NAME[id]) });
        return (
          <Tooltip key={id} label={label} shortcut={shortcutLabel(SHORTCUT[id])} align={id === 'terminal' ? 'end' : 'center'}>
            <IconButton label={label} icon={<Icon size={14} />} selected={visible} onClick={() => layoutStore.toggle(id)} data-testid={`toggle-${id}`} />
          </Tooltip>
        );
      })}
    </div>
  );
}
