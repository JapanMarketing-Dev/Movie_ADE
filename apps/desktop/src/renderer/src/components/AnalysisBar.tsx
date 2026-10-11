// Analysis producers status in the workspace: model download, per-source faces / OCR progress, masks added; cancellable.
import { useEffect, useState } from 'react';
import { ScanFace, ScanText, Square, Play } from 'lucide-react';
import type { AnalysisStatus } from '@shared/types';
import { useT } from '../i18n';
import { api, errMsg } from '../lib/api';

export function AnalysisBar({ dir, toast }: { dir: string; toast: (m: string) => void }) {
  const t = useT();
  const [s, setS] = useState<AnalysisStatus | null>(null);
  useEffect(() => {
    void api.invoke('analysis:status').then(setS);
    return api.on('analysis:state', setS);
  }, []);
  const mine = s && s.dir === dir ? s : null;
  const start = () => void api.invoke('analysis:start', dir).then(setS).catch((e: unknown) => toast(errMsg(e)));

  return (
    <div className="section">
      <div className="section-title">
        {t('an.title')}
        {mine?.running ? (
          <button className="btn ghost small" onClick={() => void api.invoke('analysis:cancel').then(setS)}>
            <Square size={11} fill="currentColor" /> {t('common.cancel')}
          </button>
        ) : (
          <button className="btn ghost small" disabled={Boolean(s?.running)} onClick={start} title={t('an.hint')}>
            <Play size={11} /> {t('an.run')}
          </button>
        )}
      </div>
      {!mine ? (
        <div className="dim" style={{ fontSize: 12 }}>
          {t('an.hint')}
        </div>
      ) : (
        <div className="an-jobs">
          {mine.phase === 'models' && (
            <div className="an-row">
              <span className="dim">{t('an.models')}</span>
              <div className="progress">
                <div style={{ width: `${Math.round((mine.modelProgress ?? 0) * 100)}%` }} />
              </div>
            </div>
          )}
          {mine.jobs.map((j) => (
            <div key={j.id} className="an-row" title={j.error}>
              {j.kind === 'faces' ? <ScanFace size={13} /> : <ScanText size={13} />}
              <span className="mono" style={{ fontSize: 11.5 }}>
                {j.sourceId}
              </span>
              <span className="dim" style={{ fontSize: 11.5 }}>
                {t(j.kind === 'faces' ? 'an.faces' : 'an.ocr')}
              </span>
              <span style={{ flex: 1 }} />
              {j.state === 'running' || j.state === 'queued' ? (
                <div className="progress">
                  <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
                </div>
              ) : (
                <span className={`pill ${j.state === 'done' ? 'okp' : j.state === 'failed' ? 'accent' : ''}`}>{j.state}</span>
              )}
            </div>
          ))}
          {mine.phase === 'done' && (
            <div className="dim" style={{ fontSize: 12 }}>
              {t('an.done', { n: String(mine.masksAdded ?? 0) })}
            </div>
          )}
          {mine.message && <div className={mine.phase === 'error' ? 'error' : 'dim'} style={{ fontSize: 12 }}>{mine.message}</div>}
        </div>
      )}
    </div>
  );
}
