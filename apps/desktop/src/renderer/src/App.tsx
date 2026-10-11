import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AppInfo, Lang, ProjectInfo, ProjectSnapshot, PromptButton, RecentProject } from '@shared/types';
import { LangContext } from './i18n';
import { api, errMsg } from './lib/api';
import { recorder, type RecStatus } from './lib/recorder';
import { sendToAgent } from './terminal/agentSend';
import { onFailoverNotice } from './shell/agentUsage';
import { Home } from './screens/Home';
import { Workspace } from './screens/Workspace';
import { Record } from './screens/Record';
import { Library } from './screens/Library';
import { Thumbnails } from './screens/Thumbnails';
import { Publish } from './screens/Publish';
import { ErrorBoundary, ToastProvider, useToast } from './ui';
import { useST, shellTranslate } from './shell/i18n';
import { TitleBar } from './shell/TitleBar';
import { StatusBar } from './shell/StatusBar';
import { Sidebar } from './shell/Sidebar';
import { PaneTabs } from './shell/PaneTabs';
import { QuickOpen, type PaletteItem } from './shell/QuickOpen';
import { layoutStore, layoutToSettings, useLayout } from './shell/layout';
import { setSetting, settingsStore, useStore } from './shell/stores';
import { activeMode, needsProject, parseNavigateDetail, parseScreen, screenForMode, type Mode, type Screen } from './shell/modes';
import { AccountLoginDialog } from './components/AgentAccounts';
import { setShortcutPlatform, shortcutFor, shortcutLabel } from './shell/shortcut';
import { formatElapsed } from './shell/format';
import { SettingsPage } from './settings/SettingsPage';
import { getPath, SETTINGS_SECTIONS, type SettingsSectionId } from './settings/settingsSections';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { markOnboarding, shouldShowOnboarding } from './onboarding/flow';

export type { Screen } from './shell/modes';

/**
 * The shell: title bar / sidebar + screen / status bar (layout ported from Ferret src/renderer/App.tsx and
 * styles/app.css). The existing screens are re-homed inside it unchanged in logic; Workspace and Record stay mounted
 * so agent terminals and an ongoing take keep running while another screen is shown.
 */
export function App() {
  const [lang, setLang] = useState<Lang>('ja');
  const t = (k: Parameters<typeof shellTranslate>[1]) => shellTranslate(lang, k);
  return (
    <LangContext.Provider value={lang}>
      <ToastProvider closeLabel={t('common.close')}>
        <Shell onLang={setLang} />
      </ToastProvider>
    </LangContext.Provider>
  );
}

