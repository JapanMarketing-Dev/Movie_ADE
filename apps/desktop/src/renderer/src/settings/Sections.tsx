import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, ExternalLink, LogIn, LogOut, RefreshCw, RotateCcw } from 'lucide-react';
import type { AgentStatus, AppInfo, PromptButton } from '@shared/types';
import { ApiKeys } from '../components/ApiKeys';
import { api, errMsg } from '../lib/api';
import { resetIn, useAgentUsage } from '../shell/agentUsage';
import { useST, type SKey } from '../shell/i18n';
import { layoutStore, useLayout, PANELS, type Panel } from '../shell/layout';
import { SHORTCUT_SPECS, shortcutLabel, type ShortcutId } from '../shell/shortcut';
import { agentsStore, setSetting, toolsStore, updateStore, useStore } from '../shell/stores';
import { Badge, Button, Note, Progress, Segmented, Select, SettingRow, Switch, useToast, type SelectOption } from '../ui';
import { SettingsFileCard } from './SettingsFileCard';
import { getPath, moveItem, preferFirst } from './settingsSections';

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
  const stopBefore = list(json, 'autopilot.stopBefore', ['publish']);
  return (
    <>
      <Sub>{t('settings.general.autopilot')}</Sub>
      <Note>{t('settings.general.autopilotNote')}</Note>
      <Switch
        label={t('settings.general.stopBeforePublish')}
        checked={stopBefore.includes('publish')}
        onChange={(on) => set('autopilot.stopBefore', on ? [...new Set([...stopBefore, 'publish'])] : stopBefore.filter((x) => x !== 'publish'))}
      />
      <SettingRow label={t('settings.general.maxFixLoops')}>
        <Select
          ariaLabel={t('settings.general.maxFixLoops')}
          value={num(json, 'autopilot.maxFixLoops', 3)}
          options={[0, 1, 2, 3, 5, 8, 10].map((n) => ({ value: n, label: t('settings.general.times', { n: String(n) }) }))}
          onChange={(v) => set('autopilot.maxFixLoops', v)}
        />
      </SettingRow>
      <SettingRow label={t('settings.general.budget')}>
        <Select
          ariaLabel={t('settings.general.budget')}
          value={num(json, 'autopilot.budget.decisionUsd', 2)}
          options={[0, 0.5, 1, 2, 5, 10].map((n) => ({ value: n, label: `$${n}` }))}
          onChange={(v) => set('autopilot.budget.decisionUsd', v)}
        />
      </SettingRow>
      <Note>{t('settings.general.budgetNote')}</Note>
      <Sub>{t('settings.general.archive')}</Sub>
      <Switch label={t('settings.general.keepPreview')} checked={bool(json, 'archive.keepPreview', true)} onChange={(v) => set('archive.keepPreview', v)} />
      <Switch
        label={t('settings.general.autoRegister')}
        checked={list(json, 'archive.autoRegister', ['export', 'publish']).length > 0}
        onChange={(v) => set('archive.autoRegister', v ? ['export', 'publish'] : [])}
      />
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
  modeReview: 'mode.review',
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

// ---------- decision model ----------
const DECISION_PROVIDERS = ['auto', 'claude-cli', 'codex-cli', 'gemini-cli', 'ollama', 'openai', 'typesafe', 'off'] as const;
const CLI_AGENT: Record<string, string> = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'gemini-cli': 'gemini' };

