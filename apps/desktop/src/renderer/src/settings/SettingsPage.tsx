import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import type { AppInfo } from '@shared/types';
import { useST, type SKey } from '../shell/i18n';
import { settingsStore, useStore } from '../shell/stores';
import { TextField } from '../ui';
import { SETTINGS_SECTIONS, activeSectionAt, filterSettingsSections, type SettingsSectionId } from './settingsSections';
import {
  AboutSection,
  AccountsSection,
  AgentsSection,
  AppearanceSection,
  CrashReportsSection,
  GeneralSection,
  LanguageSection,
  LayoutSection,
  PromptsSection,
  RecordingSection,
  TranscriptionSection,
  UpdatesSection,
} from './Sections';

function PageSection({ id, title, children }: { id: SettingsSectionId; title: string; children: ReactNode }) {
  return (
    <section className="st-page__section" id={`settings-page-${id}`} data-section={id} aria-label={title}>
      <h2 className="st-page__heading">{title}</h2>
      <div className="st-page__body">{children}</div>
    </section>
  );
}

/**
 * Settings page (ported from Ferret src/renderer/components/SettingsPage.tsx, following the VS Code / Orca settings
 * page). Section list on the left, a search box and every section stacked on the right: plain controls only, no JSON.
 * Changes save right away to ~/.solocut/settings.json through main (docs/11).
 */
export function SettingsPage({
  info,
  focus,
  onShowOnboarding,
}: {
  info: AppInfo | null;
  /** open a section from outside (status bar, palette); changes of nonce re-trigger */
  focus?: { section: SettingsSectionId; nonce: number } | null;
  onShowOnboarding: () => void;
}) {
  const t = useST();
  const settings = useStore(settingsStore);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SettingsSectionId>('general');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const titleOf = (id: SettingsSectionId) => t(`settings.section.${id}` as SKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visible = useMemo(() => filterSettingsSections(query, titleOf), [query, t]);

  const goTo = (id: SettingsSectionId) => {
    setActive(id);
    document.getElementById(`settings-page-${id}`)?.scrollIntoView({ block: 'start' });
  };

  useEffect(() => {
    if (!focus) return;
    setQuery('');
    requestAnimationFrame(() => goTo(focus.section));
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    const tops = [...box.querySelectorAll<HTMLElement>('[data-section]')].map((el) => ({
      id: el.dataset.section as SettingsSectionId,
      top: el.getBoundingClientRect().top - top,
    }));
    const current = activeSectionAt(tops);
    if (current) setActive(current);
  };

  const json = settings.json ?? {};
  const sections: Record<SettingsSectionId, ReactNode> = {
    general: <GeneralSection json={json} />,
    prompts: <PromptsSection />,
    agents: <AgentsSection json={json} />,
    accounts: <AccountsSection />,
    recording: <RecordingSection json={json} />,
    transcription: <TranscriptionSection json={json} />,
    appearance: <AppearanceSection json={json} />,
    language: <LanguageSection json={json} />,
    layout: <LayoutSection />,
    updates: <UpdatesSection json={json} info={info} />,
    crashReports: <CrashReportsSection json={json} />,
    about: <AboutSection info={info} onShowOnboarding={onShowOnboarding} />,
  };

  return (
    <div className="st-host">
      <div className="st-page" data-testid="settings-page">
        <nav className="st-page__nav" aria-label={t('settings.nav')}>
          <h1 className="st-page__title">{t('common.settings')}</h1>
          {SETTINGS_SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              className="st-page__navitem"
              aria-current={active === id || undefined}
              disabled={!visible.includes(id)}
              onClick={() => goTo(id)}
              data-testid={`settings-nav-${id}`}
            >
              {titleOf(id)}
            </button>
          ))}
        </nav>
        <div className="st-page__main">
          <div className="st-page__search">
            <TextField
              icon={<Search size={14} />}
              type="search"
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="settings-search"
            />
          </div>
          <div className="st-page__scroll" ref={scrollRef} onScroll={onScroll}>
            <p className="st-note st-page__autosave">{t('settings.autosave')}</p>
            {visible.length === 0 ? (
              <p className="st-page__empty">{t('settings.searchEmpty', { query })}</p>
            ) : (
              <div className="st-page__sections">
                {visible.map((id) => (
                  <PageSection key={id} id={id} title={titleOf(id)}>
                    {sections[id]}
                  </PageSection>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
