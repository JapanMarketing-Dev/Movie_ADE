// Normalises the stored account registry (~/.solocut/accounts/accounts.json) to the expected shape.
// Like Orca's pruneInvalidCodexRuntimeSelection, a selection that points to a missing account falls back to the
// system default (null).
//
// Ported from Ferret src/main/accounts/sanitize.ts (MIT).
import { EMPTY_AGENT_ACCOUNTS, isAccountAgent, type AccountAgent, type AgentAccount, type AgentAccountList, type AgentAccountsSettings } from '../../shared/accounts';
import type { Lang } from '../../shared/types';
import { isValidAccountId } from './paths';
import { AccountsUserError, msg } from './messages';

const LABEL_MAX = 80;

const time = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function sanitizeAccount(raw: unknown): AgentAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AgentAccount>;
  if (!isValidAccountId(r.id)) return null;
  const createdAt = time(r.createdAt, 0);
  return {
    id: r.id,
    label: typeof r.label === 'string' ? r.label.trim().slice(0, LABEL_MAX) : '',
    email: text(r.email),
    workspaceLabel: text(r.workspaceLabel),
    createdAt,
    updatedAt: time(r.updatedAt, createdAt),
    lastAuthenticatedAt: typeof r.lastAuthenticatedAt === 'number' ? time(r.lastAuthenticatedAt, 0) : null,
  };
}

function sanitizeList(raw: unknown): AgentAccountList {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentAccountList>;
  const seen = new Set<string>();
  const accounts = (Array.isArray(r.accounts) ? r.accounts : []).flatMap((a): AgentAccount[] => {
    const account = sanitizeAccount(a);
    if (!account || seen.has(account.id)) return [];
    seen.add(account.id);
    return [account];
  });
  const activeAccountId = accounts.some((a) => a.id === r.activeAccountId) ? r.activeAccountId! : null;
  return { accounts, activeAccountId };
}

export function sanitizeAgentAccounts(raw: unknown): AgentAccountsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<AccountAgent, unknown>>;
  return {
    claude: r.claude ? sanitizeList(r.claude) : { ...EMPTY_AGENT_ACCOUNTS.claude, accounts: [] },
    codex: r.codex ? sanitizeList(r.codex) : { ...EMPTY_AGENT_ACCOUNTS.codex, accounts: [] },
  };
}

/** Same length rule for labels (also used by rename). */
export function normalizeAccountLabel(label: string): string {
  return label.trim().slice(0, LABEL_MAX);
}

/** Checks an agent kind received over IPC. */
export function requireAccountAgent(value: unknown, lang: Lang = 'ja'): AccountAgent {
  if (isAccountAgent(value)) return value;
  throw new AccountsUserError(msg(lang, 'accounts.errors.invalidAgent'));
}
