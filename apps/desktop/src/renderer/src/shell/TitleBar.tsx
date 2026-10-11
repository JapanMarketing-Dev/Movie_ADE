import { Clapperboard, ListChecks, Send, Settings, Video } from 'lucide-react';
import type { ProjectInfo, RecentProject } from '@shared/types';
import iconUrl from '../assets/icon.svg';
import { IconButton, RecordButton, Segmented, Tooltip, type SegmentedOption } from '../ui';
import { useST } from './i18n';
import { LayoutToggles } from './LayoutToggles';
import { MODES, type Mode } from './modes';
import { ProjectMenu } from './ProjectMenu';
import { shortcutLabel, type ShortcutId } from './shortcut';

/**
 * Title bar (36px), the window's drag strip (ported from Ferret src/renderer/components/TitleBar.tsx).
 *
 *   left   … logo / project switcher (recent projects)
 *   center … the four modes 撮影 / 編集 / 確認 / 投稿 (one 16:9 video per project: no output switcher)
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
  recording,
  recordLabel,
  recordDisabled,
  onOpenProject,
  onOpenFolder,
  onNewProject,
  onRefreshRecent,
  onMode,
  onRecord,
  onSettings,
}: {
  project: ProjectInfo | null;
  recent: RecentProject[];
  mode: Mode | null;
  recording: boolean;
  recordLabel: string;
  recordDisabled: boolean;
  onOpenProject: (dir: string) => void;
  onOpenFolder: () => void;
  onNewProject: () => void;
  onRefreshRecent: () => void;
  onMode: (mode: Mode) => void;
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