export function DecisionSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const agents = useStore(agentsStore);
  const provider = str(json, 'decision.provider', 'auto');
  const order = list(json, 'agents.order', ['claude', 'codex', 'gemini']);
  const installed = (agents ?? []).filter((a) => a.installed && ['claude', 'codex', 'gemini'].includes(a.id));
  const auto = order.map((id) => installed.find((a) => a.id === id)).find(Boolean) ?? installed[0];
  const api_ = provider === 'openai' || provider === 'typesafe' || provider === 'ollama';
  const label = (p: string) => {
    if (p === 'auto') return t('settings.decision.auto');
    if (CLI_AGENT[p]) return t('settings.decision.cli', { agent: agents?.find((a) => a.id === CLI_AGENT[p])?.label ?? CLI_AGENT[p]! });
    if (p === 'off') return t('settings.decision.off');
    if (p === 'ollama') return t('settings.decision.ollama');
    return t('settings.decision.api', { name: p });
  };
  return (
    <>
      <Note>{t('settings.decision.intro')}</Note>
      <SettingRow label={t('settings.decision.provider')}>
        <Select ariaLabel={t('settings.decision.provider')} value={provider} options={DECISION_PROVIDERS.map((p) => ({ value: p, label: label(p) }))} onChange={(v) => set('decision.provider', v)} wide />
      </SettingRow>
      {agents === null ? null : provider === 'auto' ? (
        auto ? (
          <Note tone="ok">{t('settings.decision.autoUses', { agent: `${auto.label}${auto.version ? ` ${auto.version}` : ''}` })}</Note>
        ) : (
          <Note tone="warn">{t('settings.decision.noAgent')}</Note>
        )
      ) : CLI_AGENT[provider] && !installed.some((a) => a.id === CLI_AGENT[provider]) ? (
        <Note tone="warn">{t('settings.decision.notInstalled')}</Note>
      ) : null}
      {api_ && (
        <>
          <SettingRow label={t('settings.decision.model')}>
            <ModelInput value={str(json, 'decision.model', 'qwen3-vl')} onCommit={(v) => set('decision.model', v)} />
          </SettingRow>
          <Switch label={t('settings.decision.cloudConsent')} checked={bool(json, 'decision.cloudConsent', false)} onChange={(v) => set('decision.cloudConsent', v)} />
          <Note>{t('settings.decision.cloudNote')}</Note>
        </>
      )}
      <Sub>{t('settings.decision.limits')}</Sub>
      <SettingRow label={t('settings.decision.perProjectCalls')}>
        <Select
          ariaLabel={t('settings.decision.perProjectCalls')}
          value={num(json, 'decision.limits.perProjectCalls', 200)}
          options={[50, 100, 200, 500, 1000].map((n) => ({ value: n, label: String(n) }))}
          onChange={(v) => set('decision.limits.perProjectCalls', v)}
        />
      </SettingRow>
      <SettingRow label={t('settings.decision.perProjectUsd')}>
        <Select ariaLabel={t('settings.decision.perProjectUsd')} value={num(json, 'decision.limits.perProjectUsd', 2)} options={[0, 1, 2, 5, 10, 20].map((n) => ({ value: n, label: `$${n}` }))} onChange={(v) => set('decision.limits.perProjectUsd', v)} />
      </SettingRow>
      <SettingRow label={t('settings.decision.perDayUsd')}>
        <Select ariaLabel={t('settings.decision.perDayUsd')} value={num(json, 'decision.limits.perDayUsd', 5)} options={[0, 1, 5, 10, 20, 50].map((n) => ({ value: n, label: `$${n}` }))} onChange={(v) => set('decision.limits.perDayUsd', v)} />
      </SettingRow>
      <Note>{t('settings.decision.limitsNote')}</Note>
    </>
  );
}

function ModelInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="st-input"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() && draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------- image generation ----------
export function ImageGenSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const order = list(json, 'imageGen.order', ['codex', 'gemini', 'openai']);
  const first = order[0] ?? 'codex';
  return (
    <>
      <SettingRow label={t('settings.imageGen.provider')}>
        <Select
          ariaLabel={t('settings.imageGen.provider')}
          value={first}
          options={[
            { value: 'codex', label: t('settings.imageGen.codex') },
            { value: 'gemini', label: t('settings.imageGen.gemini') },
            { value: 'openai', label: t('settings.imageGen.openai') },
          ]}
          onChange={(v) => set('imageGen.order', preferFirst(order.length ? order : ['codex', 'gemini', 'openai'], v))}
          wide
        />
      </SettingRow>
      <Note>{t('settings.imageGen.note')}</Note>
      <SettingRow label={t('settings.imageGen.order')}>
        <span className="st-value st-value--mono">{order.join(' → ')}</span>
      </SettingRow>
    </>
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
  const usage = useAgentUsage();
  const agents = useStore(agentsStore);
  return (
    <>
      <Sub>{t('settings.accounts.agents')}</Sub>
      {usage.available ? (
        usage.usage.map((u) => (
          <div key={u.agent} className="usage-card">
            <div className="usage-card__head">
              <span className="agent-glyph" aria-hidden="true">
                {(u.agent[0] ?? '?').toUpperCase()}
              </span>
              <span className="usage-card__name">{agents?.find((a) => a.id === u.agent)?.label ?? u.agent}</span>
              {u.plan && <Badge>{u.plan}</Badge>}
              <span className="usage-card__account">{u.account ?? t('settings.accounts.notSignedIn')}</span>
            </div>
            {u.windows.map((w) => (
              <div key={w.label} className="usage-card__row">
                <span className="usage-card__label">{w.label}</span>
                <span className="usage-bar usage-bar--wide" aria-hidden="true">
                  <span className="usage-bar__fill" style={{ width: `${w.usedPercent}%` }} />
                </span>
                <span className="usage-card__pct">{Math.round(w.usedPercent)}%</span>
                <span className="usage-card__reset">{resetIn(w.resetsAt) && t('status.usage.resetsIn', { time: resetIn(w.resetsAt) })}</span>
              </div>
            ))}
          </div>
        ))
      ) : (
        <Note>{t('settings.accounts.pending')}</Note>
      )}
      <Sub>{t('settings.accounts.keys')}</Sub>
      <div className="st-legacy">
        <ApiKeys toast={(m) => toast({ message: m })} />
      </div>
    </>
  );
}

