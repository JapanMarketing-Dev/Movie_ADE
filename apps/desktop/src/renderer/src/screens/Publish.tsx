// Publish (docs/14). Nothing is posted without an explicit "I checked this" approval per target.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2, Link2Off, Upload } from 'lucide-react';
import type { ProjectInfo, PublishDraft, YouTubeForm, YouTubeProgress } from '@shared/types';
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

type Tab = 'youtube' | 'tiktok' | 'instagram' | 'announce' | 'history';
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function Publish({ project, toast, onOpenSettings }: { project: ProjectInfo | null; toast: (m: string) => void; onOpenSettings: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('youtube');
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  const [announceUrl, setAnnounceUrl] = useState('');
  const dir = project?.dir ?? null;

  const load = useCallback(async () => {
    if (!dir) return;
    const d = await api.invoke('publish:draft', dir);
    setDraft(d);
    const lastUrl = d.history.find((h) => h.url && (h.target === 'youtube' || h.target === 'tiktok'))?.url;
    if (lastUrl) setAnnounceUrl((u) => u || lastUrl);
  }, [dir]);

  useEffect(() => {
    setDraft(null);
    void load();
  }, [load]);

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
    { id: 'youtube', key: 'pub.youtube' },
    { id: 'tiktok', key: 'pub.tiktok' },
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
        <div className="page" style={{ paddingTop: 24 }}>
          <div className="notice" style={{ marginBottom: 16 }}>
            {t('pub.approveRule')}
          </div>
          {!draft ? (
            <div className="dim">{t('common.loading')}</div>
          ) : tab === 'youtube' ? (
            <YouTubePanel dir={project.dir} draft={draft} toast={toast} onOpenSettings={onOpenSettings} onPublished={(url) => (setAnnounceUrl(url), void load())} />
          ) : tab === 'tiktok' || tab === 'instagram' ? (
            <ManualPanel dir={project.dir} target={tab} draft={draft} onDone={() => void load()} />
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

function YouTubePanel({ dir, draft, toast, onOpenSettings, onPublished }: { dir: string; draft: PublishDraft; toast: (m: string) => void; onOpenSettings: () => void; onPublished: (url: string) => void }) {
  const t = useT();
  const meta = draft.targets.find((x) => x.target === 'youtube') ?? draft.targets[0];
  const [acct, setAcct] = useState<{ clientSet: boolean; connected: boolean } | null>(null);
  const [form, setForm] = useState<YouTubeForm>(() => ({
    videoPath: meta?.render ?? draft.videos.find((v) => /[\\/]youtube[\\/]/.test(v)) ?? draft.videos[0] ?? '',
    title: meta?.title ?? '',
    description: meta?.description ?? '',
    tags: meta?.tags ?? [],
    categoryId: '28',
    privacy: 'private',
    madeForKids: null,
    containsSyntheticMedia: false,
    language: 'ja',
    ...(meta?.thumbnail ? { thumbnailPath: meta.thumbnail } : {}),
    ...(meta?.captions ? { captionsPath: meta.captions } : {}),
  }));
  const [tagsText, setTagsText] = useState((meta?.tags ?? []).join(', '));
  const [approved, setApproved] = useState(false);
  const [progress, setProgress] = useState<YouTubeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; warnings: string[]; error?: string } | null>(null);

  useEffect(() => {
    void api.invoke('publish:youtubeStatus').then(setAcct);
    return api.on('publish:progress', setProgress);
  }, []);

  const set = <K extends keyof YouTubeForm>(k: K, v: YouTubeForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setApproved(false);
  };
  const issues = useMemo(() => validateYouTube(form), [form]);
  const issueFor = (f: keyof YouTubeForm) => issues.find((i) => i.field === f);

  const connect = async () => {
    setBusy(true);
    const r = await api.invoke('publish:youtubeConnect');
    setBusy(false);
    if (!r.ok) toast(`${t('pub.connectFailed')}: ${r.error}`);
    setAcct(await api.invoke('publish:youtubeStatus'));
  };

  const upload = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.invoke('publish:youtubeUpload', dir, form);
      setResult(r);
      if (r.ok && r.url) onPublished(r.url);
    } catch (e) {
      setResult({ warnings: [], error: errMsg(e) });
    } finally {
      setBusy(false);
      setApproved(false);
    }
  };

  const pct = progress?.phase === 'upload' && progress.total ? Math.round(((progress.sent ?? 0) / progress.total) * 100) : null;

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
            <button className="btn small" disabled={busy} onClick={() => void connect()}>
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

      <div className="card form">
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
          <textarea className="input" rows={8} value={form.description} onChange={(e) => set('description', e.target.value)} />
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
              <input type="radio" name="mfk" checked={form.madeForKids === false} onChange={() => set('madeForKids', false)} /> {t('pub.notForKids')}
            </label>
            <label className="check">
              <input type="radio" name="mfk" checked={form.madeForKids === true} onChange={() => set('madeForKids', true)} /> {t('pub.forKids')}
            </label>
          </div>
          <Issue issue={issueFor('madeForKids')} />
        </div>
        <label className="check">
          <input type="checkbox" checked={form.containsSyntheticMedia} onChange={(e) => set('containsSyntheticMedia', e.target.checked)} />
          {t('pub.synthetic')}
        </label>
        <FileSelect label={t('pub.thumbnail')} value={form.thumbnailPath ?? ''} options={draft.images} onChange={(v) => set('thumbnailPath', v || undefined)} />
        <FileSelect label={t('pub.captions')} value={form.captionsPath ?? ''} options={draft.captions} onChange={(v) => set('captionsPath', v || undefined)} />
      </div>

      <div className="card">
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={approved} disabled={issues.length > 0} onChange={(e) => setApproved(e.target.checked)} />
          <strong>{t('pub.approve')}</strong>
        </label>
        <div className="row">
          <button className="btn primary" disabled={!approved || busy || !acct?.connected || issues.length > 0} onClick={() => void upload()}>
            <Upload size={14} /> {form.publishAt ? t('pub.schedule') : t('pub.upload')}
          </button>
          {busy && progress && (
            <span className="row">
              <span className="dim">{progress.phase}</span>
              {pct !== null && (
                <div className="progress">
                  <div style={{ width: `${pct}%` }} />
                </div>
              )}
              {pct !== null && <span className="mono dim">{pct}%</span>}
            </span>
          )}
        </div>
        {result?.url && (
          <div className="notice" style={{ marginTop: 12 }}>
            {t('pub.done')}{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), void api.invoke('app:openExternal', result.url!))}>
              {result.url}
            </a>
          </div>
        )}
        {result?.warnings.map((w) => (
          <div key={w} className="notice" style={{ marginTop: 6 }}>
            {w}
          </div>
        ))}
        {result?.error && (
          <div className="notice err" style={{ marginTop: 12 }}>
            {result.error}
          </div>
        )}
      </div>
    </div>
  );
}

