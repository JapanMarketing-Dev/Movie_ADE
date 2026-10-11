import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, ExternalLink, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react';
import type { AgentStatus, AppInfo, PromptButton } from '@shared/types';
import { AgentAccountsPanel } from '../components/AgentAccounts';
import { api, errMsg } from '../lib/api';
import { useST, type SKey } from '../shell/i18n';
import { layoutStore, useLayout, PANELS, type Panel } from '../shell/layout';
import { SHORTCUT_SPECS, shortcutLabel, type ShortcutId } from '../shell/shortcut';
import { agentsStore, setSetting, toolsStore, updateStore, useStore } from '../shell/stores';
import { Badge, Button, Note, Progress, Segmented, Select, SettingRow, Switch, useToast, type SelectOption } from '../ui';
import { getPath, moveItem, promptSettingValue } from './settingsSections';

type Json = Record<string, unknown>;

/** Save one key through main; toasts the validation error when main refuses it. */
function useSet(): (key: string, value: unknown) => void {
  const toast = useToast();
  return (key, value) =>
    void setSetting(key, value).then((err) => {
      if (err) toast({ tone: 'danger', message: err });
    });
}

const str = (json: Json, key: string, fallback: string) => {
  const v = getPath(json, key);
  return typeof v === 'string' ? v : fallback;
};
const num = (json: Json, key: string, fallback: number) => {
  const v = getPath(json, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
const bool = (json: Json, key: string, fallback: boolean) => {
  const v = getPath(json, key);
  return typeof v === 'boolean' ? v : fallback;
};
const list = (json: Json, key: string, fallback: string[]) => {
  const v = getPath(json, key);
  return Array.isArray(v) ? v.map(String) : fallback;
};

function Sub({ children }: { children: ReactNode }) {
  return <h3 className="st-page__subheading">{children}</h3>;
}

// ---------- general ----------
export function GeneralSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void api.invoke('videos:list').then((v) => setRoot(v.root)).catch(() => setRoot(null));
    load();
    return api.on('settings:changed', load);
  }, []);
  const shown = root ?? str(json, 'videos.root', '~/Movies/Solocut');
  const change = async () => {
    const dir = await api.invoke('app:chooseFolder', t('settings.general.chooseRoot'));
    if (dir) set('videos.root', dir);
  };
  return (
    <>
      <SettingRow label={t('settings.general.root')}>
        <span className="st-inline">
          <code className="st-value st-value--mono st-value--clip" title={shown}>
            {shown}
          </code>
          <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void change()} data-testid="settings-videos-root">
            {t('settings.general.change')}
          </Button>
        </span>
      </SettingRow>
      <Note>{t('settings.general.rootNote')}</Note>
      <Switch label={t('settings.general.autoStart')} checked={bool(json, 'autopilot.autoStart', true)} onChange={(v) => set('autopilot.autoStart', v)} />
      <Note>{t('settings.general.autoStartNote')}</Note>
    </>
  );
}

// ---------- appearance ----------
export function AppearanceSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const scale = num(json, 'appearance.uiScale', 1);
  return (
    <>
      <SettingRow label={t('settings.appearance.scale')}>
        <Select
          ariaLabel={t('settings.appearance.scale')}
          value={scale}
          options={[0.85, 0.9, 1, 1.1, 1.25, 1.5].map((n) => ({ value: n, label: `${Math.round(n * 100)}%` }))}
          onChange={(v) => set('appearance.uiScale', v)}
        />
      </SettingRow>
      <Note>{t('settings.appearance.darkOnly')}</Note>
    </>
  );
}

// ---------- language ----------
export function LanguageSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const lang = str(json, 'language', 'ja') === 'en' ? 'en' : 'ja';
  return (
    <>
      <SettingRow label={t('settings.language.ui')}>
        <Segmented
          ariaLabel={t('settings.language.ui')}
          value={lang}
          onChange={(v) => set('language', v)}
          options={[
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
          ]}
        />
      </SettingRow>
      <Note>{t('settings.language.note')}</Note>
    </>
  );
}

