import { Clapperboard, ListChecks, Send, Settings, Video } from 'lucide-react';
import type { ProjectInfo, RecentProject, Variant } from '@shared/types';
import iconUrl from '../assets/icon.svg';
import { IconButton, RecordButton, Segmented, Tooltip, type SegmentedOption } from '../ui';
import { useST } from './i18n';
import { LayoutToggles } from './LayoutToggles';
import { MODES, VARIANT_ORDER, type Mode } from './modes';
import { ProjectMenu } from './ProjectMenu';
import { shortcutLabel, type ShortcutId } from './shortcut';

/**
 * Title bar (36px), the window's drag strip (ported from Ferret src/renderer/components/TitleBar.tsx).
 *
 *   left   … logo / project switcher (recent projects)
 *   center … the four modes 撮影 / 編集 / 確認 / 投稿, and YouTube / TikTok / Shorts while editing or reviewing
 *   right  … panel toggles / ● Record / settings
 *
 * The macOS traffic lights take the left inset (--titlebar-inset in shell.css).
 */
const MODE_ICON: Record<Mode, typeof Video> = { record: Video, edit: Clapperboard, review: ListChecks, publish: Send };
const MODE_SHORTCUT: Record<Mode, ShortcutId> = { record: 'modeRecord', edit: 'modeEdit', review: 'modeReview', publish: 'modePublish' };

export function TitleBar({
  project,
  recent,
  mode,
  variant,
  variants,
  showVariant,
  recording,
  recordLabel,
  recordDisabled,
  onOpenProject,
  onOpenFolder,
  onNewProject,
  onRefreshRecent,
  onMode,
  onVariant,
  onRecord,
  onSettings,
}: {
  project: ProjectInfo | null;
  recent: RecentProject[];
  mode: Mode | null;
  variant: Variant;
  /** variants that already have a timeline (others get a dot: not derived yet) */
  variants: Variant[];
  showVariant: boolean;
  recording: boolean;
  recordLabel: string;
  recordDisabled: boolean;
  onOpenProject: (dir: string) => void;
  onOpenFolder: () => void;
  onNewProject: () => void;
  onRefreshRecent: () => void;
  onMode: (mode: Mode) => void;
  onVariant: (v: Variant) => void;
  onRecord: () => void;
  onSettings: () => void;
}) {
  const t = useST();
  const modeOptions: SegmentedOption<Mode>[] = MODES.map((m) => {
    const Icon = MODE_ICON[m];
    return {
      value: m,
      label: t(`mode.${m}`),
      icon: <Icon size={13} />,
      title: `${t(`mode.${m}.title`)} (${shortcutLabel(MODE_SHORTCUT[m])})`,
      disabled: !project && m !== 'record',
      testId: `mode-${m}`,
    };
  });
  const variantOptions: SegmentedOption<Variant>[] = VARIANT_ORDER.map((v) => ({
    value: v,
    label: t(`variant.${v}`),
    title: variants.includes(v) || v === 'main' ? t(`variant.${v}.title`) : `${t(`variant.${v}.title`)} — ${t('variant.notDerived')}`,
    suffix: v !== 'main' && !variants.includes(v) ? <span className="segmented__dot" aria-hidden="true" /> : undefined,
    testId: `variant-${v}`,
  }));

  return (
    <header className="app-titlebar" data-testid="titlebar">
      <div className="app-titlebar__left">
        <span className="app-titlebar__logo">
          <img src={iconUrl} width={18} height={18} alt="Solocut" />
        </span>
        <span className="app-titlebar__sep" aria-hidden="true" />
        <ProjectMenu
          project={project}
          recent={recent}
          onOpen={onOpenProject}
          onOpenFolder={onOpenFolder}
          onNew={onNewProject}
          onMenuOpen={onRefreshRecent}
        />
      </div>

      <div className="app-titlebar__center">
        <Segmented ariaLabel={t('mode.group')} value={mode} onChange={onMode} options={modeOptions} />
        {showVariant && project && (
          <Segmented ariaLabel={t('variant.group')} value={variant} onChange={onVariant} options={variantOptions} size="sm" className="variant-switch" />
        )}
      </div>

      <div className="app-titlebar__right">
        <LayoutToggles />
        <RecordButton
          recording={recording}
          disabled={recordDisabled}
          label={recordLabel}
          title={`${recording ? t('record.stop') : t('record.start')} (${shortcutLabel('record')})`}
          onClick={onRecord}
        />
        <Tooltip label={t('common.settings')} shortcut={shortcutLabel('settings')} align="end">
          <IconButton label={t('common.settings')} icon={<Settings size={14} />} onClick={onSettings} data-testid="settings-button" />
        </Tooltip>
      </div>
    </header>
  );
}