/** Snapshot of the open project (one 16:9 video per project), reloaded when the project changes on disk. */
function useProjectSnapshot(dir: string | null): ProjectSnapshot | null {
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    if (!dir) return setSnap(null);
    const main = await api.invoke('project:snapshot', dir, 'main').catch(() => null);
    if (my === seq.current) setSnap(main);
  }, [dir]);
  useEffect(() => {
    setSnap(null);
    void load();
    let timer = 0;
    const off = api.on('project:changed', (d) => {
      if (d !== dir) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 500);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [dir, load]);
  return snap;
}

function Shell({ onLang }: { onLang: (l: Lang) => void }) {
  const t = useST();
  const pushToast = useToast();
  const toast = useCallback((m: string) => pushToast({ message: m }), [pushToast]);
  const layout = useLayout();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [screen, setScreenRaw] = useState<Screen>('home');
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [rec, setRec] = useState<RecStatus>(recorder.get());
  const [publishTab, setPublishTab] = useState<'publish' | 'thumbnails'>('publish');
  const [palette, setPalette] = useState<null | { query: string }>(null);
  const [prompts, setPrompts] = useState<PromptButton[]>([]);
  const [onboarding, setOnboarding] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSectionId; nonce: number } | null>(null);
  const recording = rec.state !== 'idle';
  const snapshot = useProjectSnapshot(project?.dir ?? null);
  const lastScreen = useRef<Screen>('home');
  useTick(rec.state === 'recording');

  const setScreen = useCallback((s: Screen) => {
    setScreenRaw((cur) => {
      if (cur !== s) lastScreen.current = cur;
      return s;
    });
    if (s === 'publish' || s === 'thumbnails') setPublishTab(s);
  }, []);

  const loadInfo = useCallback(async () => {
    const i = await api.invoke('app:info');
    setInfo(i);
    onLang(i.language);
    setShortcutPlatform(i.os === 'mac');
  }, [onLang]);

  const [recentLoaded, setRecentLoaded] = useState(false);
  const loadRecent = useCallback(async () => {
    const r = await api.invoke('project:recent').catch(() => [] as RecentProject[]);
    setRecent(r);
    setRecentLoaded(true);
    return r;
  }, []);

  useEffect(() => {
    void loadInfo();
    void loadRecent();
    api.send('renderer:ready');
    const off1 = api.on('settings:changed', () => void loadInfo());
    // main's menu / screenshot capture navigates; an explicit navigation also closes the first-run flow
    const off2 = api.on('app:navigate', (s) => {
      setOnboarding(s === 'onboarding');
      if (s === 'palette') return setPalette({ query: '' });
      setPalette(null);
      const sc = parseScreen(s);
      if (sc) setScreen(sc);
    });
    const off3 = recorder.subscribe(setRec);
    // screens ask for a screen change without a prop chain (Home after creating a video: 'record')
    const onNavigate = (e: Event) => {
      const sc = parseNavigateDetail((e as CustomEvent<unknown>).detail);
      if (!sc) return;
      setPalette(null);
      setScreen(sc);
    };
    window.addEventListener('solocut:navigate', onNavigate);
    return () => {
      off1();
      off2();
      off3();
      window.removeEventListener('solocut:navigate', onNavigate);
    };
  }, [loadInfo, loadRecent, setScreen]);

  useEffect(() => onFailoverNotice((message) => pushToast({ tone: 'info', message, duration: 8000 })), [pushToast]);

  // first run: decide once both settings.json and the recent list are known
  const settings = useStore(settingsStore);
  const onboardingChecked = useRef(false);
  useEffect(() => {
    if (onboardingChecked.current || !settings.loaded || !recentLoaded) return;
    onboardingChecked.current = true;
    const completedAt = getPath(settings.json, 'onboarding.completedAt');
    if (shouldShowOnboarding({ completedAt, storage: globalThis.localStorage ?? null, recentCount: recent.length })) setOnboarding(true);
  }, [settings, recentLoaded, recent.length]);

  // panels: settings.json ui.layout is the source of truth (hydrate on change, save user changes, debounced)
  useEffect(() => {
    let timer = 0;
    let pending = false;
    layoutStore.setPersist((s) => {
      pending = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        pending = false;
        void setSetting('ui.layout', layoutToSettings(s));
      }, 400);
    });
    const apply = () => {
      const st = settingsStore.get();
      const v = st.loaded && st.json ? getPath(st.json, 'ui.layout') : undefined;
      if (v !== undefined && !pending) layoutStore.hydrate(v);
    };
    apply();
    const off = settingsStore.subscribe(apply);
    return () => {
      off();
      window.clearTimeout(timer);
      layoutStore.setPersist(null);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = info?.language ?? 'ja';
  }, [info?.language]);

  useEffect(() => {
    api.send('project:watch', project?.dir ?? null);
    void api
      .invoke('prompts:list', project?.dir)
      .then(setPrompts)
      .catch(() => setPrompts([]));
  }, [project?.dir]);

  // resolves after the screen is set, so a caller can navigate on afterwards (Home: new video → 'record')
  const openProject = useCallback(
    async (dir: string, target: Screen = 'workspace') => {
      try {
        const p = await api.invoke('project:open', dir);
        setProject(p);
        setScreen(target);
        void loadRecent();
      } catch (e) {
        pushToast({ tone: 'danger', message: errMsg(e) });
      }
    },
    [pushToast, setScreen, loadRecent],
  );
  useEffect(() => api.on('project:openRequest', (dir) => void openProject(dir)), [openProject]);

  const openFolder = useCallback(async () => {
    const d = await api.invoke('app:chooseFolder', t('projectMenu.openFolder'));
    if (d) void openProject(d);
  }, [openProject, t]);

  const newProject = useCallback(() => {
    setScreen('home');
    // Home owns the form; focus its title field once it is shown
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.home-new-title')?.focus());
  }, [setScreen]);

  const openSettings = useCallback(
    (section?: SettingsSectionId) => {
      setScreen('settings');
      if (section) setSettingsFocus({ section, nonce: Date.now() });
    },
    [setScreen],
  );

  // Record button: stop when recording; otherwise go to the record screen, and start when already there.
  const onRecord = useCallback(() => {
    if (recording || screen === 'record') {
      if (screen !== 'record') setScreen('record');
      window.dispatchEvent(new CustomEvent('solocut:record-toggle'));
      return;
    }
    setScreen('record');
  }, [recording, screen, setScreen]);

  // 撮影 without an open video shows Home (make or open one first)
  const hasProject = project !== null;
  const onMode = useCallback((m: Mode) => setScreen(screenForMode(m, publishTab, hasProject)), [setScreen, publishTab, hasProject]);

  // same flow as the prompt bar under the terminal: main picks the project's agent terminal, or one is opened
  const sendPrompt = useCallback(
    async (p: PromptButton) => {
      try {
        const r = await api.invoke('prompts:render', p.id, project?.dir, {});
        const agent = r.agent ?? p.agent;
        const pick = agent && agent !== 'default' ? agent : null;
        if (project) setScreen('workspace');
        const res = await sendToAgent({ text: r.text, agent: pick, projectDir: project?.dir ?? null }, { launch: pick });
        pushToast(res.ok ? { tone: 'success', message: t('quick.sent', { prompt: p.label, tab: res.tabId ?? pick ?? '' }) } : { tone: 'warning', message: res.message });
      } catch (e) {
        pushToast({ tone: 'danger', message: errMsg(e) });
      }
    },
    [project, pushToast, setScreen, t],
  );

  // keyboard shortcuts (Ferret-compatible where the action exists in both apps)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const id = shortcutFor(e);
      if (!id) return;
      e.preventDefault();
      switch (id) {
        case 'quickOpen':
          return setPalette({ query: '' });
        case 'commandPalette':
          return setPalette({ query: '>' });
        case 'settings':
          return openSettings();
        case 'newProject':
          return newProject();
        case 'openProject':
          return void openFolder();
        case 'toggleSidebar':
          return layoutStore.toggle('sidebar');
        case 'toggleCenter':
          return layoutStore.toggle('center');
        case 'toggleTerminal':
          return layoutStore.toggle('terminal');
        case 'record':
          return onRecord();
        case 'modeRecord':
          return onMode('record');
        case 'modeEdit':
          return project && onMode('edit');
        case 'modePublish':
          return project && onMode('publish');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSettings, newProject, openFolder, onRecord, onMode, project]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const r of recent) {
      if (!r.exists) continue;
      items.push({ id: r.dir, kind: 'project', label: r.title, keywords: r.dir, hint: r.dir, run: () => void openProject(r.dir) });
    }
    // one startup prompt (動画を完成させて); posting goes through the Publish screen's OK button
    for (const p of prompts.filter((x) => x.id === 'finish')) items.push({ id: p.id, kind: 'prompt', label: p.label, keywords: `${p.id} prompt プロンプト`, hint: p.agent && p.agent !== 'default' ? `→ ${p.agent}` : undefined, run: () => void sendPrompt(p) });
    const screens: { s: Screen; key: Parameters<typeof t>[0] }[] = [
      { s: 'home', key: 'nav.home' },
      { s: 'record', key: 'mode.record' },
      { s: 'workspace', key: 'mode.edit' },
      { s: 'publish', key: 'mode.publish' },
      { s: 'thumbnails', key: 'nav.thumbnails' },
      { s: 'library', key: 'nav.library' },
      { s: 'settings', key: 'common.settings' },
    ];
    for (const { s, key } of screens) {
      if (needsProject(s) && !project) continue;
      items.push({ id: s, kind: 'screen', label: t(key), keywords: s, run: () => setScreen(s) });
    }
    for (const id of SETTINGS_SECTIONS) {
      items.push({ id, kind: 'setting', label: `${t('common.settings')}: ${t(`settings.section.${id}`)}`, keywords: id, run: () => openSettings(id) });
    }
    items.push({ id: 'new', kind: 'action', label: t('projectMenu.new'), hint: shortcutLabel('newProject'), run: newProject });
    items.push({ id: 'open', kind: 'action', label: t('projectMenu.openFolder'), hint: shortcutLabel('openProject'), run: () => void openFolder() });
    items.push({ id: 'onboarding', kind: 'action', label: t('settings.about.onboarding'), run: () => setOnboarding(true) });
    return items;
  }, [recent, prompts, project, openProject, sendPrompt, setScreen, openSettings, newProject, openFolder, t]);

  const mode = activeMode(screen, hasProject);
  const wsVisible = screen === 'workspace';
  const recordLabel = rec.state === 'recording' ? `${t('record.buttonStop')} ${formatElapsed(performance.now() - (rec.startedAtMs ?? performance.now()))}` : rec.state === 'stopping' ? t('record.stopping') : t('record.button');
  const shellStyle = { '--sidebar-w': `${layout.sidebarWidth}px` } as CSSProperties;
  const ebText = { title: t('error.title'), description: t('error.description'), retry: t('error.retry'), reload: t('error.reload') };

  return (
    <div className={`app platform-${info?.os ?? 'mac'}`} style={shellStyle}>
      <TitleBar
        project={project}
        recent={recent}
        mode={mode}
        recording={recording}
        recordLabel={recordLabel}
        recordDisabled={rec.state === 'stopping' || (!project && !recording)}
        onOpenProject={(d) => void openProject(d)}
        onOpenFolder={() => void openFolder()}
        onNewProject={newProject}
        onRefreshRecent={() => void loadRecent()}
        onMode={onMode}
        onRecord={onRecord}
        onHome={() => setScreen('home')}
      />
      <div className={`app-body${layout.sidebar ? '' : ' no-sidebar'}`}>
        {layout.sidebar && (
          <ErrorBoundary name="sidebar" text={ebText}>
            <Sidebar
              screen={screen}
              project={project}
              recent={recent}
              snapshot={snapshot}
              onNavigate={setScreen}
              onMode={onMode}
              onOpenProject={(d) => void openProject(d)}
              onNewProject={newProject}
              onOpenFolder={() => void openFolder()}
              onRefreshRecent={() => void loadRecent()}
            />
          </ErrorBoundary>
        )}
        {layout.sidebar && <SidebarSplitter />}
        <main className="main">
          {(screen === 'publish' || screen === 'thumbnails') && project && (
            <PaneTabs
              value={screen}
              onChange={setScreen}
              tabs={[
                { id: 'publish', label: t('nav.publish') },
                { id: 'thumbnails', label: t('nav.thumbnails') },
              ]}
            />
          )}
          <div className="main__screens">
            <ErrorBoundary name="screens" text={ebText}>
              <div className={`screen ${screen === 'home' ? '' : 'hidden'}`}>
                <Home info={info} onOpen={(d) => openProject(d)} onCreated={() => setScreen('record')} toast={toast} />
              </div>
              {/* Workspace stays mounted so terminals keep running while other screens are shown */}
              <div className={`screen ${wsVisible ? '' : 'hidden'}`}>
                <Workspace
                  project={project}
                  visible={wsVisible}
                  toast={toast}
                  onRecord={() => setScreen('record')}
                  showTerminal={layout.terminal}
                  showCenter={layout.center}
                  embedded
                />
              </div>
              <div className={`screen ${screen === 'record' ? '' : 'hidden'}`}>
                <Record project={project} info={info} visible={screen === 'record'} toast={toast} onIngested={() => setScreen('workspace')} />
              </div>
              {screen === 'thumbnails' && (
                <div className="screen">
                  <Thumbnails project={project} toast={toast} />
                </div>
              )}
              {screen === 'publish' && (
                <div className="screen">
                  <Publish project={project} toast={toast} onOpenSettings={() => openSettings('accounts')} />
                </div>
              )}
              {screen === 'library' && (
                <div className="screen">
                  <Library
                    info={info}
                    toast={toast}
                    onRunInTerminal={(cmd) => {
                      window.dispatchEvent(new CustomEvent('solocut:run-in-terminal', { detail: cmd }));
                      setScreen('workspace');
                    }}
                  />
                </div>
              )}
              {screen === 'settings' && (
                <div className="screen screen--fill">
                  <SettingsPage info={info} focus={settingsFocus} onShowOnboarding={() => setOnboarding(true)} />
                </div>
              )}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <StatusBar
        info={info}
        snapshot={snapshot}
        recording={recording}
        recStartedAtMs={rec.startedAtMs}
        onOpenSettings={openSettings}
        onOpenLibrary={() => setScreen('library')}
        onOpenEdit={() => setScreen('workspace')}
      />
      <AccountLoginDialog />
      {palette && <QuickOpen items={paletteItems} initialQuery={palette.query} onClose={() => setPalette(null)} />}
      {onboarding && (
        <OnboardingFlow
          onClose={(how) => {
            markOnboarding(globalThis.localStorage ?? null, how);
            void setSetting('onboarding.completedAt', new Date().toISOString());
            setOnboarding(false);
          }}
          onNewProject={newProject}
          onOpenFolder={() => void openFolder()}
        />
      )}
    </div>
  );
}

/** Re-render every second while `on` (the elapsed time on the record button). */
function useTick(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => set((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [on]);
}

/** Drag the sidebar's right edge to resize it (width kept in the layout store). */
function SidebarSplitter() {
  const t = useST();
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = layoutStore.get().sidebarWidth;
    const move = (ev: PointerEvent) => layoutStore.setSidebarWidth(startW + ev.clientX - startX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing');
    };
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="sidebar-splitter" role="separator" aria-orientation="vertical" aria-label={t('layout.resizeSidebar')} onPointerDown={start} onDoubleClick={() => layoutStore.setSidebarWidth(240)} />;
}