const TIKTOK_CHECKS: TKey[] = ['pub.tt.nickname', 'pub.tt.privacy', 'pub.tt.interactions', 'pub.tt.commercial', 'pub.tt.music', 'pub.tt.aigc'];
const IG_CHECKS: TKey[] = ['pub.ig.caption', 'pub.ig.cover', 'pub.ig.vertical'];

function ManualPanel({ dir, target, draft, onDone }: { dir: string; target: 'tiktok' | 'instagram'; draft: PublishDraft; onDone: () => void }) {
  const t = useT();
  const checks = target === 'tiktok' ? TIKTOK_CHECKS : IG_CHECKS;
  const preferred = draft.targets.find((x) => x.target === target || (target === 'instagram' && x.target === 'instagram-reels'))?.render;
  const [file, setFile] = useState(preferred ?? draft.videos.find((v) => new RegExp(`[\\\\/]${target}`).test(v)) ?? draft.videos[0] ?? '');
  const [done, setDone] = useState<Record<string, boolean>>({});
  const all = checks.every((k) => done[k]);
  const meta = draft.targets.find((x) => x.target === target);
  return (
    <div className="pub-grid">
      <div className="card">
        <strong>{target === 'tiktok' ? t('pub.tiktok') : t('pub.instagram')}</strong>
        <div className="dim" style={{ marginTop: 6 }}>
          {t('pub.manualNote')}
        </div>
      </div>
      <div className="card form">
        <FileSelect label={t('pub.video')} value={file} options={draft.videos} onChange={setFile} required />
        {meta?.description && (
          <div className="field">
            <label>{t('pub.caption')}</label>
            <textarea className="input" rows={5} readOnly value={[meta.title, meta.description].filter(Boolean).join('\n\n')} />
          </div>
        )}
        <div className="field">
          <label>{t('pub.checklist')}</label>
          {checks.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={Boolean(done[k])} onChange={(e) => setDone((d) => ({ ...d, [k]: e.target.checked }))} />
              {t(k)}
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn primary" disabled={!file || !all} onClick={() => void api.invoke('publish:manual', dir, target, file).then(onDone)}>
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
  const meta = draft.targets[0];
  const initial = meta ? meta.title : '';
  const [texts, setTexts] = useState<Record<AnnouncePlatform, string>>({ x: initial, threads: initial, facebook: initial });
  const [ok, setOk] = useState<Record<AnnouncePlatform, boolean>>({ x: false, threads: false, facebook: false });
  return (
    <div className="pub-grid">
      <div className="card form">
        <div className="field">
          <label>{t('pub.url')}</label>
          <input className="input mono" type="text" value={url} placeholder="https://youtu.be/…" onChange={(e) => setUrl(e.target.value)} />
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
  const key = `pub.issue.${issue.code}` as TKey;
  return <span className="error" style={{ fontSize: 12 }}>{t(key)}</span>;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
