import { useCallback, useContext, useEffect, useState } from 'react';
import { CheckCheck, FolderOpen, Hash, Mic, Play, RefreshCw, Send, StickyNote, Trash2 } from 'lucide-react';
import type { FeedbackItem, Variant } from '@shared/types';
import { feedbackAgentMessage } from '@shared/feedback';
import { LangContext } from '../../i18n';
import { api, errMsg } from '../../lib/api';
import { sendToAgent } from '../../terminal/agentSend';
import { parseFeedbackList, type FeedbackEntry } from '../../shell/projectItems';
import { useST } from '../../shell/i18n';
import { Badge, Button, EmptyState, IconButton, Spinner, Tooltip, useToast } from '../../ui';
import { findingTitle, itemImagePath, parseFindings, shortTimecode } from './findingsModel';

/**
 * One finding, in the look of Ferret's findings cards (src/renderer/components/ReviewFindings.tsx): the frame with
 * the pen drawing, its number and timecode on the image, the title and request, what was said, the timeline targets
 * and the state. Used in the review mode list and in the check dialog right after a feedback recording.
 */
export function FindingCard({
  item,
  index,
  dir,
  done,
  onRequestChange,
  onDelete,
  onSeek,
}: {
  item: FeedbackItem;
  index: number;
  dir: string;
  done?: boolean;
  onRequestChange?: (request: string) => void;
  onDelete?: () => void;
  onSeek?: (frame: number) => void;
}) {
  const t = useST();
  const title = findingTitle(item);
  return (
    <article className={`finding${done ? ' is-done' : ''}`} data-testid="finding">
      <div className="finding__shot">
        {item.image ? <img src={api.mediaUrl(itemImagePath(dir, item.image))} alt="" loading="lazy" /> : <div className="finding__noshot" />}
        <span className="finding__num">{index + 1}</span>
        <button type="button" className="finding__tc" title={t('fd.seek')} disabled={!onSeek} onClick={() => onSeek?.(item.frame)}>
          {shortTimecode(item.timecode) || item.frame}
        </button>
      </div>
      <div className="finding__head">
        <h3 className="finding__title">{title || t('fd.untitled')}</h3>
        <Badge tone={done ? 'success' : 'brand'}>{t(done ? 'fd.done' : 'fd.open')}</Badge>
      </div>
      {onRequestChange ? (
        <textarea className="finding__request finding__request--edit" rows={2} value={item.request} placeholder={t('fd.requestPlaceholder')} onChange={(e) => onRequestChange(e.target.value)} />
      ) : (
        item.request && item.request !== title && <p className="finding__request">{item.request}</p>
      )}
      {item.spoken && (
        <blockquote className="finding__quote">
          <Mic size={12} aria-hidden="true" />
          <span className="finding__said">{t('fd.said')}</span>「{item.spoken}」
        </blockquote>
      )}
      {item.notes.map((n) => (
        <p key={n} className="finding__note">
          <StickyNote size={12} aria-hidden="true" />
          {n}
        </p>
      ))}
      <footer className="finding__foot">
        {item.targets.map((tg) => (
          <span key={`${tg.kind}:${tg.id}`} className="finding__chip" title={tg.label ?? tg.id}>
            <Hash size={11} aria-hidden="true" />
            {tg.kind} {tg.label ?? tg.id}
          </span>
        ))}
        <span className="finding__spacer" />
        {onSeek && (
          <Tooltip label={t('fd.seek')} side="top">
            <IconButton size="sm" label={t('fd.seek')} icon={<Play size={13} />} onClick={() => onSeek(item.frame)} />
          </Tooltip>
        )}
        {onDelete && (
          <Tooltip label={t('fd.delete')} side="top" align="end">
            <IconButton size="sm" label={t('fd.delete')} icon={<Trash2 size={13} />} onClick={onDelete} />
          </Tooltip>
        )}
      </footer>
    </article>
  );
}

/**
 * Review mode: the feedback sessions of the open project as Ferret-style findings, with "Send to agent" (main pastes
 * into the project's agent terminal, or opens one) and "Mark done". Edits are saved through `feedback:update`.
 */
