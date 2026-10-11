import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, CircleAlert, Copy, Download, FolderOpen, Mic, Monitor, Plus, RefreshCw } from 'lucide-react';
import type { MediaPermissionState } from '@shared/types';
import iconUrl from '../assets/icon.svg';
import { api, errMsg } from '../lib/api';
import { ESSENTIAL_TOOLS, summarizeTools } from '../shell/format';
import { useST, type SKey } from '../shell/i18n';
import { agentsStore, setSetting, settingsStore, toolsStore, useStore } from '../shell/stores';
import { Button, Modal, Progress, Segmented, Spinner, useToast } from '../ui';
import { ONBOARDING_STEPS, goToStep, initialOnboarding, isLastStep, nextStep, prevStep, stepIndex, videosRootChosen, type OnboardingStep } from './flow';

/**
 * First-run flow (ported in spirit from Ferret src/renderer/onboarding/OnboardingFlow.tsx / OnboardingSteps.tsx and
 * adapted to Solocut): language → agents found on this machine → tools (ffmpeg / whisper / fonts through
 * `solocut lib install`) → camera / mic / screen permissions → the first project.
 * Every step can be skipped; nothing here is required to use the app.
 */
export function OnboardingFlow({ onClose: close, onNewProject, onOpenFolder }: { onClose: (how: 'done' | 'skipped') => void; onNewProject: () => void; onOpenFolder: () => void }) {
  const t = useST();
  const [state, setState] = useState(initialOnboarding);
  const step = state.step;
  const settings = useStore(settingsStore);
  // finishing the flow accepts the master folder shown on the last step (the default unless changed there)
  const onClose = (how: 'done' | 'skipped') => {
    if (how === 'done' && settings.loaded && settings.json !== null && !videosRootChosen(settings.json)) {
      void api.invoke('videos:list').then((l) => setSetting('videos.root', l.root)).catch(() => undefined);
    }
    close(how);
  };
  return (
    <Modal className="onb-modal" label={t('onb.title')} onClose={() => onClose('skipped')}>
      <div className="onb" data-testid="onboarding">
        <header className="onb__head">
          <img src={iconUrl} width={22} height={22} alt="" />
          <span className="onb__brand">Solocut</span>
          <ol className="onb__steps" aria-label={t('onb.steps')}>
            {ONBOARDING_STEPS.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  className={`onb__step${s === step ? ' is-current' : ''}${state.visited.includes(s) && stepIndex(s) < stepIndex(step) ? ' is-done' : ''}`}
                  disabled={!state.visited.includes(s)}
                  onClick={() => setState((x) => goToStep(x, s))}
                >
                  <span className="onb__step-num">{stepIndex(s) < stepIndex(step) ? <Check size={11} strokeWidth={2.5} /> : i + 1}</span>
                  <span className="onb__step-label">{t(`onb.step.${s}`)}</span>
                </button>
              </li>
            ))}
          </ol>
          <Button variant="ghost" onClick={() => onClose('skipped')}>
            {t('onb.skip')}
          </Button>
        </header>
        <div className="onb__body">
          {step === 'language' && <LanguageStep />}
          {step === 'agents' && <AgentsStep />}
          {step === 'tools' && <ToolsStep />}
          {step === 'permissions' && <PermissionsStep />}
          {step === 'project' && (
            <ProjectStep
              onNew={() => {
                onClose('done');
                onNewProject();
              }}
              onOpen={() => {
                onClose('done');
                onOpenFolder();
              }}
            />
          )}
        </div>
        <footer className="onb__foot">
          <Button variant="ghost" icon={<ArrowLeft size={14} />} disabled={stepIndex(step) === 0} onClick={() => setState(prevStep)}>
            {t('onb.back')}
          </Button>
          <span className="onb__count">
            {stepIndex(step) + 1} / {ONBOARDING_STEPS.length}
          </span>
          {isLastStep(step) ? (
            <Button variant="primary" onClick={() => onClose('done')}>
              {t('onb.finish')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setState(nextStep)} data-testid="onboarding-next">
              {t('onb.next')}
              <ArrowRight size={14} />
            </Button>
          )}
        </footer>
      </div>
    </Modal>
  );
}

function StepHead({ step, children }: { step: OnboardingStep; children?: React.ReactNode }) {
  const t = useST();
  return (
    <div className="onb__intro">
      <h2 className="onb__title">{t(`onb.${step}.title`)}</h2>
      <p className="onb__lead">{t(`onb.${step}.lead`)}</p>
      {children}
    </div>
  );
}

