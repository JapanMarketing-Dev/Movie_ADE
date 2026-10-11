// YouTube / TikTok rows for Settings → アカウント: one button connects (system browser consent), one disconnects.
// The OAuth clients are built into Solocut; when one is not (yet), the row says so instead of failing.
import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Link2, Link2Off } from 'lucide-react';
import { Button } from '../ui';
import type { PublishAccounts as Accounts, PublishTargetId } from '@shared/publish';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';

const ROWS: { id: PublishTargetId; label: string }[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
];

export function PublishAccounts({ toast }: { toast?: (m: string) => void }) {
  const t = useT();
  const [acc, setAcc] = useState<Accounts | null>(null);
  const [busy, setBusy] = useState<PublishTargetId | null>(null);
  const [err, setErr] = useState<Partial<Record<PublishTargetId, string>>>({});

  const refresh = () => void api.invoke('publish:accounts').then(setAcc);
  useEffect(refresh, []);

  const run = async (id: PublishTargetId, connect: boolean) => {
    setBusy(id);
    setErr((e) => ({ ...e, [id]: undefined }));
    try {
      if (connect) {
        const r = await api.invoke('publish:connect', id);
        if (!r.ok) {
          setErr((e) => ({ ...e, [id]: r.error ?? '' }));
          toast?.(`${t('pub.connectFailed')}: ${r.error ?? ''}`);
        }
      } else await api.invoke('publish:disconnect', id);
    } catch (e) {
      toast?.(errMsg(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <div className="pub-accounts" data-testid="publish-accounts">
      {ROWS.map(({ id, label }) => {
        const a = acc?.[id];
        return (
          <div key={id} className="pub-accounts__row" data-target={id}>
            <div className="pub-accounts__main">
              <strong>{label}</strong>
              <span className="dim pub-accounts__state">
                {!a
                  ? '…'
                  : a.connected
                    ? (
                      <>
                        <CheckCircle2 size={12} /> {a.name ?? t('pub.connected')}
                      </>
                    )
                    : a.configured
                      ? t('pub.notConnected')
                      : id === 'tiktok'
                        ? t('pub.ttPreparing')
                        : t('pub.ytNoClient')}
              </span>
              {id === 'tiktok' && a?.connected && <span className="dim pub-accounts__note">{a.directPost ? t('pub.ttDirect') : t('pub.ttInboxNote')}</span>}
              {err[id] && <span className="error pub-accounts__note">{err[id]}</span>}
            </div>
            {a?.connected ? (
              <Button size="sm" variant="ghost" icon={<Link2Off size={13} />} busy={busy === id} onClick={() => void run(id, false)}>
                {t('pub.disconnect')}
              </Button>
            ) : a?.configured ? (
              <Button size="sm" variant="primary" icon={<Link2 size={13} />} busy={busy === id} onClick={() => void run(id, true)}>
                {t('pub.connectTo', { target: label })}
              </Button>
            ) : id === 'tiktok' ? (
              <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => void api.invoke('app:openExternal', 'https://www.tiktok.com/tiktokstudio/upload')}>
                {t('pub.ttOpen')}
              </Button>
            ) : (
              <Button size="sm" disabled title={t('pub.ytNoClient')}>
                {t('pub.connectTo', { target: label })}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