export function FindingsPanel({ dir, variant, onSeek }: { dir: string; variant: Variant; onSeek: (frame: number) => void }) {
  const t = useST();
  const toast = useToast();
  const lang = useContext(LangContext);
  const [sessions, setSessions] = useState<FeedbackEntry[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'send' | 'save' | 'done' | null>(null);

  const loadSessions = useCallback(async () => {
    const r = await api.invoke('project:cli', dir, ['feedback', 'list']).catch(() => null);
    const list = r?.ok ? parseFeedbackList(r.data) : [];
    setSessions(list);
    setSel((cur) => (cur && list.some((x) => x.id === cur) ? cur : (list[0]?.id ?? null)));
  }, [dir]);

  const loadItems = useCallback(async () => {
    if (!sel) return setItems([]);
    const r = await api.invoke('project:cli', dir, ['feedback', 'show', sel]).catch(() => null);
    setItems(r?.ok ? parseFindings(r.data) : []);
    setDirty(false);
  }, [dir, sel]);

  useEffect(() => {
    void loadSessions();
    let timer = 0;
    const off = api.on('project:changed', (d) => {
      if (d !== dir) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadSessions(), 600);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [dir, loadSessions]);
  useEffect(() => {
    setItems(null);
    void loadItems();
  }, [loadItems]);

  const session = sessions?.find((s) => s.id === sel) ?? null;
  const done = session?.status === 'done';

  const save = async (): Promise<boolean> => {
    if (!dirty || !sel || !items) return true;
    setBusy('save');
    try {
      const r = await api.invoke('feedback:update', dir, sel, items, variant);
      if (!r.ok) {
        toast({ tone: 'danger', message: t('fd.saveFailed'), detail: r.error });
        return false;
      }
      if (r.data) setItems(r.data.items);
      setDirty(false);
      toast({ tone: 'success', message: t('fd.saved') });
      return true;
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!sel || !(await save())) return;
    setBusy('send');
    try {
      const res = await sendToAgent({ text: feedbackAgentMessage(`feedback/${sel}`, lang), projectDir: dir }, { launch: null });
      if (res.ok) toast({ tone: 'success', message: t('fd.sent'), detail: res.submitted === false ? t('fd.sentPasted') : t('fd.sentDetail') });
      else toast({ tone: res.noAgent ? 'info' : 'warning', message: res.message });
    } catch (e) {
      toast({ tone: 'danger', message: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const markDone = async () => {
    if (!sel) return;
    setBusy('done');
    const r = await api.invoke('project:cli', dir, ['feedback', 'done', sel]).catch((e: unknown) => ({ ok: false, error: errMsg(e) }));
    setBusy(null);
    if (!r.ok) toast({ tone: 'danger', message: r.error ?? t('fd.saveFailed') });
    else {
      toast({ tone: 'success', message: t('fd.markedDone') });
      void loadSessions();
    }
  };

  if (sessions === null) return <div className="findings findings--loading"><Spinner /></div>;
  if (sessions.length === 0) {
    return (
      <div className="findings">
        <EmptyState size="sm" title={t('fd.emptyTitle')} description={t('fd.emptyDesc')} />
      </div>
    );
  }

  const openCount = items?.length ?? 0;
  return (
    <section className="findings" data-testid="findings">
      <header className="findings__head">
        <div className="findings__count">
          <strong>{openCount}</strong>
          <span>{t('fd.findings')}</span>
        </div>
        <div className="findings__meta">
          <span className={`findings__dot${done ? ' is-done' : ''}`} />
          <span>{dirty ? t('fd.unsaved') : t('fd.savedState')}</span>
          <span>·</span>
          <select className="findings__session" value={sel ?? ''} onChange={(e) => setSel(e.target.value)} aria-label={t('fd.session')}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} · {t(s.status === 'open' ? 'fd.open' : 'fd.done')}
              </option>
            ))}
          </select>
        </div>
        <div className="findings__actions">
          <Tooltip label={t('fd.reload')}>
            <IconButton label={t('fd.reload')} icon={<RefreshCw size={14} />} onClick={() => void loadItems()} />
          </Tooltip>
          <Tooltip label={t('fd.openFolder')}>
            <IconButton label={t('fd.openFolder')} icon={<FolderOpen size={14} />} onClick={() => sel && void api.invoke('app:showInFolder', `${dir}/feedback/${sel}`)} />
          </Tooltip>
          {dirty && (
            <Button busy={busy === 'save'} onClick={() => void save()}>
              {t('fd.save')}
            </Button>
          )}
          <Button icon={<CheckCheck size={14} />} busy={busy === 'done'} disabled={done || busy !== null} onClick={() => void markDone()}>
            {t('fd.markDone')}
          </Button>
          <Button variant="primary" icon={<Send size={14} />} busy={busy === 'send'} disabled={!items || items.length === 0 || busy !== null} onClick={() => void send()} data-testid="findings-send">
            {t('fd.send')}
          </Button>
        </div>
        <p className="findings__help">{t('fd.help')}</p>
      </header>
      <div className="findings__list">
        {items === null && <Spinner />}
        {items?.length === 0 && <p className="findings__none">{t('fd.noItems')}</p>}
        {items?.map((it, i) => (
          <FindingCard
            key={`${it.n}-${it.frame}`}
            item={it}
            index={i}
            dir={dir}
            done={done}
            onSeek={onSeek}
            onRequestChange={
              done
                ? undefined
                : (request) => {
                    setItems((xs) => xs?.map((x, k) => (k === i ? { ...x, request } : x)) ?? null);
                    setDirty(true);
                  }
            }
            onDelete={
              done
                ? undefined
                : () => {
                    setItems((xs) => xs?.filter((_, k) => k !== i) ?? null);
                    setDirty(true);
                  }
            }
          />
        ))}
      </div>
    </section>
  );
}
