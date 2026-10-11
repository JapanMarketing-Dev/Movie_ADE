// Publish (docs/14): one video. The finished video, its thumbnail and what the AI wrote in publish.json; the person
// checks it and presses「OK・投稿する」→ the `publish` prompt goes to the agent, which fixes publish.json if needed and
// runs `solocut publish upload`; the app uploads with its tokens and the result shows up here.
import { useCallback, useContext, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Link2, Send, Sparkles, Upload, XCircle } from 'lucide-react';
import { Badge, Button, EmptyState, Progress } from '../ui';
import {
  YT_DESCRIPTION_MAX_BYTES,
  YT_TITLE_MAX,
  charCount,
  fixRequestText,
  issueText,
  okState,
  utf8Bytes,
  type PublishAccounts,
  type PublishIssue,
  type PublishTargetId,
  type PublishTargetResult,
  type PublishView,
} from '@shared/publish';
import type { ProjectInfo } from '@shared/types';
import { LangContext, useT, type TKey } from '../i18n';
import { api, errMsg } from '../lib/api';
import { sendToAgent } from '../terminal/agentSend';

const TARGET_LABEL: Record<PublishTargetId, string> = { youtube: 'YouTube', tiktok: 'TikTok' };

export function Publish({ project, toast, onOpenSettings }: { project: ProjectInfo | null; toast: (m: string) => void; onOpenSettings: () => void }) {
  const t = useT();
  const lang = useContext(LangContext);
  const dir = project?.dir ?? null;
  const [view, setView] = useState<PublishView | null>(null);
  const [accounts, setAccounts] = useState<PublishAccounts | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [fix, setFix] = useState('');
  const [busy, setBusy] = useState<'ok' | 'fix' | 'connect' | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!dir) return;
    setView(await api.invoke('publish:load', dir));
  }, [dir]);

  useEffect(() => {
    setView(null);
    setSentAt(null);
    void load();
    void api.invoke('publish:accounts').then(setAccounts);
  }, [load]);
  useEffect(() => api.on('publish:changed', (d) => d === dir && void load()), [dir, load]);
  useEffect(() => api.on('project:changed', (d, what) => d === dir && what === 'renders' && void load()), [dir, load]);
  // the "sent" hold expires by itself
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  // the agent started the upload: the hold is over
  useEffect(() => {
    if (view?.result?.state === 'running') setSentAt(null);
  }, [view?.result?.state, view?.result?.id]);

  if (!project || !dir) {
    return (
      <div className="ws">
        <div className="titlebar">
          <span className="title">{t('nav.publish')}</span>
        </div>
        <div className="empty">{t('ws.noProject')}</div>
      </div>
    );
  }

  const send = async (text: string, kind: 'ok' | 'fix', agent: string | null = null) => {
    setBusy(kind);
    try {
      const res = await sendToAgent({ text, agent, projectDir: dir }, { launch: agent });
      if (res.ok && kind === 'ok') setSentAt(Date.now());
      toast(res.ok ? t(kind === 'ok' ? 'pub.sentOk' : 'pub.sentFix') : res.message);
      if (res.ok && kind === 'fix') setFix('');
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const postOk = async () => {
    try {
      const r = await api.invoke('prompts:render', 'publish', dir, {});
      await send(r.text, 'ok', r.agent && r.agent !== 'default' ? r.agent : null);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const connect = async (target: PublishTargetId) => {
    setBusy('connect');
    try {
      const r = await api.invoke('publish:connect', target);
      if (!r.ok) toast(`${t('pub.connectFailed')}: ${r.error ?? ''}`);
      setAccounts(await api.invoke('publish:accounts'));
    } finally {
      setBusy(null);
    }
  };

  const state = okState(view, accounts, sentAt, now);
  const spec = view?.spec ?? null;
  const errors = view?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = view?.issues.filter((i) => i.level === 'warning') ?? [];

  return (
    <div className="ws">
      <div className="titlebar">
        <span className="title">{t('nav.publish')}</span>
        <span className="dim">{project.title}</span>
      </div>
      <div className="pub">
        {!view ? (
          <div className="dim pub__loading">{t('common.loading')}</div>
        ) : !view.exists || !spec ? (
          <EmptyState
            title={view.exists ? t('pub.brokenTitle') : t('pub.noFileTitle')}
            description={view.exists ? view.issues.map((i) => issueText(i, lang)).join(' / ') : t('pub.noFileText')}
            actions={
              <Button variant="primary" icon={<Sparkles size={14} />} busy={busy === 'fix'} onClick={() => void send(view.exists ? fixRequestText('') : t('pub.makeRequest'), 'fix')}>
                {view.exists ? t('pub.askFix') : t('pub.askMake')}
              </Button>
            }
          />
        ) : (
          <div className="pub__body">
            <section className="pub__media">
              {view.videoPath ? (
                <video className="pub__video" src={api.mediaUrl(view.videoPath)} controls preload="metadata" poster={view.thumbnailPath ? api.mediaUrl(view.thumbnailPath) : undefined} />
              ) : (
                <div className="pub__video pub__video--missing">
                  <AlertTriangle size={18} /> {t('pub.noVideo', { path: spec.video })}
                </div>
              )}
              <div className="pub__thumbrow">
                <div className="pub__thumb">{view.thumbnailPath ? <img src={api.mediaUrl(view.thumbnailPath)} alt="" /> : <span className="dim">{t('pub.noThumb')}</span>}</div>
                <div className="pub__thumbmeta">
                  <span className="pub__label">{t('pub.thumbnail')}</span>
                  <span className="mono dim">{spec.thumbnail ?? '—'}</span>
                  <span className="dim pub__hint">{t('pub.thumbHint')}</span>
                </div>
              </div>
              <ResultPanel view={view} />
            </section>

            <section className="pub__side">
              <div className="pub__fields">
                <Field label={t('pub.title')} count={`${charCount(spec.title)}/${YT_TITLE_MAX}`} over={charCount(spec.title) > YT_TITLE_MAX}>
                  <div className="pub__title">{spec.title || <span className="dim">—</span>}</div>
                </Field>
                <Field label={t('pub.description')} count={`${utf8Bytes(spec.description)}/${YT_DESCRIPTION_MAX_BYTES} bytes`} over={utf8Bytes(spec.description) > YT_DESCRIPTION_MAX_BYTES}>
                  <div className="pub__desc">{spec.description || <span className="dim">—</span>}</div>
                </Field>
                <Field label={t('pub.tags')}>
                  <div className="pub__tags">
                    {spec.tags.length ? spec.tags.map((x) => <span key={x} className="pub__tag">#{x}</span>) : <span className="dim">—</span>}
                  </div>
                </Field>
                <TargetRow
                  target="youtube"
                  on={spec.youtube.enabled}
                  account={accounts?.youtube}
                  published={view.published.youtube?.url}
                  detail={[
                    t(`pub.privacy.${spec.youtube.privacy}` as TKey),
                    spec.youtube.publishAt ? t('pub.scheduled', { at: new Date(spec.youtube.publishAt).toLocaleString() }) : '',
                    spec.youtube.madeForKids ? t('pub.forKids') : t('pub.notForKids'),
                    spec.youtube.containsSyntheticMedia ? t('pub.synthetic') : '',
                  ]}
                  onConnect={() => void connect('youtube')}
                  onOpenSettings={onOpenSettings}
                  busy={busy === 'connect'}
                />
                <TargetRow
                  target="tiktok"
                  on={spec.tiktok.enabled}
                  account={accounts?.tiktok}
                  published={view.published.tiktok?.url}
                  detail={[t(`pub.ttPrivacy.${spec.tiktok.privacy}` as TKey), spec.tiktok.isAigc ? t('pub.aigc') : '']}
                  caption={spec.tiktok.enabled ? spec.tiktok.caption : undefined}
                  onConnect={() => void connect('tiktok')}
                  onOpenSettings={onOpenSettings}
                  onManual={() => void api.invoke('publish:openTikTokUpload', dir)}
                  busy={busy === 'connect'}
                />
              </div>

              {(errors.length > 0 || warnings.length > 0) && <Issues errors={errors} warnings={warnings} lang={lang} />}

              <div className="pub__fix">
                <input
                  className="input"
                  type="text"
                  value={fix}
                  placeholder={t('pub.fixPlaceholder')}
                  onChange={(e) => setFix(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(fixRequestText(fix), 'fix');
                  }}
                />
                <Button size="sm" icon={<Sparkles size={13} />} busy={busy === 'fix'} onClick={() => void send(fixRequestText(fix), 'fix')}>
                  {t('pub.askFix')}
                </Button>
              </div>

              <div className="pub__go">
                <OkButton state={state} busy={busy === 'ok'} onOk={() => void postOk()} onConnect={(x) => void connect(x)} />
                {errors.length > 0 && state.kind === 'ready' && <div className="dim pub__hint">{t('pub.okWithIssues')}</div>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, count, over, children }: { label: string; count?: string; over?: boolean; children: React.ReactNode }) {
  return (
    <div className="pub__field">
      <div className="pub__fieldhead">
        <span className="pub__label">{label}</span>
        {count && <span className={`mono pub__count${over ? ' is-over' : ''}`}>{count}</span>}
      </div>
      {children}
    </div>
  );
}

function TargetRow({
  target,
  on,
  account,
  published,
  detail,
  caption,
  onConnect,
  onOpenSettings,
  onManual,
  busy,
}: {
  target: PublishTargetId;
  on: boolean;
  account?: PublishAccounts[PublishTargetId];
  published?: string;
  detail: string[];
  caption?: string;
  onConnect: () => void;
  onOpenSettings: () => void;
  onManual?: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div className={`pub__target${on ? '' : ' is-off'}`} data-target={target}>
      <div className="pub__targethead">
        <strong>{TARGET_LABEL[target]}</strong>
        <Badge tone={on ? 'brand' : 'neutral'}>{on ? t('pub.on') : t('pub.off')}</Badge>
        <span className="grow" />
        {!account ? null : account.connected ? (
          <span className="dim pub__acct" title={t('pub.connected')}>
            <CheckCircle2 size={12} /> {account.name ?? t('pub.connected')}
          </span>
        ) : account.configured ? (
          <Button size="sm" variant="ghost" icon={<Link2 size={13} />} busy={busy} onClick={onConnect}>
            {t('pub.connect')}
          </Button>
        ) : target === 'tiktok' ? (
          <span className="dim pub__acct">{t('pub.ttPreparing')}</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            {t('pub.accountsSettings')}
          </Button>
        )}
      </div>
      {on && <div className="dim pub__detail">{detail.filter(Boolean).join(' · ')}</div>}
      {caption !== undefined && <div className="pub__caption">{caption}</div>}
      {published && (
        <a className="pub__link" href="#" onClick={(e) => (e.preventDefault(), void api.invoke('app:openExternal', published))}>
          <ExternalLink size={12} /> {published}
        </a>
      )}
      {target === 'tiktok' && account && !account.configured && onManual && (
        <Button size="sm" icon={<ExternalLink size={13} />} onClick={onManual}>
          {t('pub.ttManual')}
        </Button>
      )}
    </div>
  );
}

function Issues({ errors, warnings, lang }: { errors: PublishIssue[]; warnings: PublishIssue[]; lang: 'ja' | 'en' }) {
  const t = useT();
  return (
    <div className="pub__issues">
      {errors.length > 0 && (
        <>
          <div className="pub__label">{t('pub.errors', { n: String(errors.length) })}</div>
          <ul>
            {errors.map((i, k) => (
              <li key={`e${k}`} className="is-error">
                <XCircle size={12} /> {issueText(i, lang)}
              </li>
            ))}
          </ul>
        </>
      )}
      {warnings.length > 0 && (
        <details>
          <summary className="pub__label">{t('pub.warnings', { n: String(warnings.length) })}</summary>
          <ul>
            {warnings.map((i, k) => (
              <li key={`w${k}`}>
                <AlertTriangle size={12} /> {issueText(i, lang)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function OkButton({ state, busy, onOk, onConnect }: { state: ReturnType<typeof okState>; busy: boolean; onOk: () => void; onConnect: (t: PublishTargetId) => void }) {
  const t = useT();
  if (state.kind === 'connect')
    return (
      <Button variant="primary" className="pub__ok" icon={<Link2 size={16} />} onClick={() => onConnect(state.target)}>
        {t('pub.connectFirst', { target: TARGET_LABEL[state.target] })}
      </Button>
    );
  const label: Record<typeof state.kind, TKey> = {
    ready: 'pub.ok',
    'no-file': 'pub.ok',
    'no-video': 'pub.okNoVideo',
    'no-target': 'pub.okNoTarget',
    sent: 'pub.okSent',
    running: 'pub.okRunning',
    published: 'pub.okPublished',
  };
  return (
    <Button
      variant="primary"
      className="pub__ok"
      data-testid="publish-ok"
      icon={state.kind === 'sent' || state.kind === 'running' ? <Send size={16} /> : <Upload size={16} />}
      busy={busy || state.kind === 'running'}
      disabled={state.kind !== 'ready'}
      onClick={onOk}
    >
      {t(label[state.kind])}
    </Button>
  );
}

function ResultPanel({ view }: { view: PublishView }) {
  const t = useT();
  const r = view.result;
  if (!r) return null;
  if (r.state === 'running') {
    const p = r.progress;
    return (
      <div className="pub__result">
        <div className="pub__label">{t('pub.uploading', { target: p ? TARGET_LABEL[p.target] : '' })}</div>
        <Progress {...(p?.fraction !== undefined ? { value: p.fraction } : {})} label={t('pub.uploading', { target: '' })} />
        {p?.phase && <div className="dim pub__hint">{p.phase}</div>}
        {r.results.map((x) => (
          <ResultLine key={x.target} r={x} />
        ))}
      </div>
    );
  }
  return (
    <div className="pub__result">
      <div className="pub__label">
        {t('pub.lastResult')} <span className="dim">{r.at ? new Date(r.at).toLocaleString() : ''}</span>
      </div>
      {r.error && <div className="pub__err">{r.error}</div>}
      {r.results.map((x) => (
        <ResultLine key={x.target} r={x} />
      ))}
    </div>
  );
}

function ResultLine({ r }: { r: PublishTargetResult }) {
  const t = useT();
  return (
    <div className={`pub__resline${r.ok ? ' is-ok' : ' is-fail'}`}>
      {r.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
      <strong>{TARGET_LABEL[r.target]}</strong>
      <span>{r.ok ? (r.alreadyPublished ? t('pub.already') : r.status === 'inbox' ? t('pub.inbox') : r.status === 'scheduled' ? t('pub.scheduledDone') : t('pub.posted')) : t('pub.failed')}</span>
      {r.url && (
        <a href="#" onClick={(e) => (e.preventDefault(), void api.invoke('app:openExternal', r.url!))}>
          {r.url}
        </a>
      )}
      {r.error && <span className="pub__err">{r.error}</span>}
      {r.warnings?.map((w) => (
        <span key={w} className="dim pub__hint">
          {w}
        </span>
      ))}
    </div>
  );
}
