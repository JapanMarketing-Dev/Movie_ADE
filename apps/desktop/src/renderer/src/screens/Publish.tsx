// Publish (docs/14, docs/18). One take → three posts (YouTube main, TikTok, YouTube Shorts) on one approval screen;
// nothing is posted until the person checks "I reviewed these". Announcements follow once URLs exist.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Link2, Link2Off, Loader2, Upload, XCircle } from 'lucide-react';
import type { ProjectInfo, PublishDraft, PublishTarget, YouTubeForm, YouTubeProgress } from '@shared/types';
import {
  ANNOUNCE_LIMITS,
  YT_DESCRIPTION_MAX_BYTES,
  YT_TITLE_MAX,
  announceLength,
  charCount,
  parseTags,
  utf8Bytes,
  validateYouTube,
  type AnnouncePlatform,
} from '@shared/publish';
import { useT, type TKey } from '../i18n';
import { api, errMsg } from '../lib/api';

type Tab = 'videos' | 'instagram' | 'announce' | 'history';
type PostId = 'youtube' | 'youtube-shorts' | 'tiktok';
type PostState = { status: 'idle' | 'running' | 'done' | 'failed' | 'skipped'; url?: string; message?: string; progress?: number };

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const POSTS: PostId[] = ['youtube', 'tiktok', 'youtube-shorts'];