function LanguageStep() {
  const t = useST();
  const s = useStore(settingsStore);
  const lang = s.json?.language === 'en' ? 'en' : 'ja';
  return (
    <>
      <StepHead step="language" />
      <div className="onb__center">
        <Segmented
          ariaLabel={t('settings.language.ui')}
          value={lang}
          onChange={(v) => void setSetting('language', v)}
          options={[
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
          ]}
        />
      </div>
      <ul className="onb__points">
        <li>{t('onb.language.p1')}</li>
        <li>{t('onb.language.p2')}</li>
        <li>{t('onb.language.p3')}</li>
      </ul>
    </>
  );
}

function AgentsStep() {
  const t = useST();
  const toast = useToast();
  const agents = useStore(agentsStore);
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    void agentsStore.reload().finally(() => setChecking(false));
  };
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast({ tone: 'success', message: t('settings.file.copied') }))
      .catch(() => undefined);
  const any = (agents ?? []).some((a) => a.installed);
  return (
    <>
      <StepHead step="agents" />
      <div className="onb__list">
        {agents === null && <Spinner />}
        {(agents ?? []).map((a) => (
          <div key={a.id} className={`onb__row${a.installed ? ' is-ok' : ''}`}>
            <span className="agent-glyph" aria-hidden="true">
              {(a.label[0] ?? '?').toUpperCase()}
            </span>
            <span className="onb__row-name">{a.label}</span>
            {a.installed ? (
              <span className="onb__row-state is-ok">
                <Check size={13} /> {a.version ?? t('status.usage.installed')}
              </span>
            ) : (
              <>
                <code className="onb__row-cmd" title={a.install}>
                  {a.install}
                </code>
                <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={() => copy(a.install)}>
                  {t('settings.agents.copy')}
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      <p className={`onb__note${any ? ' is-ok' : ' is-warn'}`}>{any ? t('onb.agents.found') : t('onb.agents.none')}</p>
      <div className="onb__actions">
        <Button variant="ghost" icon={<RefreshCw size={14} />} busy={checking} onClick={recheck}>
          {t('onb.recheck')}
        </Button>
      </div>
    </>
  );
}

const TOOL_DESC: Record<string, SKey> = {
  ffmpeg: 'onb.tool.ffmpeg',
  ffprobe: 'onb.tool.ffprobe',
  'whisper-cli': 'onb.tool.whisper-cli',
  'whisper-model': 'onb.tool.whisper-model',
  fonts: 'onb.tool.fonts',
};

function ToolsStep() {
  const t = useST();
  const tools = useStore(toolsStore);
  const [progress, setProgress] = useState<Record<string, number | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => api.on('tools:progress', (name, received, total) => setProgress((p) => (name in p ? { ...p, [name]: total ? received / total : null } : p))), []);
  const install = async (name: string) => {
    setProgress((p) => ({ ...p, [name]: null }));
    setErrors((e) => {
      const n = { ...e };
      delete n[name];
      return n;
    });
    try {
      const r = await api.invoke('tools:install', name);
      if (!r.ok) setErrors((e) => ({ ...e, [name]: r.error ?? t('common.error') }));
    } catch (e) {
      setErrors((x) => ({ ...x, [name]: errMsg(e) }));
    }
    setProgress((p) => {
      const n = { ...p };
      delete n[name];
      return n;
    });
    await toolsStore.reload();
  };
  const essentials = (tools ?? []).filter((x) => (ESSENTIAL_TOOLS as readonly string[]).includes(x.name));
  const missing = essentials.filter((x) => !x.installed);
  const sum = summarizeTools(tools);
  const installAll = async () => {
    // ffmpeg and ffprobe come from one archive; install each library once, in order
    const seen = new Set<string>();
    for (const x of missing) {
      const lib = x.name === 'ffprobe' ? 'ffmpeg' : x.name === 'whisper-model' ? 'whisper-cli' : x.name;
      if (seen.has(lib)) continue;
      seen.add(lib);
      await install(x.name);
    }
  };
  return (
    <>
      <StepHead step="tools" />
      <div className="onb__list">
        {tools === null && <Spinner />}
        {essentials.map((x) => (
          <div key={x.name} className={`onb__row${x.installed ? ' is-ok' : ''}`}>
            {x.installed ? <Check size={14} className="is-ok" /> : <CircleAlert size={14} className="is-warn" />}
            <span className="onb__row-name onb__row-name--mono">{x.name}</span>
            <span className="onb__row-desc">{TOOL_DESC[x.name] ? t(TOOL_DESC[x.name]!) : ''}</span>
            {x.installed ? (
              <span className="onb__row-state is-ok">{x.version ?? t('status.usage.installed')}</span>
            ) : x.name in progress ? (
              <span className="onb__row-progress">
                <Progress {...(progress[x.name] != null ? { value: progress[x.name]! } : {})} label={x.name} />
              </span>
            ) : (
              <Button size="sm" icon={<Download size={13} />} onClick={() => void install(x.name)}>
                {t('status.tools.install')}
              </Button>
            )}
            {errors[x.name] && <span className="onb__row-error">{errors[x.name]}</span>}
          </div>
        ))}
      </div>
      <p className={`onb__note${sum.ok ? ' is-ok' : ''}`}>{sum.ok ? t('onb.tools.ready') : t('onb.tools.note')}</p>
      {missing.length > 0 && (
        <div className="onb__actions">
          <Button icon={<Download size={14} />} disabled={Object.keys(progress).length > 0} onClick={() => void installAll()}>
            {t('onb.tools.all')}
          </Button>
        </div>
      )}
    </>
  );
}

function PermissionsStep() {
  const t = useST();
  const [perm, setPerm] = useState<MediaPermissionState | null>(null);
  const load = () => void api.invoke('app:permissions').then(setPerm).catch(() => setPerm(null));
  useEffect(load, []);
  const ask = async (kind: 'camera' | 'microphone') => {
    await api.invoke('app:askMediaAccess', kind).catch(() => false);
    load();
  };
  const row = (icon: React.ReactNode, name: string, state: string | undefined, action: React.ReactNode) => {
    const ok = state === 'granted';
    return (
      <div className={`onb__row${ok ? ' is-ok' : ''}`}>
        {icon}
        <span className="onb__row-name">{name}</span>
        <span className={`onb__row-state${ok ? ' is-ok' : ''}`}>{ok ? t('onb.perm.granted') : state ? t('onb.perm.state', { state }) : '…'}</span>
        {!ok && action}
      </div>
    );
  };
  return (
    <>
      <StepHead step="permissions" />
      <div className="onb__list">
        {row(
          <Camera size={14} />,
          t('onb.perm.camera'),
          perm?.camera,
          <Button size="sm" onClick={() => void ask('camera')}>
            {t('onb.perm.allow')}
          </Button>,
        )}
        {row(
          <Mic size={14} />,
          t('onb.perm.mic'),
          perm?.microphone,
          <Button size="sm" onClick={() => void ask('microphone')}>
            {t('onb.perm.allow')}
          </Button>,
        )}
        {row(
          <Monitor size={14} />,
          t('onb.perm.screen'),
          perm?.screen,
          <Button size="sm" onClick={() => void api.invoke('app:openScreenSettings')}>
            {t('onb.perm.open')}
          </Button>,
        )}
      </div>
      <p className="onb__note">{t('onb.perm.note')}</p>
      <div className="onb__actions">
        <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={load}>
          {t('onb.recheck')}
        </Button>
      </div>
    </>
  );
}

function ProjectStep({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  const t = useST();
  const toast = useToast();
  const [root, setRoot] = useState('');
  useEffect(() => void api.invoke('videos:list').then((l) => setRoot(l.root)).catch(() => undefined), []);
  const change = async () => {
    const d = await api.invoke('app:chooseFolder', t('onb.project.root'));
    if (!d) return;
    const err = await setSetting('videos.root', d);
    if (err) toast({ tone: 'danger', message: err });
    else setRoot(d);
  };
  return (
    <>
      <StepHead step="project" />
      <div className="onb__list onb__root">
        <div className="onb__row">
          <FolderOpen size={14} />
          <span className="onb__row-name">{t('onb.project.root')}</span>
          <code className="onb__row-cmd" title={root}>
            {root || '…'}
          </code>
          <Button size="sm" onClick={() => void change()}>
            {t('onb.project.rootChange')}
          </Button>
        </div>
      </div>
      <div className="onb__cards">
        <button type="button" className="onb__card" onClick={onNew}>
          <Plus size={18} />
          <span className="onb__card-title">{t('onb.project.new')}</span>
          <span className="onb__card-desc">{t('onb.project.newDesc')}</span>
        </button>
        <button type="button" className="onb__card" onClick={onOpen}>
          <FolderOpen size={18} />
          <span className="onb__card-title">{t('onb.project.open')}</span>
          <span className="onb__card-desc">{t('onb.project.openDesc')}</span>
        </button>
      </div>
      <ol className="onb__flow">
        <li>{t('onb.project.f1')}</li>
        <li>{t('onb.project.f2')}</li>
        <li>{t('onb.project.f3')}</li>
        <li>{t('onb.project.f4')}</li>
        <li>{t('onb.project.f5')}</li>
      </ol>
    </>
  );
}
