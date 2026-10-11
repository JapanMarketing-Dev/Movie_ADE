import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus, SquareTerminal, X } from 'lucide-react';
import type { AgentStatus } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';
import { terminals, type Tab } from '../lib/terminals';

function useTabs(): { tabs: Tab[]; activeId: string | null } {
  const snap = useSyncExternalStore(
    (cb) => terminals.subscribe(cb),
    () => terminals.tabs.map((t) => `${t.id}:${t.activity}:${t.title}`).join('|') + `#${terminals.activeId}`,
  );
  void snap;
  return { tabs: terminals.tabs, activeId: terminals.activeId };
}

export function Terminals({ cwd, visible, toast }: { cwd: string; visible: boolean; toast: (m: string) => void }) {
  const t = useT();
  const { tabs, activeId } = useTabs();
  const host = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);

  useLayoutEffect(() => {
    const h = host.current;
    if (!h) return;
    for (const tab of tabs) {
      terminals.mount(tab, h);
      tab.el.classList.toggle('hidden', tab.id !== activeId);
    }
    if (visible) requestAnimationFrame(() => terminals.fitActive());
  }, [tabs, activeId, visible]);

  useEffect(() => {
    const h = host.current;
    if (!h) return;
    const ro = new ResizeObserver(() => terminals.fitActive());
    ro.observe(h);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onRun = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      void terminals.spawn(cwd, { title: cmd.split(' ')[0] ?? 'shell', command: cmd }).catch((er: unknown) => toast(errMsg(er)));
    };
    window.addEventListener('solocut:run-in-terminal', onRun);
    return () => window.removeEventListener('solocut:run-in-terminal', onRun);
  }, [cwd, toast]);

  const openMenu = async () => {
    setMenu((m) => !m);
    if (agents === null) setAgents(await api.invoke('agents:list'));
  };

  const start = async (o: { agentId?: string; typeOnly?: string; title?: string }) => {
    setMenu(false);
    try {
      await terminals.spawn(cwd, o);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const active = tabs.find((x) => x.id === activeId);
  const activityLabel = (a: Tab['activity']) =>
    a === 'working' ? t('term.working') : a === 'waiting' ? t('term.waiting') : a === 'exited' ? t('term.exited') : t('term.starting');

  return (
    <>
      <div className="tabs">
        {tabs.map((tab) => (
          <button key={tab.id} className={`tab ${tab.id === activeId ? 'active' : ''}`} onClick={() => terminals.activate(tab.id)} title={activityLabel(tab.activity)}>
            <span className={`dot ${tab.activity}`} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
            <span
              className="x"
              role="button"
              aria-label={t('term.close')}
              onClick={(e) => {
                e.stopPropagation();
                terminals.close(tab.id);
              }}
            >
              <X size={13} />
            </span>
          </button>
        ))}
        <div style={{ position: 'relative' }}>
          <button className="btn ghost icon small" title={t('term.new')} onClick={() => void openMenu()}>
            <Plus size={16} />
          </button>
          {menu && (
            <div className="menu" style={{ top: 30, left: 0 }} onMouseLeave={() => setMenu(false)}>
              {agents === null && <div className="hint">{t('common.loading')}</div>}
              {agents?.map((a) =>
                a.installed ? (
                  <button key={a.id} onClick={() => void start({ agentId: a.id })}>
                    <span className="dot waiting" /> {a.label}
                    <span className="dim mono" style={{ marginLeft: 'auto' }}>
                      {a.version ?? ''}
                    </span>
                  </button>
                ) : (
                  <div key={a.id}>
                    <button className="disabled" title={t('term.install')} onClick={() => void start({ typeOnly: a.install, title: `install ${a.id}` })}>
                      <span className="dot exited" /> {a.label}
                      <span className="dim" style={{ marginLeft: 'auto' }}>
                        {t('term.notInstalled')}
                      </span>
                    </button>
                    <div className="hint">{a.install}</div>
                  </div>
                ),
              )}
              <div className="sep" />
              <button onClick={() => void start({ title: t('term.shell') })}>
                <SquareTerminal size={14} /> {t('term.shell')}
              </button>
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {active && <span className="dim" style={{ fontSize: 11, paddingRight: 6 }}>{activityLabel(active.activity)}</span>}
      </div>
      <div className="term-host" ref={host}>
        {tabs.length === 0 && (
          <div className="empty" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <div className="row" style={{ flexDirection: 'column', gap: 12 }}>
              <span>{t('term.empty')}</span>
              <button className="btn" onClick={() => void openMenu()}>
                <Plus size={14} /> {t('term.new')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
