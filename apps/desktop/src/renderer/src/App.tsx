import { useCallback, useEffect, useState } from 'react';
import { Archive, Clapperboard, Home as HomeIcon, Package, Settings as SettingsIcon, Video } from 'lucide-react';
import type { AppInfo, Lang, ProjectInfo } from '@shared/types';
import { LangContext, translate, type TKey } from './i18n';
import { api, errMsg } from './lib/api';
import { recorder } from './lib/recorder';
import iconUrl from './assets/icon.svg';
import { Home } from './screens/Home';
import { Workspace } from './screens/Workspace';
import { Record } from './screens/Record';
import { ArchiveScreen } from './screens/Archive';
import { Library } from './screens/Library';
import { Settings } from './screens/Settings';
import { UpdatePill } from './components/UpdatePill';
import { Toast, useToast } from './components/Toast';

export type Screen = 'home' | 'workspace' | 'record' | 'archive' | 'library' | 'settings';

const NAV: { id: Screen; icon: typeof HomeIcon; key: TKey }[] = [
  { id: 'home', icon: HomeIcon, key: 'nav.home' },
  { id: 'workspace', icon: Clapperboard, key: 'nav.workspace' },
  { id: 'record', icon: Video, key: 'nav.record' },
  { id: 'archive', icon: Archive, key: 'nav.archive' },
  { id: 'library', icon: Package, key: 'nav.library' },
];

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [lang, setLang] = useState<Lang>('ja');
  const [screen, setScreen] = useState<Screen>('home');
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const toast = useToast();

  const loadInfo = useCallback(async () => {
    const i = await api.invoke('app:info');
    setInfo(i);
    setLang(i.language);
  }, []);

  useEffect(() => {
    void loadInfo();
    api.send('renderer:ready');
    const off1 = api.on('settings:changed', () => void loadInfo());
    const off2 = api.on('app:navigate', (s) => setScreen(s as Screen));
    const off3 = recorder.subscribe((s) => setRecording(s.state !== 'idle'));
    return () => {
      off1();
      off2();
      off3();
    };
  }, [loadInfo]);


  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    api.send('project:watch', project?.dir ?? null);
  }, [project?.dir]);

  const openProject = useCallback(
    async (dir: string) => {
      try {
        const p = await api.invoke('project:open', dir);
        setProject(p);
        setScreen('workspace');
      } catch (e) {
        toast.show(errMsg(e));
      }
    },
    [toast],
  );

  useEffect(() => api.on('project:openRequest', (dir) => void openProject(dir)), [openProject]);

  const t = (k: TKey) => translate(lang, k);

  return (
    <LangContext.Provider value={lang}>
      <div className={`app platform-${info?.os ?? 'mac'}`}>
        <nav className="rail">
          <img className="logo" src={iconUrl} alt="Solocut" />
          {NAV.map(({ id, icon: Icon, key }) => (
            <button key={id} className={screen === id ? 'active' : ''} title={t(key)} onClick={() => setScreen(id)}>
              <Icon size={20} strokeWidth={1.7} />
              {id === 'record' && recording && <span className="rec-dot" />}
            </button>
          ))}
          <div className="spacer" />
          <button className={screen === 'settings' ? 'active' : ''} title={t('nav.settings')} onClick={() => setScreen('settings')}>
            <SettingsIcon size={20} strokeWidth={1.7} />
          </button>
        </nav>
        <main className="main">
          <div className={`screen ${screen === 'home' ? '' : 'hidden'}`}>
            <Home info={info} onOpen={openProject} toast={toast.show} />
          </div>
          {/* Workspace stays mounted so terminals keep running while other screens are shown */}
          <div className={`screen ${screen === 'workspace' ? '' : 'hidden'}`}>
            <Workspace project={project} visible={screen === 'workspace'} toast={toast.show} onRecord={() => setScreen('record')} />
          </div>
          <div className={`screen ${screen === 'record' ? '' : 'hidden'}`}>
            <Record project={project} info={info} visible={screen === 'record'} toast={toast.show} />
          </div>
          {screen === 'archive' && (
            <div className="screen">
              <ArchiveScreen project={project} toast={toast.show} />
            </div>
          )}
          {screen === 'library' && (
            <div className="screen">
              <Library info={info} toast={toast.show} onRunInTerminal={(cmd) => {
                window.dispatchEvent(new CustomEvent('solocut:run-in-terminal', { detail: cmd }));
                setScreen('workspace');
              }} />
            </div>
          )}
          {screen === 'settings' && (
            <div className="screen">
              <Settings info={info} toast={toast.show} onSaved={loadInfo} />
            </div>
          )}
        </main>
        <UpdatePill />
        <Toast msg={toast.msg} />
      </div>
    </LangContext.Provider>
  );
}
