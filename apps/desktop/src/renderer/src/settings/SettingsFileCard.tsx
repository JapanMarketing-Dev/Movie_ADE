import { Suspense, lazy, useState } from 'react';
import { Copy, FileJson, FolderOpen } from 'lucide-react';
import { api } from '../lib/api';
import { useST } from '../shell/i18n';
import { settingsStore, useStore } from '../shell/stores';
import { Button, Spinner, useToast } from '../ui';
import type { JsonFileKind } from './JsonFileEditor';

const JsonFileEditor = lazy(() => import('./JsonFileEditor'));

/**
 * The settings.json card at the top of the settings page (ported from Ferret
 * src/renderer/components/SettingsFileCard.tsx): where the file is, open it in the built-in Monaco editor, reveal it
 * in the file manager, and a prompt to hand to the agent ("change settings for me", docs/11 SET-2).
 */
export function SettingsFileCard({ kind = 'settings', defaultOpen = false }: { kind?: JsonFileKind; defaultOpen?: boolean }) {
  const t = useST();
  const toast = useToast();
  const s = useStore(settingsStore);
  const [open, setOpen] = useState(defaultOpen);
  const path = kind === 'settings' ? s.path : s.path.replace(/settings\.json$/, 'prompts.json');
  const prompt = t(kind === 'settings' ? 'settings.file.agentPrompt' : 'settings.prompts.agentPrompt', { path });
  const copy = () =>
    void navigator.clipboard
      .writeText(prompt)
      .then(() => toast({ tone: 'success', message: t('settings.file.copied') }))
      .catch(() => undefined);

  return (
    <section className="st-file" data-testid={`settings-file-${kind}`} aria-label={path}>
      <div className="st-file__head">
        <FileJson size={14} aria-hidden="true" />
        <code className="st-file__path" title={path}>
          {path || '…'}
        </code>
      </div>
      <p className="st-note">{t(kind === 'settings' ? 'settings.file.note' : 'settings.prompts.note')}</p>
      {kind === 'settings' && s.json === null && <p className="st-note st-note--warn">{t('settings.file.broken')}</p>}
      {kind === 'settings' && s.errors.length > 0 && (
        <p className="st-note st-note--warn">
          <code>{s.errors.slice(0, 3).join(' · ')}</code>
        </p>
      )}
      <div className="st-file__actions">
        <Button icon={<FileJson size={14} />} onClick={() => setOpen((v) => !v)} data-testid={`settings-file-open-${kind}`}>
          {t(open ? 'settings.file.close' : 'settings.file.open')}
        </Button>
        <Button variant="ghost" icon={<FolderOpen size={14} />} disabled={!path} onClick={() => void api.invoke('app:showInFolder', path)}>
          {t('settings.file.reveal')}
        </Button>
      </div>
      <details className="st-key">
        <summary>
          <span>{t('settings.file.agentTitle')}</span>
        </summary>
        <div className="st-key__body">
          <pre className="st-file__prompt">{prompt}</pre>
          <div className="st-key__actions">
            <Button variant="ghost" icon={<Copy size={14} />} onClick={copy}>
              {t('settings.file.copyPrompt')}
            </Button>
          </div>
        </div>
      </details>
      {open && (
        <Suspense fallback={<Spinner />}>
          <JsonFileEditor kind={kind} />
        </Suspense>
      )}
    </section>
  );
}
