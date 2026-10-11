// API keys and the BYO YouTube client, stored by main in the OS keychain (safeStorage). Values are never read
// back into the renderer; only "set" and a masked hint are shown.
import { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import type { SecretInfo } from '@shared/types';
import { useT, type TKey } from '../i18n';
import { api, errMsg } from '../lib/api';

const KEYS: { name: string; key: TKey; env?: string }[] = [
  { name: 'openai', key: 'keys.openai', env: 'SOLOCUT_OPENAI_API_KEY' },
  { name: 'gemini', key: 'keys.gemini', env: 'SOLOCUT_GEMINI_API_KEY' },
  { name: 'decide', key: 'keys.decide', env: 'SOLOCUT_DECIDE_API_KEY' },
  { name: 'typesafe', key: 'keys.typesafe', env: 'SOLOCUT_TYPESAFE_API_KEY' },
  { name: 'youtube.clientId', key: 'keys.ytClientId' },
  { name: 'youtube.clientSecret', key: 'keys.ytClientSecret' },
];

export function ApiKeys({ toast }: { toast: (m: string) => void }) {
  const t = useT();
  const [status, setStatus] = useState<{ persistent: boolean; items: Record<string, SecretInfo> } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = () => void api.invoke('secrets:status').then(setStatus);
  useEffect(load, []);

  const save = async (name: string, value: string | null) => {
    try {
      const r = await api.invoke('secrets:set', name, value);
      setDraft((d) => ({ ...d, [name]: '' }));
      toast(value ? (r.persisted ? t('keys.saved') : t('keys.sessionOnly')) : t('keys.removed'));
      load();
    } catch (e) {
      toast(errMsg(e));
    }
  };

  return (
    <div className="keys">
      <div className="dim" style={{ fontSize: 12 }}>
        {status?.persistent === false ? t('keys.noKeychain') : t('keys.note')}
      </div>
      {KEYS.map((k) => {
        const st = status?.items[k.name];
        return (
          <div key={k.name} className="field">
            <label className="row" style={{ justifyContent: 'space-between' }}>
              <span>{t(k.key)}</span>
              {st?.set ? <span className="pill okp mono">{st.hint}</span> : <span className="dim">{t('keys.notSet')}</span>}
            </label>
            <div className="row">
              <input
                className="input mono"
                style={{ flex: 1 }}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={k.env ?? ''}
                value={draft[k.name] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [k.name]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && draft[k.name] && void save(k.name, draft[k.name]!)}
              />
              <button className="btn small icon" disabled={!draft[k.name]} title={t('set.save')} onClick={() => void save(k.name, draft[k.name]!)}>
                <KeyRound size={13} />
              </button>
              <button className="btn small icon" disabled={!st?.set} title={t('keys.remove')} onClick={() => void save(k.name, null)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
