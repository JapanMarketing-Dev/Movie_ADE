import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Download, RefreshCw, TerminalSquare, Wrench } from 'lucide-react';
import { Badge, Button, IconTile, Progress, Skeleton } from '../ui';
import { useST } from '../shell/i18n';
import type { AgentStatus, AppInfo, ToolState } from '@shared/types';
import { useT } from '../i18n';
import { api } from '../lib/api';

export function Library({ toast, onRunInTerminal }: { info: AppInfo | null; toast: (m: string) => void; onRunInTerminal: (cmd: string) => void }) {
  const t = useT();
  const st = useST();
  const [tools, setTools] = useState<ToolState[] | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [progress, setProgress] = useState<Record<string, number | null>>({});

  const load = useCallback(async () => {
    setTools(null);
    setAgents(null);
    const [a, b] = await Promise.all([api.invoke('tools:status'), api.invoke('agents:list')]);
    setTools(a);
    setAgents(b);
  }, []);

  useEffect(() => {
    void load();
    return api.on('tools:progress', (name, received, total) => setProgress((p) => ({ ...p, [name]: total ? received / total : null })));
  }, [load]);

  const install = async (name: string) => {
    setProgress((p) => ({ ...p, [name]: 0 }));
    const r = await api.invoke('tools:install', name);
    setProgress((p) => {
      const n = { ...p };
      delete n[name];
      return n;
    });
    if (!r.ok) toast(r.error ?? t('common.error'));
    void load();
  };

  const missing = tools?.filter((x) => !x.installed).length ?? 0;
  return (
    <div className="page lib">
      <header className="lib__head">
        <div>
          <h1>{t('lib.title')}</h1>
          <p className="lib__sub">{st('lib.sub')}</p>
        </div>
        <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()}>
          {st('common.refresh')}
        </Button>
      </header>

      <section className="lib__section">
        <div className="lib__section-head">
          <h2 className="lib__h">{t('lib.tools')}</h2>
          {tools && (missing === 0 ? <Badge tone="success">{st('lib.allInstalled')}</Badge> : <Badge tone="warning">{st('lib.missingN', { n: String(missing) })}</Badge>)}
        </div>
        <div className="lib__list">
          {tools === null && <Skeleton height={44} />}
          {tools?.map((tool) => (
            <div key={tool.name} className={`lib__row${tool.installed ? '' : ' is-missing'}`}>
              <IconTile>{tool.installed ? <CircleCheck size={15} /> : <Wrench size={15} />}</IconTile>
              <div className="lib__body">
                <span className="lib__name">{tool.name}</span>
                <span className="lib__desc" title={tool.path}>
                  {tool.installed ? (tool.path ?? '') : st('lib.notInstalledDesc')}
                </span>
              </div>
              {tool.version && <code className="lib__ver">{tool.version}</code>}
              {tool.name in progress ? (
                <span className="lib__progress">
                  <Progress {...(progress[tool.name] != null ? { value: progress[tool.name]! } : {})} label={tool.name} />
                </span>
              ) : tool.installed ? (
                <Badge tone="success">{t('lib.installed')}</Badge>
              ) : (
                <Button size="sm" icon={<Download size={13} />} onClick={() => void install(tool.name)}>
                  {t('lib.install')}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="lib__section">
        <div className="lib__section-head">
          <h2 className="lib__h">{t('lib.agents')}</h2>
          <span className="lib__note">{st('lib.agentsNote')}</span>
        </div>
        <div className="lib__list">
          {agents === null && <Skeleton height={44} />}
          {agents?.map((a) => (
            <div key={a.id} className={`lib__row${a.installed ? '' : ' is-missing'}`}>
              <span className={`agent-glyph agent-glyph--lg agent-glyph--${a.id.replace(/[^a-z0-9-]/gi, '')}`} aria-hidden="true">
                {(a.label[0] ?? '?').toUpperCase()}
              </span>
              <div className="lib__body">
                <span className="lib__name lib__name--ui">{a.label}</span>
                <code className="lib__desc">{a.installed ? (a.update ?? a.command) : a.install}</code>
              </div>
              {a.version && <code className="lib__ver">{a.version}</code>}
              {a.installed ? <Badge tone="success">{t('lib.installed')}</Badge> : <Badge tone="warning">{t('lib.missing')}</Badge>}
              {a.installed && a.update && (
                <Button size="sm" variant="ghost" icon={<TerminalSquare size={13} />} title={t('lib.runInTerminal')} onClick={() => onRunInTerminal(a.update!)}>
                  {t('lib.update')}
                </Button>
              )}
              {!a.installed && (
                <Button size="sm" icon={<TerminalSquare size={13} />} title={t('lib.runInTerminal')} onClick={() => onRunInTerminal(a.install)}>
                  {t('lib.installCmd')}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
