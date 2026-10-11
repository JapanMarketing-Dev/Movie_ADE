import { Clock, Download, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { updatePill } from '../shell/format';
import { useST } from '../shell/i18n';
import { updateStore, useStore } from '../shell/stores';

/**
 * Footer update pill. Updates are automatic (main/update: check on start and periodically, download and verify in
 * the background, install on quit, restart by itself when the user is away and nothing runs); this only shows the
 * progress and offers "restart to update" without blocking anything. Pressed while recording or while an agent works,
 * the restart is scheduled and happens when that ends.
 */
export function UpdatePill() {
  const t = useST();
  const pill = updatePill(useStore(updateStore));
  if (!pill) return null;
  if (pill.kind === 'downloading') {
    return (
      <span className="statusbar__item" title={t('status.update.downloading', { version: pill.version, percent: String(pill.progress) })}>
        <Download size={12} strokeWidth={2} aria-hidden="true" />
        <span className="statusbar__value">{pill.progress}%</span>
      </span>
    );
  }
  if (pill.kind === 'waiting') {
    const title = t(pill.reason === 'recording' ? 'upd.pill.waitRecordingTitle' : 'upd.pill.waitAgentTitle', { version: pill.version });
    return (
      <button type="button" className="statusbar__btn statusbar__update-wait" onClick={() => void api.invoke('update:restart')} title={title} data-testid="update-pill">
        <Clock size={12} strokeWidth={2} aria-hidden="true" />
        <span>{pill.requested ? t('upd.pill.requested') : t(pill.reason === 'recording' ? 'upd.pill.waitRecording' : 'upd.pill.waitAgent')}</span>
      </button>
    );
  }
  if (pill.kind === 'ready') {
    return (
      <button type="button" className="statusbar__btn statusbar__update-ready" onClick={() => void api.invoke('update:restart')} title={t('upd.pill.restartTitle', { version: pill.version })} data-testid="update-pill">
        <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
        <span>{t('upd.pill.restart')}</span>
      </button>
    );
  }
  return null;
}