// ---------- layout ----------
const PANEL_KEY: Record<Panel, SKey> = { sidebar: 'layout.panel.sidebar', center: 'layout.panel.center', terminal: 'layout.panel.terminal' };
const SHORTCUT_NAME: Record<ShortcutId, SKey> = {
  quickOpen: 'shortcut.quickOpen',
  commandPalette: 'shortcut.commandPalette',
  settings: 'common.settings',
  newProject: 'projectMenu.new',
  openProject: 'projectMenu.openFolder',
  toggleSidebar: 'shortcut.toggleSidebar',
  toggleCenter: 'shortcut.toggleCenter',
  toggleTerminal: 'shortcut.toggleTerminal',
  record: 'shortcut.record',
  modeRecord: 'mode.record',
  modeEdit: 'mode.edit',
  modePublish: 'mode.publish',
};

export function LayoutSection() {
  const t = useST();
  const layout = useLayout();
  return (
    <>
      {PANELS.map((p) => (
        <Switch key={p} label={t(PANEL_KEY[p])} checked={layout[p]} onChange={(v) => layoutStore.set(p, v)} />
      ))}
      <Note>{t('settings.layout.note')}</Note>
      <div className="st-file__actions">
        <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => layoutStore.reset()}>
          {t('settings.layout.reset')}
        </Button>
      </div>
      <Sub>{t('settings.layout.shortcuts')}</Sub>
      <dl className="st-shortcuts">
        {(Object.keys(SHORTCUT_SPECS) as ShortcutId[]).map((id) => (
          <div key={id} className="st-shortcuts__row">
            <dt>{t(SHORTCUT_NAME[id])}</dt>
            <dd>
              <kbd className="kbd">{shortcutLabel(id)}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

// ---------- recording ----------
function useDevices(kind: MediaDeviceKind): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((l) => setDevices(l.filter((d) => d.kind === kind && d.deviceId)))
        .catch(() => setDevices([]));
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', load);
  }, [kind]);
  return devices;
}

const FPS = [24, 25, 30, 50, 60] as const;
const RESOLUTIONS = [
  { w: 1280, h: 720, label: '720p' },
  { w: 1920, h: 1080, label: '1080p' },
  { w: 2560, h: 1440, label: '1440p' },
  { w: 3840, h: 2160, label: '4K' },
];

export function RecordingSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const cams = useDevices('videoinput');
  const mics = useDevices('audioinput');
  const camW = num(json, 'recording.camera.width', 1920);
  const camH = num(json, 'recording.camera.height', 1080);
  const resValue = `${camW}x${camH}`;
  const deviceOptions = (devs: MediaDeviceInfo[], fallback: string): SelectOption<string>[] => [
    { value: 'default', label: t('settings.recording.systemDefault') },
    ...devs.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` })),
  ];
  return (
    <>
      <SettingRow label={t('settings.recording.screenFps')}>
        <Select ariaLabel={t('settings.recording.screenFps')} value={num(json, 'recording.screen.fps', 30)} options={FPS.map((f) => ({ value: f, label: `${f} fps` }))} onChange={(v) => set('recording.screen.fps', v)} />
      </SettingRow>
      <Sub>{t('settings.recording.camera')}</Sub>
      <SettingRow label={t('settings.recording.device')}>
        <Select ariaLabel={t('settings.recording.camera')} value={str(json, 'recording.camera.deviceId', 'default')} options={deviceOptions(cams, t('settings.recording.camera'))} onChange={(v) => set('recording.camera.deviceId', v)} />
      </SettingRow>
      <SettingRow label={t('settings.recording.resolution')}>
        <Select
          ariaLabel={t('settings.recording.resolution')}
          value={resValue}
          options={RESOLUTIONS.map((r) => ({ value: `${r.w}x${r.h}`, label: `${r.label} (${r.w}×${r.h})` }))}
          onChange={(v) => {
            const [w, h] = v.split('x').map(Number);
            if (w && h) {
              set('recording.camera.width', w);
              set('recording.camera.height', h);
            }
          }}
        />
      </SettingRow>
      <SettingRow label={t('settings.recording.cameraFps')}>
        <Select ariaLabel={t('settings.recording.cameraFps')} value={num(json, 'recording.camera.fps', 30)} options={FPS.map((f) => ({ value: f, label: `${f} fps` }))} onChange={(v) => set('recording.camera.fps', v)} />
      </SettingRow>
      <Sub>{t('settings.recording.audio')}</Sub>
      <SettingRow label={t('settings.recording.mic')}>
        <Select ariaLabel={t('settings.recording.mic')} value={str(json, 'recording.mic.deviceId', 'default')} options={deviceOptions(mics, t('settings.recording.mic'))} onChange={(v) => set('recording.mic.deviceId', v)} />
      </SettingRow>
      <Switch label={t('settings.recording.systemAudio')} checked={bool(json, 'recording.systemAudio', true)} onChange={(v) => set('recording.systemAudio', v)} />
      <Switch label={t('settings.recording.syncMarker')} checked={bool(json, 'recording.syncMarker', false)} onChange={(v) => set('recording.syncMarker', v)} />
      <Note>{t('settings.recording.syncMarkerNote')}</Note>
      <Switch label={t('settings.recording.keystrokes')} checked={bool(json, 'recording.keystrokeOverlay', true)} onChange={(v) => set('recording.keystrokeOverlay', v)} />
      <Sub>{t('settings.recording.hotkeys')}</Sub>
      <SettingRow label={t('settings.recording.markNg')}>
        <kbd className="kbd">{str(json, 'recording.hotkeys.markNg', 'CmdOrCtrl+Shift+N')}</kbd>
      </SettingRow>
      <SettingRow label={t('settings.recording.markImportant')}>
        <kbd className="kbd">{str(json, 'recording.hotkeys.markImportant', 'CmdOrCtrl+Shift+M')}</kbd>
      </SettingRow>
      <Note>{t('settings.recording.hotkeysNote')}</Note>
    </>
  );
}

// ---------- transcription ----------
export function TranscriptionSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const tools = useStore(toolsStore);
  const model = str(json, 'transcription.model', 'large-v3-turbo-q5');
  const modelTool = model === 'small' ? 'whisper-model-small' : 'whisper-model';
  const installed = tools?.find((x) => x.name === modelTool)?.installed;
  return (
    <>
      <SettingRow label={t('settings.transcription.engine')}>
        <span className="st-value">whisper.cpp</span>
      </SettingRow>
      <SettingRow label={t('settings.transcription.model')}>
        <Select
          ariaLabel={t('settings.transcription.model')}
          value={model}
          options={[
            { value: 'large-v3-turbo-q5', label: t('settings.transcription.modelLarge') },
            { value: 'small', label: t('settings.transcription.modelSmall') },
          ]}
          onChange={(v) => set('transcription.model', v)}
        />
      </SettingRow>
      {installed === false && <ToolInstallNote name={modelTool} />}
      <SettingRow label={t('settings.transcription.language')}>
        <Select
          ariaLabel={t('settings.transcription.language')}
          value={str(json, 'transcription.language', 'ja')}
          options={[
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
            { value: 'auto', label: t('settings.transcription.auto') },
          ]}
          onChange={(v) => set('transcription.language', v)}
        />
      </SettingRow>
      <Note>{t('settings.transcription.local')}</Note>
    </>
  );
}

function ToolInstallNote({ name }: { name: string }) {
  const t = useST();
  const [busy, setBusy] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => api.on('tools:progress', (n, received, total) => n === name && setBusy(total ? received / total : null)), [name]);
  const install = async () => {
    setBusy(null);
    setError(null);
    const r = await api.invoke('tools:install', name).catch((e: unknown) => ({ ok: false, error: errMsg(e) }));
    if (!r.ok) setError(r.error ?? t('common.error'));
    setBusy(undefined);
    void toolsStore.reload();
  };
  return (
    <div className="st-note st-note--warn st-note--action">
      <span>{t('settings.tools.missing', { name })}</span>
      {busy !== undefined ? (
        <span className="st-inline-progress">
          <Progress {...(busy !== null ? { value: busy } : {})} label={name} />
        </span>
      ) : (
        <Button size="sm" icon={<Download size={13} />} onClick={() => void install()}>
          {t('status.tools.install')}
        </Button>
      )}
      {error && <span>{error}</span>}
    </div>
  );
}

// ---------- agents ----------
export function AgentsSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const toast = useToast();
  const agents = useStore(agentsStore);
  const order = list(json, 'agents.order', ['claude', 'codex', 'gemini']);
  const custom = (getPath(json, 'agents.custom') as { id: string; label: string; command: string }[] | undefined) ?? [];
  // agents in the preferred order first, then the rest
  const sorted: AgentStatus[] = agents ? [...order.map((id) => agents.find((a) => a.id === id)).filter((a): a is AgentStatus => !!a), ...agents.filter((a) => !order.includes(a.id))] : [];
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast({ tone: 'success', message: t('settings.file.copied') }))
      .catch(() => undefined);
  return (
    <>
      <Note>{t('settings.agents.intro')}</Note>
      {agents === null && <Progress label={t('common.loading')} />}
      <div className="st-agent-list">
        {sorted.map((a) => {
          const i = order.indexOf(a.id);
          return (
            <div key={a.id} className="st-agent-row" data-disabled={!a.installed || undefined}>
              <div className="st-agent-row__head">
                <span className="agent-glyph" aria-hidden="true">
                  {(a.label[0] ?? '?').toUpperCase()}
                </span>
                <span className="st-agent-row__name">{a.label}</span>
                {i >= 0 && <span className="st-agent-pick__order">{i + 1}</span>}
                {a.installed ? (
                  <span className="st-agent-row__state">{a.version ?? t('status.usage.installed')}</span>
                ) : (
                  <span className="st-agent-row__state is-missing">{t('status.usage.notInstalled')}</span>
                )}
                {i >= 0 && (
                  <span className="st-agent-row__moves">
                    <Button size="sm" variant="ghost" aria-label={t('settings.agents.up')} disabled={i === 0} icon={<ArrowUp size={13} />} onClick={() => set('agents.order', moveItem(order, i, -1))} />
                    <Button size="sm" variant="ghost" aria-label={t('settings.agents.down')} disabled={i === order.length - 1} icon={<ArrowDown size={13} />} onClick={() => set('agents.order', moveItem(order, i, 1))} />
                  </span>
                )}
              </div>
              {!a.installed && a.install && (
                <div className="st-agent-row__install">
                  <code>{a.install}</code>
                  <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(a.install)}>
                    {t('settings.agents.copy')}
                  </Button>
                </div>
              )}
              {a.installed && a.update && (
                <details className="st-agent-row__details">
                  <summary>
                    {t('settings.agents.update')} <code>{a.update}</code>
                  </summary>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <Sub>{t('settings.agents.failover')}</Sub>
      <Switch label={t('settings.agents.failoverOn')} checked={bool(json, 'agents.failover.enabled', true)} onChange={(v) => set('agents.failover.enabled', v)} />
      <Note>{t('settings.agents.failoverNote')}</Note>
      <Switch label={t('settings.agents.checkUpdates')} checked={bool(json, 'agents.checkUpdates', true)} onChange={(v) => set('agents.checkUpdates', v)} />
      <Sub>{t('settings.agents.custom')}</Sub>
      {custom.length === 0 ? (
        <Note>{t('settings.agents.customNone')}</Note>
      ) : (
        custom.map((c) => (
          <SettingRow key={c.id} label={c.label}>
            <code className="st-value st-value--mono">{c.command}</code>
          </SettingRow>
        ))
      )}
      <Note>{t('settings.agents.customHint')}</Note>
    </>
  );
}

// ---------- accounts ----------
export function AccountsSection() {
  const t = useST();
  const toast = useToast();
  return (
    <>
      <AgentAccountsPanel />
      {PublishAccounts && (
        <>
          <Sub>{t('settings.accounts.publish')}</Sub>
          <PublishAccounts toast={(m) => toast({ message: m })} />
        </>
      )}
    </>
  );
}

// YouTube / TikTok connect rows (components/PublishAccounts.tsx, from the publishing side). Picked up when the file exists.
const publishModules = import.meta.glob<{ PublishAccounts?: ComponentType<{ toast?: (m: string) => void }> }>('../components/PublishAccounts.tsx', { eager: true });
const PublishAccounts = Object.values(publishModules)[0]?.PublishAccounts ?? null;

// ---------- prompts ----------
const PROMPT_FIELDS = [
  { id: 'finish', title: 'settings.prompts.finish', note: 'settings.prompts.finishNote' },
  { id: 'publish', title: 'settings.prompts.publish', note: 'settings.prompts.publishNote' },
] as const satisfies readonly { id: string; title: SKey; note: SKey }[];

export function PromptsSection() {
  const t = useST();
  const [prompts, setPrompts] = useState<PromptButton[] | null>(null);
  useEffect(() => {
    const load = () => void api.invoke('prompts:list').then(setPrompts).catch(() => setPrompts([]));
    load();
    return api.on('settings:changed', load);
  }, []);
  return (
    <>
      <Note>{t('settings.prompts.intro')}</Note>
      {prompts === null && <Progress label={t('common.loading')} />}
      {PROMPT_FIELDS.map((f) => {
        const p = prompts?.find((x) => x.id === f.id);
        return p ? <PromptField key={f.id} prompt={p} title={t(f.title)} note={t(f.note)} /> : null;
      })}
      <Note>{t('settings.prompts.vars')}</Note>
    </>
  );
}

/** One prompt as a plain textarea (Ferret's agent prompt field): saved when it loses focus;「既定に戻す」removes the override. */
function PromptField({ prompt, title, note }: { prompt: PromptButton; title: string; note: string }) {
  const t = useST();
  const set = useSet();
  const server = prompt.text ?? '';
  const def = prompt.defaultText ?? '';
  // null = not editing: show what is saved (settings may change from outside)
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? server;
  const commit = () => {
    if (draft === null) return;
    const next = promptSettingValue(draft, def);
    if (next !== (prompt.overridden ? server : undefined)) set(`prompts.${prompt.id}`, next);
    setDraft(null);
  };
  return (
    <div className="st-prompt" data-testid={`settings-prompt-${prompt.id}`}>
      <Sub>{title}</Sub>
      <Note>{note}</Note>
      <textarea
        className="st-textarea st-textarea--prompt"
        aria-label={title}
        spellCheck={false}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      <div className="st-file__actions">
        {prompt.overridden ? <Badge>{t('settings.prompts.custom')}</Badge> : <Badge tone="success">{t('settings.prompts.default')}</Badge>}
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={13} />}
          disabled={!prompt.overridden && draft === null}
          onClick={() => {
            setDraft(null);
            set(`prompts.${prompt.id}`, undefined);
          }}
        >
          {t('settings.prompts.reset')}
        </Button>
      </div>
    </div>
  );
}

// ---------- publishing ----------
export function PublishingSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  return (
    <>
      <SettingRow label={t('settings.publishing.youtube')}>
        <Select
          ariaLabel={t('settings.publishing.youtube')}
          value={str(json, 'publish.youtube.privacy', 'private')}
          options={[
            { value: 'public', label: t('settings.publishing.ytPublic') },
            { value: 'unlisted', label: t('settings.publishing.ytUnlisted') },
            { value: 'private', label: t('settings.publishing.ytPrivate') },
          ]}
          onChange={(v) => set('publish.youtube.privacy', v)}
        />
      </SettingRow>
      <SettingRow label={t('settings.publishing.tiktok')}>
        <Select
          ariaLabel={t('settings.publishing.tiktok')}
          value={str(json, 'publish.tiktok.privacy', 'SELF_ONLY')}
          options={[
            { value: 'PUBLIC_TO_EVERYONE', label: t('settings.publishing.ttEveryone') },
            { value: 'MUTUAL_FOLLOW_FRIENDS', label: t('settings.publishing.ttFriends') },
            { value: 'FOLLOWER_OF_CREATOR', label: t('settings.publishing.ttFollowers') },
            { value: 'SELF_ONLY', label: t('settings.publishing.ttSelf') },
          ]}
          onChange={(v) => set('publish.tiktok.privacy', v)}
        />
      </SettingRow>
      <Note>{t('settings.publishing.note')}</Note>
    </>
  );
}

// ---------- benchmark ----------
// The reference-video panel (components/BenchmarkPanel.tsx, from the preview side). Picked up when the file exists.
const benchmarkModules = import.meta.glob<{ BenchmarkPanel?: ComponentType }>('../components/BenchmarkPanel.tsx', { eager: true });
const BenchmarkPanel = Object.values(benchmarkModules)[0]?.BenchmarkPanel ?? null;

export function BenchmarkSection() {
  const t = useST();
  return BenchmarkPanel ? <BenchmarkPanel /> : <Note>{t('settings.benchmark.missing')}</Note>;
}

// ---------- updates ----------
export function UpdatesSection({ json, info }: { json: Json; info: AppInfo | null }) {
  const t = useST();
  const set = useSet();
  const u = useStore(updateStore);
  const [checking, setChecking] = useState(false);
  return (
    <>
      <SettingRow label={t('status.update.current')}>
        <span className="st-value st-value--mono">v{info?.version ?? '—'}</span>
      </SettingRow>
      <Switch label={t('settings.updates.auto')} checked={bool(json, 'updates.auto', true)} onChange={(v) => set('updates.auto', v)} />
      <SettingRow label={t('settings.updates.channel')}>
        <Segmented
          ariaLabel={t('settings.updates.channel')}
          value={str(json, 'updates.channel', 'stable') === 'beta' ? 'beta' : 'stable'}
          onChange={(v) => set('updates.channel', v)}
          options={[
            { value: 'stable', label: t('settings.updates.stable') },
            { value: 'beta', label: t('settings.updates.beta') },
          ]}
        />
      </SettingRow>
      {u && u.status !== 'idle' && (
        <Note tone={u.status === 'error' ? 'warn' : u.status === 'up-to-date' ? 'ok' : undefined}>
          {u.status === 'up-to-date' ? t('status.update.latest') : u.status === 'error' ? (u.error ?? t('common.error')) : `${u.status}${u.latest ? ` · v${u.latest}` : ''}`}
        </Note>
      )}
      {info && !info.packaged && <Note>{t('status.update.dev')}</Note>}
      <div className="st-file__actions">
        <Button
          icon={<RefreshCw size={14} />}
          busy={checking}
          disabled={!info?.packaged}
          onClick={() => {
            setChecking(true);
            void api
              .invoke('update:check')
              .then((x) => updateStore.set(x))
              .finally(() => setChecking(false));
          }}
        >
          {t('status.update.check')}
        </Button>
      </div>
      <Note>{t('settings.updates.note')}</Note>
    </>
  );
}

// ---------- crash reports ----------
export function CrashReportsSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  return (
    <>
      <Switch label={t('settings.crash.send')} checked={bool(json, 'telemetry.crashReports', true)} onChange={(v) => set('telemetry.crashReports', v)} />
      <Note>{t('settings.crash.note')}</Note>
    </>
  );
}

// ---------- about ----------
export function AboutSection({ info, onShowOnboarding }: { info: AppInfo | null; onShowOnboarding: () => void }) {
  const t = useST();
  return (
    <>
      <SettingRow label="Solocut">
        <span className="st-value st-value--mono">
          v{info?.version ?? '—'}
          {info && !info.packaged ? ` (${t('settings.about.dev')})` : ''}
        </span>
      </SettingRow>
      <SettingRow label={t('settings.about.platform')}>
        <span className="st-value st-value--mono">
          {info?.os ?? '—'} / {info?.arch ?? '—'}
        </span>
      </SettingRow>
      <SettingRow label={t('settings.about.cli')}>
        {info?.cliAvailable ? <code className="st-value st-value--mono st-value--clip" title={info.cliPath}>{info.cliPath}</code> : <Badge tone="warning">{t('settings.about.cliMissing')}</Badge>}
      </SettingRow>
      <SettingRow label={t('settings.about.license')}>
        <span className="st-value">MIT</span>
      </SettingRow>
      <div className="st-file__actions">
        <Button variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void api.invoke('app:openExternal', 'https://solocut.app')}>
          solocut.app
        </Button>
        <Button variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void api.invoke('app:openExternal', 'https://github.com/JapanMarketing-Dev/solocut')}>
          GitHub
        </Button>
        <Button variant="ghost" onClick={onShowOnboarding}>
          {t('settings.about.onboarding')}
        </Button>
      </div>
    </>
  );
}