// ---------- prompts ----------
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
      <ul className="agent-requests__list">
        {(prompts ?? []).map((p) => (
          <li key={p.id} className="agent-requests__item">
            <div className="agent-requests__row">
              <span className="agent-requests__title">
                {p.autopilot && <Badge tone="brand">{t('settings.prompts.autopilot')}</Badge>}
                {p.label}
              </span>
              <code className="agent-requests__edited">{p.id}</code>
              {p.agent && <span className="agent-requests__edited">→ {p.agent}</span>}
            </div>
          </li>
        ))}
      </ul>
      <SettingsFileCard kind="prompts" />
    </>
  );
}

// ---------- library ----------
export function LibrarySection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const tools = useStore(toolsStore);
  return (
    <>
      <Sub>{t('settings.library.tools')}</Sub>
      {tools === null && <Progress label={t('common.loading')} />}
      {tools?.map((tool) => (
        <div key={tool.name}>
          <SettingRow label={<span className="st-value--mono">{tool.name}</span>}>
            {tool.installed ? <Badge tone="success">{tool.version ?? t('status.usage.installed')}</Badge> : <Badge tone="warning">{t('status.usage.notInstalled')}</Badge>}
          </SettingRow>
          {!tool.installed && <ToolInstallNote name={tool.name} />}
        </div>
      ))}
      <div className="st-file__actions">
        <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void toolsStore.reload()}>
          {t('common.refresh')}
        </Button>
      </div>
      <Sub>{t('settings.library.assets')}</Sub>
      <SettingRow label={t('settings.library.cache')}>
        <Select ariaLabel={t('settings.library.cache')} value={num(json, 'library.cacheLimitGB', 2)} options={[1, 2, 5, 10, 20, 50].map((n) => ({ value: n, label: `${n} GB` }))} onChange={(v) => set('library.cacheLimitGB', v)} />
      </SettingRow>
      <Switch label={t('settings.library.credits')} checked={bool(json, 'library.autoCredits', true)} onChange={(v) => set('library.autoCredits', v)} />
      <Note>{t('settings.library.note')}</Note>
    </>
  );
}

// ---------- publishing ----------
const TARGETS = ['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels'] as const;
export function PublishingSection({ json }: { json: Json }) {
  const t = useST();
  const set = useSet();
  const toast = useToast();
  const [yt, setYt] = useState<{ clientSet: boolean; connected: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api.invoke('publish:youtubeStatus').then(setYt).catch(() => setYt(null));
  useEffect(load, []);
  const targets = list(json, 'export.defaultTargets', ['youtube']);
  const connect = async () => {
    setBusy(true);
    const r = await api.invoke('publish:youtubeConnect').catch((e: unknown) => ({ ok: false, error: errMsg(e) }));
    setBusy(false);
    if (!r.ok) toast({ tone: 'danger', message: r.error ?? t('common.error') });
    load();
  };
  return (
    <>
      <Sub>YouTube</Sub>
      <SettingRow label={t('settings.publishing.youtube')}>
        {yt?.connected ? (
          <span className="st-inline">
            <Badge tone="success">{t('settings.publishing.connected')}</Badge>
            <Button size="sm" variant="ghost" icon={<LogOut size={13} />} onClick={() => void api.invoke('publish:youtubeDisconnect').then(load)}>
              {t('settings.publishing.disconnect')}
            </Button>
          </span>
        ) : (
          <Button size="sm" icon={<LogIn size={13} />} busy={busy} disabled={!yt?.clientSet} onClick={() => void connect()}>
            {t('settings.publishing.connect')}
          </Button>
        )}
      </SettingRow>
      {yt && !yt.clientSet && <Note tone="warn">{t('settings.publishing.clientMissing')}</Note>}
      <Note>{t('settings.publishing.note')}</Note>
      <Sub>{t('settings.publishing.targets')}</Sub>
      {TARGETS.map((x) => (
        <Switch
          key={x}
          label={t(`target.${x}`)}
          checked={targets.includes(x)}
          onChange={(on) => set('export.defaultTargets', on ? [...targets.filter((y) => y !== x), x] : targets.filter((y) => y !== x))}
        />
      ))}
      <Switch label={t('settings.publishing.hwEncode')} checked={bool(json, 'export.hwEncodePreview', true)} onChange={(v) => set('export.hwEncodePreview', v)} />
    </>
  );
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