export function Publish({ project, toast, onOpenSettings }: { project: ProjectInfo | null; toast: (m: string) => void; onOpenSettings: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('videos');
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  const [announceUrl, setAnnounceUrl] = useState('');
  const dir = project?.dir ?? null;

  const load = async () => {
    if (!dir) return;
    const d = await api.invoke('publish:draft', dir);
    setDraft(d);
    const lastUrl = d.history.find((h) => h.url && h.target === 'youtube')?.url;
    if (lastUrl) setAnnounceUrl((u) => u || lastUrl);
  };

  useEffect(() => {
    setDraft(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  if (!project) {
    return (
      <div className="ws">
        <div className="titlebar">
          <span className="title">{t('nav.publish')}</span>
        </div>
        <div className="empty">{t('ws.noProject')}</div>
      </div>
    );
  }

  const tabs: { id: Tab; key: TKey }[] = [
    { id: 'videos', key: 'pub.videos' },
    { id: 'instagram', key: 'pub.instagram' },
    { id: 'announce', key: 'pub.announce' },
    { id: 'history', key: 'pub.history' },
  ];

  return (
    <div className="ws">
      <div className="titlebar">
        <span className="title">{t('nav.publish')}</span>
        <span className="dim">{project.title}</span>
        <span className="grow" />
        <div className="segmented">
          {tabs.map((x) => (
            <button key={x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>
              {t(x.key)}
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        <div className="page" style={{ paddingTop: 24, maxWidth: 1280 }}>
          <div className="notice" style={{ marginBottom: 16 }}>
            {t('pub.approveRule')}
          </div>
          {!draft ? (
            <div className="dim">{t('common.loading')}</div>
          ) : tab === 'videos' ? (
            <VideosPanel
              dir={project.dir}
              draft={draft}
              toast={toast}
              onOpenSettings={onOpenSettings}
              onFinished={(url) => {
                if (url) setAnnounceUrl(url);
                void load();
                setTab('announce');
              }}
            />
          ) : tab === 'instagram' ? (
            <InstagramPanel dir={project.dir} draft={draft} onDone={() => void load()} />
          ) : tab === 'announce' ? (
            <AnnouncePanel dir={project.dir} draft={draft} url={announceUrl} setUrl={setAnnounceUrl} onDone={() => void load()} />
          ) : (
            <History draft={draft} />
          )}
        </div>
      </div>
    </div>
  );
}

function initialForm(meta: PublishTarget | undefined, draft: PublishDraft, vertical: boolean): YouTubeForm {
  const fallbackVideo = draft.videos.find((v) => (vertical ? /shorts|tiktok/i.test(v) : !/shorts|tiktok|preview/i.test(v))) ?? '';
  return {
    videoPath: meta?.render ?? fallbackVideo,
    title: meta?.title ?? '',
    description: meta?.description ?? '',
    tags: meta?.tags ?? [],
    categoryId: '28',
    privacy: 'private',
    madeForKids: null,
    containsSyntheticMedia: false,
    language: 'ja',
    ...(meta?.thumbnail ? { thumbnailPath: meta.thumbnail } : {}),
    ...(!vertical && meta?.captions ? { captionsPath: meta.captions } : {}),
  };
}

const TIKTOK_CHECKS: TKey[] = ['pub.tt.nickname', 'pub.tt.privacy', 'pub.tt.interactions', 'pub.tt.commercial', 'pub.tt.music', 'pub.tt.aigc'];

function VideosPanel({
  dir,
  draft,
  toast,
  onOpenSettings,
  onFinished,
}: {
  dir: string;
  draft: PublishDraft;
  toast: (m: string) => void;
  onOpenSettings: () => void;
  onFinished: (mainUrl?: string) => void;
}) {
  const t = useT();
  const meta = (id: PostId) => draft.targets.find((x) => x.target === id);
  const [acct, setAcct] = useState<{ clientSet: boolean; connected: boolean } | null>(null);
  const [include, setInclude] = useState<Record<PostId, boolean>>({
    youtube: Boolean(meta('youtube')?.render ?? draft.videos.length),
    tiktok: Boolean(meta('tiktok')?.render),
    'youtube-shorts': Boolean(meta('youtube-shorts')?.render),
  });
  const [main, setMain] = useState<YouTubeForm>(() => initialForm(meta('youtube'), draft, false));
  const [shorts, setShorts] = useState<YouTubeForm>(() => initialForm(meta('youtube-shorts'), draft, true));
  const [linkMain, setLinkMain] = useState(true);
  const [tiktok, setTiktok] = useState({ file: meta('tiktok')?.render ?? '', caption: [meta('tiktok')?.title, meta('tiktok')?.description].filter(Boolean).join('\n\n') });
  const [ttChecks, setTtChecks] = useState<Record<string, boolean>>({});
  const [approved, setApproved] = useState(false);
  const [running, setRunning] = useState(false);
  const [state, setState] = useState<Record<PostId, PostState>>({ youtube: { status: 'idle' }, tiktok: { status: 'idle' }, 'youtube-shorts': { status: 'idle' } });
  const [current, setCurrent] = useState<PostId | null>(null);

  useEffect(() => {
    void api.invoke('publish:youtubeStatus').then(setAcct);
  }, []);
  useEffect(
    () =>
      api.on('publish:progress', (p: YouTubeProgress) => {
        if (!current) return;
        if (p.phase === 'upload' && p.total) setState((s) => ({ ...s, [current]: { ...s[current], progress: (p.sent ?? 0) / p.total! } }));
      }),
    [current],
  );

  const unapprove = () => setApproved(false);
  const mainIssues = useMemo(() => (include.youtube ? validateYouTube(main) : []), [main, include.youtube]);
  const shortsIssues = useMemo(() => (include['youtube-shorts'] ? validateYouTube(shorts) : []), [shorts, include]);
  const ttReady = !include.tiktok || (Boolean(tiktok.file) && TIKTOK_CHECKS.every((k) => ttChecks[k]));
  const needsYouTube = include.youtube || include['youtube-shorts'];
  const blocked = mainIssues.length > 0 || shortsIssues.length > 0 || !ttReady || (needsYouTube && !acct?.connected) || !POSTS.some((p) => include[p]);

  const connect = async () => {
    const r = await api.invoke('publish:youtubeConnect');
    if (!r.ok) toast(`${t('pub.connectFailed')}: ${r.error}`);
    setAcct(await api.invoke('publish:youtubeStatus'));
  };

  const set = (id: PostId, p: PostState) => setState((s) => ({ ...s, [id]: p }));

  /** Posts everything that is included, in order: YouTube main → Shorts (links to main) → TikTok (manual). */
  const postAll = async () => {
    setRunning(true);
    let mainUrl: string | undefined;
    try {
      if (include.youtube) {
        setCurrent('youtube');
        set('youtube', { status: 'running', progress: 0 });
        await api.invoke('publish:saveMeta', dir, 'youtube', main).catch(() => undefined);
        const r = await api.invoke('publish:youtubeUpload', dir, main, 'youtube');
        set('youtube', r.ok ? { status: 'done', url: r.url, message: r.warnings.join(' / ') } : { status: 'failed', message: r.error });
        mainUrl = r.url;
      } else set('youtube', { status: 'skipped' });
      if (include['youtube-shorts']) {
        setCurrent('youtube-shorts');
        set('youtube-shorts', { status: 'running', progress: 0 });
        const form = linkMain && mainUrl ? { ...shorts, description: `${shorts.description.trim()}\n\n${t('pub.fullVideo')}: ${mainUrl}`.trim() } : shorts;
        await api.invoke('publish:saveMeta', dir, 'youtube-shorts', form).catch(() => undefined);
        const r = await api.invoke('publish:youtubeUpload', dir, form, 'youtube-shorts');
        set('youtube-shorts', r.ok ? { status: 'done', url: r.url, message: r.warnings.join(' / ') } : { status: 'failed', message: r.error });
      } else set('youtube-shorts', { status: 'skipped' });
      if (include.tiktok) {
        setCurrent('tiktok');
        await navigator.clipboard.writeText(tiktok.caption).catch(() => undefined);
        await api.invoke('publish:manual', dir, 'tiktok', tiktok.file);
        set('tiktok', { status: 'done', message: t('pub.ttOpened') });
      } else set('tiktok', { status: 'skipped' });
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setCurrent(null);
      setRunning(false);
      setApproved(false);
    }
    onFinished(mainUrl);
  };

  return (
    <div className="pub-grid">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{t('pub.account')}</strong>
          {acct?.connected ? (
            <span className="row">
              <span className="pill okp">{t('pub.connected')}</span>
              <button className="btn small ghost" onClick={() => void api.invoke('publish:youtubeDisconnect').then(() => api.invoke('publish:youtubeStatus').then(setAcct))}>
                <Link2Off size={13} /> {t('pub.disconnect')}
              </button>
            </span>
          ) : acct?.clientSet ? (
            <button className="btn small" onClick={() => void connect()}>
              <Link2 size={13} /> {t('pub.connect')}
            </button>
          ) : (
            <button className="btn small" onClick={onOpenSettings}>
              {t('pub.setClient')}
            </button>
          )}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          {t('pub.byoNote')}
        </div>
      </div>

      <div className="posts">
        <PostCard id="youtube" title={t('pub.post.youtube')} include={include.youtube} onInclude={(v) => (setInclude((x) => ({ ...x, youtube: v })), unapprove())} state={state.youtube}>
          <YouTubeFields form={main} setForm={(f) => (setMain(f), unapprove())} draft={draft} meta={meta('youtube')} vertical={false} />
        </PostCard>
        <PostCard id="tiktok" title={t('pub.post.tiktok')} include={include.tiktok} onInclude={(v) => (setInclude((x) => ({ ...x, tiktok: v })), unapprove())} state={state.tiktok}>
          <div className="dim" style={{ fontSize: 12 }}>
            {t('pub.manualNote')}
          </div>
          <FileSelect label={t('pub.video')} value={tiktok.file} options={draft.videos} onChange={(file) => (setTiktok((x) => ({ ...x, file })), unapprove())} required />
          <div className="field">
            <label>{t('pub.caption')}</label>
            <textarea className="input" rows={5} value={tiktok.caption} onChange={(e) => (setTiktok((x) => ({ ...x, caption: e.target.value })), unapprove())} />
          </div>
          <div className="field">
            <label>{t('pub.checklist')}</label>
            {TIKTOK_CHECKS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={Boolean(ttChecks[k])} onChange={(e) => (setTtChecks((d) => ({ ...d, [k]: e.target.checked })), unapprove())} />
                {t(k)}
              </label>
            ))}
          </div>
        </PostCard>
        <PostCard
          id="youtube-shorts"
          title={t('pub.post.shorts')}
          include={include['youtube-shorts']}
          onInclude={(v) => (setInclude((x) => ({ ...x, 'youtube-shorts': v })), unapprove())}
          state={state['youtube-shorts']}
        >
          <YouTubeFields form={shorts} setForm={(f) => (setShorts(f), unapprove())} draft={draft} meta={meta('youtube-shorts')} vertical />
          <label className="check">
            <input type="checkbox" checked={linkMain} onChange={(e) => (setLinkMain(e.target.checked), unapprove())} />
            {t('pub.linkMain')}
          </label>
        </PostCard>
      </div>

      <div className="card approve-bar">
        <label className="check">
          <input type="checkbox" checked={approved} disabled={blocked || running} onChange={(e) => setApproved(e.target.checked)} />
          <strong>{t('pub.approveAll')}</strong>
        </label>
        {needsYouTube && !acct?.connected && <span className="error" style={{ fontSize: 12 }}>{t('pub.needAccount')}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={!approved || blocked || running} onClick={() => void postAll()}>
          {running ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} {t('pub.postAll')}
        </button>
      </div>
    </div>
  );
}

function PostCard({ id, title, include, onInclude, state, children }: { id: PostId; title: string; include: boolean; onInclude: (v: boolean) => void; state: PostState; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className={`card form post ${include ? '' : 'off'}`} data-post={id}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="check">
          <input type="checkbox" checked={include} onChange={(e) => onInclude(e.target.checked)} />
          <strong>{title}</strong>
        </label>
        <PostStatus s={state} />
      </div>
      {include ? children : <div className="dim">{t('pub.excluded')}</div>}
    </div>
  );
}

function PostStatus({ s }: { s: PostState }) {
  const t = useT();
  if (s.status === 'idle') return null;
  if (s.status === 'running')
    return (
      <span className="row dim" style={{ fontSize: 12 }}>
        <Loader2 size={13} className="spin" /> {s.progress !== undefined ? `${Math.round(s.progress * 100)}%` : ''}
      </span>
    );
  if (s.status === 'skipped') return <span className="pill">{t('pub.skipped')}</span>;
  if (s.status === 'failed')
    return (
      <span className="pill accent" title={s.message}>
        <XCircle size={12} /> {t('pub.failed')}
      </span>
    );
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="pill okp">
        <CheckCircle2 size={12} /> {t('pub.posted')}
      </span>
      {s.url && (
        <a href="#" style={{ fontSize: 12 }} onClick={(e) => (e.preventDefault(), void api.invoke('app:openExternal', s.url!))}>
          {s.url}
        </a>
      )}
    </span>
  );
}

function YouTubeFields({ form, setForm, draft, meta, vertical }: { form: YouTubeForm; setForm: (f: YouTubeForm) => void; draft: PublishDraft; meta?: PublishTarget; vertical: boolean }) {
  const t = useT();
  const [tagsText, setTagsText] = useState(form.tags.join(', '));
  const set = <K extends keyof YouTubeForm>(k: K, v: YouTubeForm[K]) => setForm({ ...form, [k]: v });
  const issues = validateYouTube(form);
  const issueFor = (f: keyof YouTubeForm) => issues.find((i) => i.field === f);
  return (
    <>
      <FileSelect label={t('pub.video')} value={form.videoPath} options={draft.videos} onChange={(v) => set('videoPath', v)} required />
      <div className="field">
        <label>
          {t('pub.title')} <Counter n={charCount(form.title)} max={YT_TITLE_MAX} />
        </label>
        <input className="input" type="text" value={form.title} onChange={(e) => set('title', e.target.value)} />
        {meta && meta.titleCandidates.length > 0 && (
          <div className="row wrap" style={{ gap: 4 }}>
            {meta.titleCandidates.map((c) => (
              <button key={c} className="btn small ghost" onClick={() => set('title', c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        <Issue issue={issueFor('title')} />
      </div>
      <div className="field">
        <label>
          {t('pub.description')} <Counter n={utf8Bytes(form.description)} max={YT_DESCRIPTION_MAX_BYTES} unit="bytes" />
        </label>
        <textarea className="input" rows={vertical ? 4 : 7} value={form.description} onChange={(e) => set('description', e.target.value)} />
        <Issue issue={issueFor('description')} />
      </div>
      <div className="field">
        <label>{t('pub.tags')}</label>
        <input
          className="input"
          type="text"
          value={tagsText}
          onChange={(e) => {
            setTagsText(e.target.value);
            set('tags', parseTags(e.target.value));
          }}
        />
        <Issue issue={issueFor('tags')} />
      </div>
      <div className="grid2">
        <div className="field">
          <label>{t('pub.privacy')}</label>
          <select className="input" value={form.privacy} onChange={(e) => set('privacy', e.target.value as YouTubeForm['privacy'])}>
            <option value="private">{t('pub.private')}</option>
            <option value="unlisted">{t('pub.unlisted')}</option>
            <option value="public">{t('pub.public')}</option>
          </select>
        </div>
        <div className="field">
          <label>{t('pub.publishAt')}</label>
          <input
            className="input"
            type="datetime-local"
            value={form.publishAt ? toLocalInput(form.publishAt) : ''}
            onChange={(e) => set('publishAt', e.target.value ? new Date(e.target.value).toISOString() : undefined)}
          />
          <Issue issue={issueFor('publishAt')} />
        </div>
        <div className="field">
          <label>{t('pub.category')}</label>
          <select className="input" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="28">Science &amp; Technology</option>
            <option value="27">Education</option>
            <option value="22">People &amp; Blogs</option>
            <option value="24">Entertainment</option>
            <option value="26">Howto &amp; Style</option>
          </select>
        </div>
        <div className="field">
          <label>{t('pub.language')}</label>
          <select className="input" value={form.language} onChange={(e) => set('language', e.target.value)}>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>{t('pub.madeForKids')} *</label>
        <div className="row">
          <label className="check">
            <input type="radio" checked={form.madeForKids === false} onChange={() => set('madeForKids', false)} /> {t('pub.notForKids')}
          </label>
          <label className="check">
            <input type="radio" checked={form.madeForKids === true} onChange={() => set('madeForKids', true)} /> {t('pub.forKids')}
          </label>
        </div>
        <Issue issue={issueFor('madeForKids')} />
      </div>
      <label className="check">
        <input type="checkbox" checked={form.containsSyntheticMedia} onChange={(e) => set('containsSyntheticMedia', e.target.checked)} />
        {t('pub.synthetic')}
      </label>
      <FileSelect label={t('pub.thumbnail')} value={form.thumbnailPath ?? ''} options={draft.images} onChange={(v) => set('thumbnailPath', v || undefined)} />
      {!vertical && <FileSelect label={t('pub.captions')} value={form.captionsPath ?? ''} options={draft.captions} onChange={(v) => set('captionsPath', v || undefined)} />}
    </>
  );
}

const IG_CHECKS: TKey[] = ['pub.ig.caption', 'pub.ig.cover', 'pub.ig.vertical'];

function InstagramPanel({ dir, draft, onDone }: { dir: string; draft: PublishDraft; onDone: () => void }) {
  const t = useT();
  const [file, setFile] = useState(draft.targets.find((x) => x.target === 'tiktok')?.render ?? draft.videos[0] ?? '');
  const [done, setDone] = useState<Record<string, boolean>>({});
  const all = IG_CHECKS.every((k) => done[k]);
  return (
    <div className="pub-grid">
      <div className="card form">
        <strong>{t('pub.instagram')}</strong>
        <div className="dim">{t('pub.manualNote')}</div>
        <FileSelect label={t('pub.video')} value={file} options={draft.videos} onChange={setFile} required />
        <div className="field">
          <label>{t('pub.checklist')}</label>
          {IG_CHECKS.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={Boolean(done[k])} onChange={(e) => setDone((d) => ({ ...d, [k]: e.target.checked }))} />
              {t(k)}
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn primary" disabled={!file || !all} onClick={() => void api.invoke('publish:manual', dir, 'instagram', file).then(onDone)}>
            <ExternalLink size={14} /> {t('pub.openSite')}
          </button>
        </div>
      </div>
    </div>
  );
}

const ANNOUNCE: AnnouncePlatform[] = ['x', 'threads', 'facebook'];

function AnnouncePanel({ dir, draft, url, setUrl, onDone }: { dir: string; draft: PublishDraft; url: string; setUrl: (u: string) => void; onDone: () => void }) {
  const t = useT();
  const initial = draft.targets.find((x) => x.target === 'youtube')?.title ?? '';
  const [texts, setTexts] = useState<Record<AnnouncePlatform, string>>({ x: initial, threads: initial, facebook: initial });
  const [ok, setOk] = useState<Record<AnnouncePlatform, boolean>>({ x: false, threads: false, facebook: false });
  const urls = [...new Set(draft.history.filter((h) => h.url).map((h) => h.url!))].slice(0, 6);
  return (
    <div className="pub-grid">
      <div className="card form">
        <div className="field">
          <label>{t('pub.url')}</label>
          <input className="input mono" type="text" value={url} placeholder="https://youtu.be/…" onChange={(e) => setUrl(e.target.value)} />
          {urls.length > 0 && (
            <div className="row wrap" style={{ gap: 4 }}>
              {urls.map((u) => (
                <button key={u} className="btn small ghost mono" onClick={() => setUrl(u)}>
                  {u}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {ANNOUNCE.map((p) => {
        const len = announceLength(p, texts[p], url);
        const over = len > ANNOUNCE_LIMITS[p];
        return (
          <div key={p} className="card form">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{p === 'x' ? 'X' : p === 'threads' ? 'Threads' : 'Facebook'}</strong>
              <Counter n={len} max={ANNOUNCE_LIMITS[p]} />
            </div>
            <textarea
              className="input"
              rows={p === 'facebook' ? 3 : 4}
              value={texts[p]}
              onChange={(e) => {
                setTexts((x) => ({ ...x, [p]: e.target.value }));
                setOk((x) => ({ ...x, [p]: false }));
              }}
            />
            {p === 'facebook' && <div className="dim" style={{ fontSize: 12 }}>{t('pub.fbNote')}</div>}
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={ok[p]} disabled={over || (p === 'facebook' && !url)} onChange={(e) => setOk((x) => ({ ...x, [p]: e.target.checked }))} />
                {t('pub.approve')}
              </label>
              <span style={{ flex: 1 }} />
              <button
                className="btn primary small"
                disabled={!ok[p] || over}
                onClick={() => {
                  if (p === 'facebook') void navigator.clipboard.writeText(texts[p]).catch(() => undefined);
                  void api.invoke('publish:openIntent', dir, p, texts[p], url).then(onDone);
                  setOk((x) => ({ ...x, [p]: false }));
                }}
              >
                <ExternalLink size={13} /> {t('pub.openComposer')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function History({ draft }: { draft: PublishDraft }) {
  const t = useT();
  if (draft.history.length === 0) return <div className="card empty">{t('pub.noHistory')}</div>;
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="table">
        <tbody>
          {draft.history.map((h, i) => (
            <tr key={i}>
              <td className="mono dim" style={{ width: 170 }}>
                {new Date(h.at).toLocaleString()}
              </td>
              <td>{h.target}</td>
              <td>
                <span className={`pill ${h.status === 'failed' ? 'accent' : h.status === 'published' || h.status === 'scheduled' ? 'okp' : ''}`}>{h.status}</span>
              </td>
              <td className="dim">{h.method}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>
                {h.url ? (
                  <a href="#" onClick={(e) => (e.preventDefault(), void api.invoke('app:openExternal', h.url!))}>
                    {h.url}
                  </a>
                ) : (
                  (h.error ?? '')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileSelect({ label, value, options, onChange, required }: { label: string; value: string; options: string[]; onChange: (v: string) => void; required?: boolean }) {
  const t = useT();
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className="field">
      <label>
        {label}
        {required ? ' *' : ''}
      </label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {!required && <option value="">{t('pub.none')}</option>}
        {required && !value && <option value="">—</option>}
        {opts.map((o) => (
          <option key={o} value={o} title={o}>
            {base(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Counter({ n, max, unit }: { n: number; max: number; unit?: string }) {
  return (
    <span className={`mono ${n > max ? 'error' : 'dim'}`} style={{ fontSize: 11, marginLeft: 6 }}>
      {n}/{max}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}

function Issue({ issue }: { issue?: { code: string } }) {
  const t = useT();
  if (!issue) return null;
  return <span className="error" style={{ fontSize: 12 }}>{t(`pub.issue.${issue.code}` as TKey)}</span>;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
