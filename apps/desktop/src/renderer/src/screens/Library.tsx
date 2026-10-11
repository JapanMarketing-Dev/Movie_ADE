import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, TerminalSquare } from 'lucide-react';
import type { AgentStatus, AppInfo, ToolState } from '@shared/types';
import { useT } from '../i18n';
import { api } from '../lib/api';

export function Library({ toast, onRunInTerminal }: { info: AppInfo | null; toast: (m: string) => void; onRunInTerminal: (cmd: string) => void }) {
  const t = useT();
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

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('lib.title')}</h1>
        <button className="btn ghost small" onClick={() => void load()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <h2>{t('lib.tools')}</h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <tbody>
            {tools === null && (
              <tr>
                <td className="dim">{t('common.loading')}</td>
              </tr>
            )}
            {tools?.map((tool) => (
              <tr key={tool.name}>
                <td style={{ width: 160 }}>
                  <strong>{tool.name}</strong>
                </td>
                <td>{tool.installed ? <span className="pill okp">{t('lib.installed')}</span> : <span className="pill warnp">{t('lib.missing')}</span>}</td>
                <td className="mono dim">{tool.version ?? ''}</td>
                <td className="mono dim" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tool.path}>
                  {tool.path ?? ''}
                </td>
                <td style={{ width: 150, textAlign: 'right' }}>
                  {tool.name in progress ? (
                    <div className="progress" style={{ marginLeft: 'auto' }}>
                      <div style={{ width: `${(progress[tool.name] ?? 0.05) * 100}%` }} />
                    </div>
                  ) : (
                    !tool.installed && (
                      <button className="btn small" onClick={() => void install(tool.name)}>
                        <Download size={13} /> {t('lib.install')}
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>{t('lib.agents')}</h2>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <tbody>
            {agents === null && (
              <tr>
                <td className="dim">{t('common.loading')}</td>
              </tr>
            )}
            {agents?.map((a) => (
              <tr key={a.id}>
                <td style={{ width: 160 }}>
                  <strong>{a.label}</strong>
                  <div className="dim mono">{a.command}</div>
                </td>
                <td>{a.installed ? <span className="pill okp">{t('lib.installed')}</span> : <span className="pill warnp">{t('lib.missing')}</span>}</td>
                <td className="mono dim">{a.version ?? ''}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>
                  {a.installed ? (a.update ?? '') : a.install}
                </td>
                <td style={{ width: 150, textAlign: 'right' }}>
                  {a.installed && a.update && (
                    <button className="btn small" title={t('lib.runInTerminal')} onClick={() => onRunInTerminal(a.update!)}>
                      <TerminalSquare size={13} /> {t('lib.update')}
                    </button>
                  )}
                  {!a.installed && (
                    <button className="btn small" title={t('lib.runInTerminal')} onClick={() => onRunInTerminal(a.install)}>
                      <TerminalSquare size={13} /> {t('lib.installCmd')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
