import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Info, LogIn, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { ACCOUNT_AGENTS, accountDisplayName, type AccountAgent, type AgentAccountSummary, type AgentAccountsView } from '@shared/accounts';
import { clampUsedPercent, soonestResetLabel, usageSections, usageStatusLabel, usageTone, type AccountUsage, type UsageSection } from '@shared/usage';
import { api, errMsg } from '../lib/api';
import { LangContext } from '../i18n';
import { Badge, Button, IconButton, Modal, TextField } from '../ui';
import { useST } from '../shell/i18n';
import { accountActions, useAgentAccounts } from '../shell/agentAccounts';
import { AGENT_LABEL, accountStatus, breakdownRows, canSelect, isPendingLogin, selectKey, type AccountStatus } from '../shell/accountsModel';
import { acquireTerminal, releaseTerminal } from '../terminal/terminalClient';
import '../terminal/terminal.css';
import '../styles/accounts.css';

/**
 * Claude Code / Codex accounts (ported from Ferret src/renderer/components/UsageMeter.tsx AccountBreakdown and
 * AccountsSection.tsx, MIT; Orca由来: ClaudeSwitcherMenu.tsx / AccountsPane.tsx, MIT, Copyright 2026 Lovecast Inc.).
 *
 *   AccountBreakdown     … footer usage popover → 「>」: usage per account, switch, add
 *   AgentAccountsPanel   … Settings → アカウント: system default + added accounts, switch / add / sign in / rename / remove
 *   AccountLoginDialog   … the login terminal main opened (accounts:startLogin), mounted once by App
 *
 * Both lists read the same store (shell/agentAccounts.ts), so a switch in one shows in the other.
 */

