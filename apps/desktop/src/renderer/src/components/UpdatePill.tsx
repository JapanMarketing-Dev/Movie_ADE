import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { UpdateState } from '@shared/types';
import { api } from '../lib/api';
import { useT } from '../i18n';

export function UpdatePill() {
  const t = useT();
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    void api.invoke('update:state').then(setS);
    return api.on('update:state', setS);
  }, []);
  if (!s) return null;
  if (s.status === 'ready') {
    return (
      <button className="update-pill" onClick={() => void api.invoke('update:restart')} title={s.notes ?? ''}>
        <RefreshCw size={14} /> {t('upd.ready')} ({s.latest})
      </button>
    );
  }
  if (s.status === 'downloading') {
    return (
      <div className="update-pill quiet">
        {t('upd.downloading')} {Math.round((s.progress ?? 0) * 100)}%
      </div>
    );
  }
  if (s.status === 'notify-only') {
    return (
      <button className="update-pill quiet" onClick={() => void api.invoke('app:openExternal', 'https://solocut.app/download')}>
        {t('upd.notify')} ({s.latest})
      </button>
    );
  }
  return null;
}