export function AgentGlyph({ agent }: { agent: string }) {
  return (
    <span className={`agent-glyph agent-glyph--${agent.replace(/[^a-z0-9-]/gi, '')}`} aria-hidden="true">
      {(agent[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** advance the "resets in" labels once a minute */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function UsageMetric({ section }: { section: UsageSection }) {
  const used = clampUsedPercent(section.window.usedPercent);
  return (
    <span className="usage-metric">
      <span className="usage-metric__label">{section.label}</span>
      <span className="usage-bar" data-tone={usageTone(used)} aria-hidden="true">
        <span className="usage-bar__fill" style={{ width: `${used}%` }} />
      </span>
      <span className="usage-metric__value" data-tone={usageTone(used)}>
        {used}%
      </span>
    </span>
  );
}

const STATUS_KEY: Record<Exclude<AccountStatus, 'ok'>, 'acct.status.pending' | 'acct.status.relogin' | 'acct.status.unusable'> = {
  pending: 'acct.status.pending',
  relogin: 'acct.status.relogin',
  unusable: 'acct.status.unusable',
};

/** the footer popover's per-account view of one agent */
export function AccountBreakdown({ agent, onBack, onManage }: { agent: AccountAgent; onBack: () => void; onManage?: () => void }) {
  const t = useST();
  const lang = useContext(LangContext);
  const now = useMinuteClock();
  const { state, action, error, switched, duplicates } = useAgentAccounts();
  const [rows, setRows] = useState<AccountUsage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      try {
        setRows(await api.invoke('usage:accounts', agent, force));
        setLoadError(null);
      } catch (e) {
        setLoadError(errMsg(e));
      }
    },
    [agent],
  );
  // re-read when the registry changes (switched, logged in, removed)
  useEffect(() => {
    void load(false);
  }, [load, state]);
  useEffect(() => () => accountActions.clearSwitched(), []);

  const busy = action !== 'idle';
  const view = state?.[agent];
  const pending = view?.accounts.filter(isPendingLogin).length ?? 0;
  const list = rows ? breakdownRows(rows, view) : null;
  const justSwitched = switched?.agent === agent ? switched : null;

  return (
    <div className="usage-panel__drill" data-testid={`usage-accounts-${agent}`}>
      <div className="usage-panel__head">
        <button type="button" className="usage-panel__back" onClick={onBack} aria-label={t('acct.back')} title={t('acct.back')}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <AgentGlyph agent={agent} />
        <span className="usage-panel__title">{t('acct.accountsOf', { agent: AGENT_LABEL[agent] })}</span>
        <button type="button" className="usage-panel__icon" onClick={() => void load(true)} aria-label={t('acct.reload')} title={t('acct.reload')}>
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="usage-panel__rule" />
      <div role="menu" aria-label={t('acct.accountsOf', { agent: AGENT_LABEL[agent] })}>
        {list === null && !loadError && <p className="usage-panel__empty">{t('acct.loading')}</p>}
        {list?.map((row) => {
          const sections = row.rateLimits ? usageSections(row.rateLimits) : [];
          const reset = row.rateLimits && sections.length > 0 ? soonestResetLabel(row.rateLimits, now, lang) : null;
          return (
            <button
              key={row.accountId ?? 'system'}
              type="button"
              role="menuitemradio"
              aria-checked={row.active}
              className="usage-row usage-account"
              disabled={busy || row.active || !row.selectable}
              title={row.active ? t('acct.selected') : row.selectable ? t('acct.useThis') : undefined}
              onClick={() => void accountActions.select(agent, row.accountId)}
              data-testid={`usage-account-${row.accountId ?? 'system'}`}
            >
              <span className="usage-account__check">{row.active && <Check size={12} strokeWidth={2.5} />}</span>
              <span className="usage-row__body">
                <span className="usage-row__head">
                  <span className="usage-row__name">{row.accountId === null ? `${t('acct.systemDefault')} · ${row.label}` : row.label}</span>
                  {row.active && <span className="usage-account__active">{t('acct.selected')}</span>}
                  {row.status !== 'ok' && <span className="usage-account__state">{t(STATUS_KEY[row.status])}</span>}
                  {reset && <span className="usage-row__reset">{reset}</span>}
                </span>
                {sections.length > 0 ? (
                  <span className="usage-row__metrics usage-row__metrics--flush">
                    {sections.map((s) => (
                      <UsageMetric key={s.key} section={s} />
                    ))}
                  </span>
                ) : (
                  <span className="usage-row__status">{row.rateLimits ? usageStatusLabel(row.rateLimits, lang) : t('acct.loading')}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {pending > 0 && <p className="usage-panel__empty">{t('acct.pendingCount', { n: String(pending) })}</p>}
      {(error || loadError) && (
        <p className="account-switcher__error" role="alert">
          {error ?? loadError}
        </p>
      )}
      {duplicates.length > 0 && <p className="account-switcher__error">{t('acct.duplicate', { names: duplicates.join(', ') })}</p>}
      <p className={`account-switcher__note${justSwitched ? ' is-emphasis' : ''}`} role={justSwitched ? 'status' : undefined}>
        <Info size={12} strokeWidth={2} aria-hidden="true" />
        <span>
          {justSwitched ? `${t('acct.switched', { agent: AGENT_LABEL[agent] })} ` : ''}
          {t('acct.switchNote', { agent: AGENT_LABEL[agent] })}
          {justSwitched && justSwitched.switchingTabs > 0 ? ` ${t('acct.switchingTabs', { n: String(justSwitched.switchingTabs) })}` : ''}
        </span>
      </p>
      <div className="usage-panel__rule" />
      <button type="button" className="usage-panel__link" disabled={busy} onClick={() => void accountActions.add(agent)} data-testid={`usage-add-${agent}`}>
        <Plus size={13} aria-hidden="true" />
        <span>{t('acct.add')}</span>
      </button>
      {onManage && (
        <button type="button" className="usage-panel__link" onClick={onManage}>
          <span>{t('acct.manage')}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function AccountRow({ agent, account, active, busyKey }: { agent: AccountAgent; account: AgentAccountSummary; active: boolean; busyKey: string }) {
  const t = useST();
  const lang = useContext(LangContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = busyKey !== 'idle';
  const status = accountStatus(account);
  const name = accountDisplayName(account, lang);
  const detail =
    account.problem ??
    (status === 'pending' ? t('acct.pendingDetail') : [account.label.trim() ? account.email : null, account.workspaceLabel].filter(Boolean).join(' · '));

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== account.label) void accountActions.rename(agent, account.id, draft);
  };

  return (
    <div className={`acct-row${active ? ' is-active' : ''}`} data-testid={`account-row-${account.id}`}>
      {editing ? (
        <div className="acct-row__edit">
          <TextField
            autoFocus
            value={draft}
            placeholder={account.email ?? t('acct.namePlaceholder', { agent: AGENT_LABEL[agent] })}
            aria-label={t('acct.nameLabel')}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setDraft(account.label);
                setEditing(false);
              }
            }}
          />
          <IconButton size="sm" label={t('acct.saveName')} icon={<Check size={14} />} onClick={commit} />
          <IconButton
            size="sm"
            label={t('common.cancel')}
            icon={<X size={14} />}
            onClick={() => {
              setDraft(account.label);
              setEditing(false);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="acct-row__main"
          onClick={() => void accountActions.select(agent, account.id)}
          disabled={busy || active || !canSelect(account)}
          aria-pressed={active}
          title={active ? t('acct.selected') : canSelect(account) ? t('acct.useThis') : undefined}
        >
          <span className="acct-row__radio" aria-hidden="true">
            {active && <Check size={12} strokeWidth={2.5} />}
          </span>
          <span className="acct-row__text">
            <span className="acct-row__name">
              <span className="acct-row__label" title={name}>
                {name}
              </span>
              {active && <Badge tone="brand">{t('acct.selected')}</Badge>}
              {status !== 'ok' && <Badge tone={status === 'pending' ? 'neutral' : 'warning'}>{t(STATUS_KEY[status])}</Badge>}
            </span>
            {detail && (
              <span className={`acct-row__detail${account.problem ? ' is-warn' : ''}`} title={detail}>
                {detail}
              </span>
            )}
          </span>
        </button>
      )}
      {!editing && !confirmRemove && (
        <div className="acct-row__actions">
          {(status === 'pending' || status === 'relogin') && (
            <Button variant="ghost" size="sm" icon={<LogIn size={14} />} busy={busyKey === `login:${account.id}`} disabled={busy} onClick={() => void accountActions.login(agent, account.id)}>
              {status === 'pending' ? t('acct.login') : t('acct.relogin')}
            </Button>
          )}
          <IconButton
            size="sm"
            label={t('acct.rename')}
            icon={<Pencil size={14} />}
            disabled={busy}
            onClick={() => {
              setDraft(account.label);
              setEditing(true);
            }}
          />
          <IconButton size="sm" label={t('acct.remove')} icon={<Trash2 size={14} />} disabled={busy} onClick={() => setConfirmRemove(true)} />
        </div>
      )}
      {confirmRemove && (
        <div className="acct-row__confirm" role="alertdialog" aria-label={t('acct.remove')}>
          <span>{t('acct.removeConfirm')}</span>
          <Button variant="danger" size="sm" busy={busyKey === `remove:${account.id}`} onClick={() => void accountActions.remove(agent, account.id)}>
            {t('acct.remove')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentGroup({ agent, view, action }: { agent: AccountAgent; view: AgentAccountsView | undefined; action: string }) {
  const t = useST();
  const { switched } = useAgentAccounts();
  const busy = action !== 'idle';
  const systemActive = !!view && view.activeAccountId === null;
  const system = view?.systemDefault;
  const systemDetail = system?.email
    ? t('acct.system.email', { agent: AGENT_LABEL[agent], email: system.email })
    : system?.signedIn
      ? t('acct.system.signedIn', { agent: AGENT_LABEL[agent] })
      : t('acct.system.signedOut', { agent: AGENT_LABEL[agent] });
  return (
    <div className="acct-group" data-testid={`accounts-${agent}`}>
      <div className="acct-group__head">
        <span className="acct-group__title">
          <AgentGlyph agent={agent} />
          {AGENT_LABEL[agent]}
        </span>
        <Button size="sm" icon={<Plus size={14} />} busy={action === `add:${agent}`} disabled={busy} onClick={() => void accountActions.add(agent)} data-testid={`accounts-add-${agent}`}>
          {t('acct.add')}
        </Button>
      </div>
      <div className={`acct-row${systemActive ? ' is-active' : ''}`}>
        <button
          type="button"
          className="acct-row__main"
          onClick={() => void accountActions.select(agent, null)}
          disabled={busy || systemActive || !view}
          aria-pressed={systemActive}
          title={systemActive ? t('acct.selected') : t('acct.useThis')}
        >
          <span className="acct-row__radio" aria-hidden="true">
            {systemActive && <Check size={12} strokeWidth={2.5} />}
          </span>
          <span className="acct-row__text">
            <span className="acct-row__name">
              {t('acct.systemDefault')}
              {systemActive && <Badge tone="brand">{t('acct.selected')}</Badge>}
              {action === selectKey(agent, null) && <Badge>…</Badge>}
            </span>
            <span className="acct-row__detail" title={systemDetail}>
              {systemDetail}
            </span>
          </span>
        </button>
      </div>
      {view && view.accounts.length === 0 && <p className="acct-group__empty">{t('acct.empty')}</p>}
      {view?.accounts.map((a) => <AccountRow key={a.id} agent={agent} account={a} active={view.activeAccountId === a.id} busyKey={action} />)}
      {switched?.agent === agent && (
        <p className="st-note st-note--ok" role="status">
          <Check size={12} aria-hidden="true" />
          {t('acct.switched', { agent: AGENT_LABEL[agent] })}
          {switched.switchingTabs > 0 ? ` ${t('acct.switchingTabs', { n: String(switched.switchingTabs) })}` : ''}
        </p>
      )}
    </div>
  );
}

/** Settings → アカウント: the same accounts as the footer switcher. */
export function AgentAccountsPanel() {
  const t = useST();
  const { state, action, error, duplicates } = useAgentAccounts();
  return (
    <div className="acct-panel" data-testid="settings-agent-accounts">
      <p className="st-note">
        <Info size={12} aria-hidden="true" />
        {t('acct.intro')}
      </p>
      {error && (
        <p className="st-note st-note--warn" role="alert">
          {error}
        </p>
      )}
      {duplicates.length > 0 && <p className="st-note st-note--warn">{t('acct.duplicate', { names: duplicates.join(', ') })}</p>}
      {ACCOUNT_AGENTS.map((agent) => (
        <AgentGroup key={agent} agent={agent} view={state?.[agent]} action={action} />
      ))}
    </div>
  );
}

/** The login terminal of an account being added / signed in again. Closes by itself once the login is confirmed. */
export function AccountLoginDialog() {
  const t = useST();
  const { state, login } = useAgentAccounts();
  if (!login) return null;
  const account = state?.[login.agent].accounts.find((a) => a.id === login.accountId);
  const signedIn = !!account && account.signedIn && !isPendingLogin(account);
  return <LoginTerminal key={login.tabId} tabId={login.tabId} title={t('acct.loginTitle', { agent: AGENT_LABEL[login.agent] })} signedIn={signedIn} />;
}

/** close the dialog this long after the login is confirmed (the user sees "signed in" first) */
const CLOSE_AFTER_LOGIN_MS = 1500;

function LoginTerminal({ tabId, title, signedIn }: { tabId: string; title: string; signedIn: boolean }) {
  const t = useST();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [exited, setExited] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = `account-login:${tabId}`;

  useEffect(() => {
    const handle = acquireTerminal(key);
    let alive = true;
    void api
      .invoke('terminal:attach', tabId)
      .then((info) => {
        if (!alive) return;
        if (!info) return setFailed(true);
        handle.reattach(info.id, info.history, info.size, false);
        if (hostRef.current) handle.open(hostRef.current);
        handle.focus();
      })
      .catch(() => alive && setFailed(true));
    const off = api.on('terminal:exit', (id) => {
      if (id === tabId) setExited(true);
    });
    return () => {
      alive = false;
      off();
      // closes the login process too when the dialog is closed early
      releaseTerminal(key);
    };
  }, [key, tabId]);

  useEffect(() => {
    if (!signedIn) return;
    const id = window.setTimeout(() => accountActions.loginClosed(), CLOSE_AFTER_LOGIN_MS);
    return () => window.clearTimeout(id);
  }, [signedIn]);

  return (
    <Modal label={title} className="acct-login-modal" onClose={() => accountActions.loginClosed()}>
      <div className="acct-login" data-testid="account-login">
        <div className="acct-login__head">
          <LogIn size={14} aria-hidden="true" />
          <span className="acct-login__title">{title}</span>
          <IconButton size="sm" label={t('acct.loginClose')} icon={<X size={14} />} onClick={() => accountActions.loginClosed()} />
        </div>
        <p className={`acct-login__lead${signedIn ? ' is-ok' : ''}`} role="status">
          {failed ? t('acct.loginNoTerminal') : signedIn ? t('acct.loginDone') : exited ? t('acct.loginExited') : t('acct.loginLead')}
        </p>
        <div className="acct-login__term" ref={hostRef} />
        <div className="acct-login__foot">
          <Button variant={signedIn || exited ? 'primary' : 'ghost'} onClick={() => accountActions.loginClosed()}>
            {t('acct.loginClose')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
