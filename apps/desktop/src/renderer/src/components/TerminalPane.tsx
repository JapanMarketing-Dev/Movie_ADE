// Ported from Ferret src/renderer/components/TerminalPane.tsx (MIT).
// Solocut adaptations: tabs belong to a project folder (projectId = the folder path); agent state arrives from
// main as `agent:state` events (main/agent/watch.ts) instead of a renderer poll; agents and their install commands
// come from agents:list; no accounts, failover, agent mail, file drop, tab drag-and-drop, OS notifications or
// app-restart restore. A reload (⌘R) still re-attaches to the live terminals (terminal/restorePlan.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Columns2, Minus, Plus, RotateCcw, Rows2, SquareTerminal, X } from 'lucide-react';
import type { AgentStatus } from '@shared/types';
import type { AgentTabInfo, AgentTabState } from '@shared/terminal';
import { reportHandled } from '@shared/report';
import { api, errMsg } from '../lib/api';
import { Button, EmptyState } from '../ui';
import { acquireTerminal, getTerminal, holdPtyResize, releaseTerminal, setTerminalFontSize, terminalByPtyId, terminalFontSize } from '../terminal/terminalClient';
import { hasBusyAgent } from '../terminal/agentActivity';
import { SpawnQueue, partitionSpawns, type SpawnCandidate } from '../terminal/spawnQueue';
import { registerAgentLauncher, setActiveTerminal } from '../terminal/agentSend';
import { defaultAgent } from '../terminal/defaultAgent';
import { nextFontSize } from '../terminal/fontSize';
import { rendererPlatform } from '../terminal/platform';
import { termNow, useTermT, type TermKey } from '../terminal/strings';
import {
  ACTIVE_PANE_OPACITY,
  DIVIDER_HIT_PADDING_PX,
  DIVIDER_THICKNESS_PX,
  INACTIVE_PANE_OPACITY,
  hasLeaf,
  leaf,
  leafIds,
  neighborLeaf,
  ratioFromDrag,
  removeLeaf,
  setRatio,
  splitLeaf,
  type PaneNode,
  type PanePath,
  type PaneSplitDirection,
} from '../terminal/paneTree';
import {
  TERMINAL_SNAPSHOT_KEY,
  buildTerminalSnapshot,
  dropRestoredPanes,
  maxKeySeq,
  parseTerminalSnapshot,
  planTerminalRestore,
  type TerminalSnapshot,
} from '../terminal/restorePlan';
import { QuickLaunchButton, type QuickLaunchAgent, type QuickLaunchInstall, type QuickLaunchSearch } from './QuickLaunchButton';
import '../terminal/terminal.css';

/**
 * 内蔵ターミナル。タブで複数のシェルを開き、閉じられる。
 *
 * xterm のインスタンスは terminalClient が持ち、ここは「どのタブ・ペインを見せるか」と
 * リサイズの追従だけを担う。非表示のペインは寸法が0になるので fit は見えているペインにだけ行う。
 *
 * タブはプロジェクトごとに分ける（Orcaのワークスペースごとのタブと同じ）。表示中のプロジェクトの
 * タブだけを見せ、別のプロジェクトへ切り替えても裏のPTY・Agentと分割の形は止めずに生かしておく。
 *
 * 1つのタブの中は、Orca と同じく左右・上下に何度でも分割できる（⌘D で右、⌘⇧D で下）。
 * ペインごとに別のPTYで、「エージェントへ送る」の最初の宛先はフォーカス中のペインになる。
 * Orca由来: ~/bench/orca/src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts,
 *           ~/bench/orca/src/shared/keybindings/definitions-core-4.ts,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-divider.ts,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-divider-drag.ts（MIT, Copyright 2026 Lovecast Inc.）
 */

/**
 * Agent の状態（04_benchmark 4.1-13 / herdr の seen フラグ）。done と idle を分け、
 * 「終わったのに、まだこちらが気づいていない」を表せるようにする。null は素のシェル（Agent が前面にいない）
 */
type PaneState = AgentTabState | null;

const STATE_LABEL: Record<AgentTabState, TermKey> = {
  working: 'state.working',
  blocked: 'state.blocked',
  done: 'state.done',
  idle: 'state.idle',
};

/** 分割したタブの印に出す順。気づいてほしいものほど先 */
const STATE_PRIORITY: AgentTabState[] = ['blocked', 'done', 'working', 'idle'];

/** 1つのペイン（＝1つのPTY） */
interface Pane {
  key: string;
  title: string;
  /** Agentの状態（main の agent:state） */
  state: PaneState;
  /** 起動したAgent。素のシェルなら null */
  launch: string | null;
  /** 起動時のカレント。省略時は main 側で開いているプロジェクトのフォルダ */
  cwd: string | null;
  /** シェル起動後に実行する1行（「ターミナルで実行」） */
  command?: string | null;
  /** 起動後に入力欄へ入れるだけの1行（インストールのコマンド。実行は利用者が Enter） */
  typeText?: string | null;
  /** 依頼元が決めたタブ名 */
  customTitle?: string | null;
}

interface Tab {
  key: string;
  /** どのプロジェクトのタブか（フォルダのパス）。プロジェクトを開いていなければ null */
  projectId: string | null;
  /** ペインの分割の形 */
  layout: PaneNode;
  /** フォーカス中のペイン */
  activePane: string;
}

/** 寸法が測れない（非表示の）ペインを作るときの大きさ。表示したときに合わせ直す */
const FALLBACK_SIZE = { cols: 80, rows: 24 };
/** 分割元のカレントを調べるのを待つ上限。macOS の lsof は初回だけ遅いことがある（Orca と同じ値） */
const SPLIT_CWD_TIMEOUT_MS = 1000;
/** インストールのコマンドを入れるまでの待ち（シェルの rc を読み終えるころ） */
const TYPE_TEXT_DELAY_MS = 800;
/** 区切り線の掴める幅（見える線 ＋ 両側の余白） */
const DIVIDER_HIT_SIZE = DIVIDER_THICKNESS_PX + DIVIDER_HIT_PADDING_PX * 2;

let tabSeq = 0;
let paneSeq = 0;

interface PaneSpec {
  launch?: string | null;
  cwd: string | null;
  command?: string | null;
  typeText?: string | null;
  title?: string | null;
}

function newPane({ launch = null, cwd, command = null, typeText = null, title = null }: PaneSpec, label: string): Pane {
  return { key: `pane${++paneSeq}`, title: title || label, state: null, launch, cwd, command, typeText, customTitle: title };
}

/** 読み込み直しの前に書いた記録（同じウインドウの読み込み直しでは残る sessionStorage）。読めなければ null */
function readSnapshot(): string | null {
  try {
    return window.sessionStorage.getItem(TERMINAL_SNAPSHOT_KEY);
  } catch {
    // ストレージが使えない環境（想定内。main の一覧から戻せる）
    return null;
  }
}

function writeSnapshot(snapshot: TerminalSnapshot): void {
  try {
    window.sessionStorage.setItem(TERMINAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* 書けなくても、main の一覧から戻せる */
  }
}

/** Orca と同じ割り当て。macOS は ⌘D / ⌘⇧D、それ以外は Ctrl+Shift+D / Alt+Shift+D */
function splitShortcut(direction: PaneSplitDirection): string {
  const mac = rendererPlatform() === 'darwin';
  if (direction === 'vertical') return mac ? '⌘D' : 'Ctrl+Shift+D';
  return mac ? '⌘⇧D' : 'Alt+Shift+D';
}

/**
 * ⌘D / ⌘⇧D（Orca と同じ割り当て）。ターミナルにフォーカスがあるときだけ効かせる
 * （Orca の terminal-shortcut-policy と同じ。ほかの入力欄の ⌘D を奪わない）
 */
function splitDirectionForKey(event: React.KeyboardEvent): PaneSplitDirection | null {
  if (event.code !== 'KeyD') return null;
  if (rendererPlatform() === 'darwin') {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null;
    return event.shiftKey ? 'horizontal' : 'vertical';
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) return 'vertical';
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) return 'horizontal';
  return null;
}

export function TerminalPane({ projectDir, visible, toast }: { projectDir: string | null; visible: boolean; toast: (m: string) => void }) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const t = useTermT();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  /** プロジェクトごとの選択中タブ。切り替えて戻ったときに同じタブを見せる */
  const [activeByProject, setActiveByProject] = useState<Record<string, string | null>>({});
  /** ペインの描画先（xterm の器を入れる場所） */
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const leafRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  /** PTYを作り始めたペイン。終了したペインを勝手に作り直さないよう、1ペイン1回だけ */
  const spawnedRef = useRef(new Set<string>());
  /** PTY ができたら知らせてほしいペイン（エージェントへ送る前に開いたタブ） */
  const spawnWaitersRef = useRef(new Map<string, (ptyId: string | null) => void>());
  /** 画面を読み込み直したあとの、生きているターミナルへのつなぎ直しが済んだか */
  const [restored, setRestored] = useState(false);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const projectId = projectDir;
  const projectKey = projectId ?? '';
  const visibleTabs = useMemo(() => tabs.filter((tab) => (tab.projectId ?? '') === projectKey), [tabs, projectKey]);
  const activeKey = activeByProject[projectKey] ?? null;
  const activeTab = visibleTabs.find((tab) => tab.key === activeKey) ?? null;
  const focusedPane = activeTab?.activePane ?? null;
  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;

  const setActiveKey = useCallback((key: string | null) => setActiveByProject((prev) => ({ ...prev, [projectKey]: key })), [projectKey]);

  // メニューに出すエージェント（インストール済み）と、インストールできるもの
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      void api
        .invoke('agents:list')
        .then((list) => {
          if (!stopped) setAgents(list);
        })
        .catch(() => undefined /* 失敗は main の IPC が送る（ここは既定のまま続ける） */);
    load();
    const off = api.on('settings:changed', load);
    return () => {
      stopped = true;
      off();
    };
  }, []);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const menuAgents = useMemo<QuickLaunchAgent[]>(
    () => agents.filter((a) => a.installed).map((a) => ({ id: a.id, label: a.label, ...(a.version ? { version: a.version } : {}) })),
    [agents],
  );
  const installable = useMemo<QuickLaunchInstall[]>(
    () => agents.filter((a) => !a.installed && a.install.trim()).map((a) => ({ id: a.id, label: a.label, command: a.install })),
    [agents],
  );
  const labelOf = useCallback((launch: string | null) => (launch ? (agentsRef.current.find((a) => a.id === launch)?.label ?? launch) : termNow('shell')), []);

  /**
   * ペインの描画先を登録する。分割で木の形が変わるとDOMが作り直されるので、
   * そのたびに xterm の器を新しい場所へ移す。キーごとに同じ関数を返し、毎回の描画で付け外ししない
   */
  const leafRef = useCallback((key: string) => {
    let ref = leafRefs.current.get(key);
    if (!ref) {
      ref = (node) => {
        const previous = nodesRef.current.get(key);
        if (!node) {
          if (nodesRef.current.get(key) === previous) nodesRef.current.delete(key);
          return;
        }
        nodesRef.current.set(key, node);
        getTerminal(key)?.open(node);
      };
      leafRefs.current.set(key, ref);
    }
    return ref;
  }, []);

  const releasePane = useCallback((key: string) => {
    releaseTerminal(key);
    nodesRef.current.delete(key);
    leafRefs.current.delete(key);
    spawnedRef.current.delete(key);
    spawnQueueRef.current?.remove(key);
    spawnWaitersRef.current.get(key)?.(null);
    spawnWaitersRef.current.delete(key);
  }, []);

  /** タブを開く。launch を渡すとそのAgentが起動した状態のタブになる。開いたペインのキーを返す */
  const addTab = useCallback(
    (launch: string | null = null, extra: Omit<PaneSpec, 'launch' | 'cwd'> & { cwd?: string | null } = {}): string => {
      const pane = newPane({ ...extra, launch, cwd: extra.cwd ?? projectDir }, labelOf(launch));
      const key = `tab${++tabSeq}`;
      setPanes((prev) => ({ ...prev, [pane.key]: pane }));
      setTabs((prev) => [...prev, { key, projectId, layout: leaf(pane.key), activePane: pane.key }]);
      setActiveKey(key);
      return pane.key;
    },
    [projectId, projectDir, setActiveKey, labelOf],
  );
  const addTabRef = useRef(addTab);
  addTabRef.current = addTab;

  /**
   * フォーカス中のペインを分割し、新しいペインを右（下）に置いてフォーカスを移す。
   * 新しいペインのカレントは、分割元のシェルの「今の」カレント（cd した先。Orca の resolve-split-cwd と同じ）
   */
  const splitPane = useCallback(
    async (direction: PaneSplitDirection, launch: string | null = null) => {
      if (!activeTab) return;
      const tabKey = activeTab.key;
      const sourceKey = activeTab.activePane;
      const source = panesRef.current[sourceKey];
      const ptyId = getTerminal(sourceKey)?.ptyId ?? null;
      const live = ptyId
        ? await Promise.race([
            // 終了済みのターミナル（想定内。プロジェクトのフォルダで開く）
            api.invoke('terminal:cwd', ptyId).catch(() => null),
            new Promise<null>((done) => setTimeout(() => done(null), SPLIT_CWD_TIMEOUT_MS)),
          ])
        : null;
      const pane = newPane({ launch, cwd: live || source?.cwd || projectDir }, labelOf(launch));
      setPanes((prev) => ({ ...prev, [pane.key]: pane }));
      setTabs((prev) =>
        prev.map((tab) =>
          tab.key === tabKey && hasLeaf(tab.layout, sourceKey)
            ? { ...tab, layout: splitLeaf(tab.layout, sourceKey, direction, pane.key), activePane: pane.key }
            : tab,
        ),
      );
    },
    [activeTab, projectDir, labelOf],
  );

  const focusPane = useCallback((tabKey: string, paneKey: string) => {
    setTabs((prev) =>
      prev.some((tab) => tab.key === tabKey && tab.activePane !== paneKey)
        ? prev.map((tab) => (tab.key === tabKey ? { ...tab, activePane: paneKey } : tab))
        : prev,
    );
  }, []);

  const closeTab = useCallback(
    (key: string) => {
      const tab = tabs.find((x) => x.key === key);
      if (!tab) return;
      const keys = leafIds(tab.layout);
      for (const paneKey of keys) releasePane(paneKey);
      // 更新関数の中で別の state を更新しない（Reactが更新を捨てることがある）。
      // 選択中のタブを閉じたときの移動は、下の effect に任せる。
      setTabs((prev) => prev.filter((x) => x.key !== key));
      setPanes((prev) => {
        const next = { ...prev };
        for (const paneKey of keys) delete next[paneKey];
        return next;
      });
    },
    [tabs, releasePane],
  );

  /**
   * 利用者が閉じる（×）とき、Agent が作業中・確認待ちのペインがあれば確かめる。
   * 確認なしに閉じると、動いている Agent ごと止まり作業が失われる（Orca #14817 #24426）
   */
  const confirmCloseRunning = useCallback(
    (keys: string[]) => !hasBusyAgent(keys.map((key) => panes[key]?.state ?? undefined)) || window.confirm(t('confirmCloseRunning')),
    [panes, t],
  );

  /** ペインを閉じる。最後の1枚ならタブごと閉じる（Orca の closeActivePane と同じ） */
  const closePane = useCallback(
    (tabKey: string, paneKey: string) => {
      const tab = tabs.find((x) => x.key === tabKey);
      if (!tab) return;
      const layout = removeLeaf(tab.layout, paneKey);
      if (!layout) {
        closeTab(tabKey);
        return;
      }
      releasePane(paneKey);
      const nextActive = tab.activePane === paneKey ? (neighborLeaf(tab.layout, paneKey) ?? leafIds(layout)[0]!) : tab.activePane;
      setTabs((prev) => prev.map((x) => (x.key === tabKey ? { ...x, layout, activePane: nextActive } : x)));
      setPanes((prev) => {
        const next = { ...prev };
        delete next[paneKey];
        return next;
      });
    },
    [tabs, closeTab, releasePane],
  );

  /** 区画の右クリックのメニュー（右に分割・下に分割・区画を閉じる・文字の大きさ） */
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; tabKey: string; paneKey: string; split: boolean } | null>(null);

  const setSplitRatio = useCallback((tabKey: string, path: PanePath, ratio: number) => {
    setTabs((prev) => prev.map((tab) => (tab.key === tabKey ? { ...tab, layout: setRatio(tab.layout, path, ratio) } : tab)));
  }, []);

  // 「ターミナルで実行」（ライブラリ・撮影のテスト補助）: 新しいタブの最初のプロンプトでその1行を実行する
  useEffect(() => {
    const onRun = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (typeof command !== 'string' || !command.trim()) return;
      addTabRef.current(null, { command, title: command.trim().split(/\s+/)[0] ?? null });
    };
    window.addEventListener('solocut:run-in-terminal', onRun);
    return () => window.removeEventListener('solocut:run-in-terminal', onRun);
  }, []);

  // 「エージェントへ送る」でどこにも Agent が居なかったとき、Agent のタブを開いて PTY ができるのを待つ（agentSend.ts）
  useEffect(
    () =>
      registerAgentLauncher((agent) => {
        const launch = agent ?? defaultAgent(agentsRef.current);
        if (!launch) return Promise.resolve(null);
        const paneKey = addTabRef.current(launch);
        return new Promise<string | null>((resolve) => spawnWaitersRef.current.set(paneKey, resolve));
      }),
    [],
  );

  // 閉じたタブが選択中だったら、表示中のプロジェクトに残っている最後のタブへ移る
  useEffect(() => {
    if (activeKey !== null && visibleTabs.some((tab) => tab.key === activeKey)) return;
    const next = visibleTabs.length > 0 ? (visibleTabs[visibleTabs.length - 1]?.key ?? null) : null;
    if (next !== activeKey) setActiveKey(next);
  }, [visibleTabs, activeKey, setActiveKey]);

  // 画面を読み込み直した（⌘R・HMR）あとは、main で生きているターミナルに新しく作らずつなぎ直す。
  // 読み込み直しの前に書いておいたタブ・分割の形（sessionStorage）と main の一覧を突き合わせる（restorePlan.ts）。
  // 戻す先の無いもの（記録にもプロジェクトにも当てはまらないもの）だけを閉じる
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const [live, recent] = await Promise.all([api.invoke('terminal:list'), api.invoke('project:recent').catch(() => [])]);
        if (stopped || live.length === 0) return;
        const snapshot = parseTerminalSnapshot(readSnapshot());
        tabSeq = Math.max(tabSeq, maxKeySeq(snapshot?.tabs.map((tab) => tab.key) ?? [], 'tab'));
        paneSeq = Math.max(paneSeq, maxKeySeq(snapshot?.panes.map((pane) => pane.key) ?? [], 'pane'));
        const dirs = new Set([...recent.map((p) => p.dir), ...(projectDir ? [projectDir] : [])]);
        let plan = planTerminalRestore({
          snapshot,
          live,
          projects: [...dirs].map((dir) => ({ id: dir, folderPath: dir })),
          newKey: (kind) => (kind === 'tab' ? `tab${++tabSeq}` : `pane${++paneSeq}`),
        });
        for (const id of plan.close) void api.invoke('terminal:close', id);
        const attached = await Promise.all(
          plan.panes.map(async (pane) => [pane, await api.invoke('terminal:attach', pane.ptyId).catch(() => null /* 終了済みの PTY（想定内） */)] as const),
        );
        if (stopped) return;
        const dead = new Set(attached.filter(([, info]) => !info).map(([pane]) => pane.key));
        plan = dropRestoredPanes(plan, dead);
        for (const [pane, info] of attached) {
          if (!info) continue;
          const handle = acquireTerminal(pane.key);
          spawnedRef.current.add(pane.key);
          handle.reattach(info.id, info.history, info.size);
        }
        setPanes((prev) => ({
          ...prev,
          ...Object.fromEntries(
            plan.panes.map((pane): [string, Pane] => [pane.key, { key: pane.key, title: pane.title, state: null, launch: pane.launch, cwd: pane.cwd }]),
          ),
        }));
        setTabs((prev) => [...prev, ...plan.tabs]);
        setActiveByProject((prev) => ({ ...plan.activeByProject, ...prev }));
      } catch (err) {
        console.warn('[terminal] could not re-attach after reload', err);
        reportHandled(err, { area: 'terminal', op: 'reattach after reload' });
      } finally {
        if (!stopped) setRestored(true);
      }
    })();
    return () => {
      stopped = true;
    };
    // 起動時に1回だけ（読み込み直しのあと）
  }, []);

  // 読み込み直しに備えて、タブ・分割の形と各ペインの PTY の id を書いておく
  useEffect(() => {
    if (!restored) return;
    writeSnapshot(
      buildTerminalSnapshot({
        tabs,
        panes: Object.values(panes),
        ptyIdOf: (key) => getTerminal(key)?.ptyId ?? null,
        activeByProject,
      }),
    );
  }, [tabs, panes, activeByProject, restored]);

  /** ペインの PTY を作る（1 ペイン 1 回だけ）。作り終える（失敗も含む）と解決する */
  const spawnPane = useCallback((key: string): Promise<void> => {
    const pane = panesRef.current[key];
    const node = nodesRef.current.get(key);
    const handle = getTerminal(key);
    if (!pane || !node || !handle || handle.ptyId !== null || spawnedRef.current.has(key)) return Promise.resolve();
    spawnedRef.current.add(pane.key);
    const measurable = node.offsetWidth > 0 && node.offsetHeight > 0;
    const size = (measurable ? handle.fit() : null) ?? FALLBACK_SIZE;
    return api
      .invoke('terminal:create', {
        size,
        cwd: pane.cwd,
        agent: pane.launch,
        command: pane.command ?? null,
        title: pane.customTitle ?? null,
      })
      .then((info) => {
        // 作っている間にペインを閉じたら、できたPTYもすぐ閉じる
        if (getTerminal(pane.key) !== handle) {
          void api.invoke('terminal:close', info.id);
          return;
        }
        handle.bindPty(info.id);
        if (pane.launch) handle.foregroundAgent = pane.launch;
        if (pane.key === focusedPaneRef.current) setActiveTerminal(info.id);
        handle.scheduleFit();
        if (pane.typeText) {
          const text = pane.typeText;
          setTimeout(() => {
            if (handle.ptyId === info.id) api.send('terminal:write', info.id, text);
          }, TYPE_TEXT_DELAY_MS);
        }
        setPanes((prev) => (prev[pane.key] ? { ...prev, [pane.key]: { ...prev[pane.key]!, title: info.title, typeText: null } } : prev));
        spawnWaitersRef.current.get(pane.key)?.(info.id);
        spawnWaitersRef.current.delete(pane.key);
      })
      .catch((err: unknown) => {
        const message = errMsg(err);
        handle.write(`\r\n\u001b[31m${termNow('startFailed', { message })}\u001b[0m\r\n`);
        if (message.includes('node-pty')) handle.write(`\u001b[2m${termNow('nodePtyHint')}\u001b[0m\r\n`);
        toastRef.current(termNow('startFailed', { message }));
        spawnWaitersRef.current.get(pane.key)?.(null);
        spawnWaitersRef.current.delete(pane.key);
      });
  }, []);

  // ペインごとに xterm を開き、PTYを結びつける。
  // 非表示のペイン（裏のタブ）もPTYを作る。寸法が測れなければ 80x24 で作り、表示時に合わせる。
  // 表示中のプロジェクトのペインはすぐ作り、裏のプロジェクトのペイン（つなぎ直しの残りなど）は順に作る（terminal/spawnQueue.ts）
  const spawnQueueRef = useRef<SpawnQueue | null>(null);
  spawnQueueRef.current ??= new SpawnQueue();
  useEffect(() => () => spawnQueueRef.current?.dispose(), []);
  useEffect(() => {
    const queue = spawnQueueRef.current!;
    const candidates: SpawnCandidate[] = [];
    for (const pane of Object.values(panes)) {
      const node = nodesRef.current.get(pane.key);
      if (!node) continue;
      const handle = acquireTerminal(pane.key);
      handle.open(node);
      if (handle.ptyId !== null || spawnedRef.current.has(pane.key)) continue;
      candidates.push({ key: pane.key, projectId: tabsRef.current.find((tab) => hasLeaf(tab.layout, pane.key))?.projectId ?? null });
    }
    const { now, queued } = partitionSpawns(candidates, projectId);
    for (const key of now) {
      // 待っていたペインのプロジェクトを表示した：すぐ作る
      if (!queue.promote(key)) void spawnPane(key);
    }
    for (const key of queued) queue.enqueue(key, () => spawnPane(key));
  }, [panes, tabs, projectId, spawnPane]);

  // 「エージェントへ送る」の最初の宛先は、フォーカス中のペインのPTY
  useEffect(() => {
    setActiveTerminal(focusedPane ? (getTerminal(focusedPane)?.ptyId ?? null) : null);
  }, [focusedPane, panes]);

  // Agent の状態（main の agent/watch.ts が 1 秒ごとに調べ、変わったときに送る）。前面の Agent は Shift+Enter の改行に使う
  const applyAgentState = useCallback((info: AgentTabInfo) => {
    const handle = terminalByPtyId(info.tabId);
    if (!handle) return;
    handle.foregroundAgent = info.agentId;
    const state: PaneState = info.agentId || info.state === 'done' ? info.state : null;
    setPanes((prev) => {
      const pane = prev[handle.key];
      if (!pane || (pane.state === state && pane.title === info.title)) return prev;
      return { ...prev, [handle.key]: { ...pane, state, title: info.title } };
    });
  }, []);
  useEffect(() => api.on('agent:state', applyAgentState), [applyAgentState]);
  useEffect(() => {
    if (!restored) return;
    void api
      .invoke('agent:tabs')
      .then((list) => list.forEach(applyAgentState))
      .catch(() => undefined /* 画面の閉じかけなど（想定内） */);
  }, [restored, applyAgentState]);

  // 表示中のタブに寸法を合わせ、フォーカス中のペインへ焦点を移す（ほかの画面を見ている間は焦点を奪わない）
  useEffect(() => {
    if (!focusedPane || !visible) return;
    const frame = requestAnimationFrame(() => {
      if (activeTab) for (const key of leafIds(activeTab.layout)) getTerminal(key)?.scheduleFit();
      getTerminal(focusedPane)?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // 分割の比率のドラッグのたびに焦点を取り直さない
  }, [activeKey, focusedPane, visible]);

  // アンマウント時にPTYを残さない
  useEffect(
    () => () => {
      for (const key of Object.keys(panesRef.current)) releaseTerminal(key);
      nodesRef.current.clear();
      spawnedRef.current.clear();
    },
    [],
  );

  // xterm に届く前に拾い、シェルへは送らない
  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    const direction = splitDirectionForKey(event);
    if (!direction || !activeTab) return;
    event.preventDefault();
    event.stopPropagation();
    void splitPane(direction);
  };

  const changeFontSize = (action: 'bigger' | 'smaller' | 'reset') => setTerminalFontSize(nextFontSize(terminalFontSize(), action));

  const quickSearch = useMemo<QuickLaunchSearch>(
    () => ({
      tabs: visibleTabs.map((tab) => ({ key: tab.key, title: panes[tab.activePane]?.title ?? t('shell') })),
      onSelectTab: setActiveKey,
    }),
    [visibleTabs, panes, setActiveKey, t],
  );
  const installAgent = (agent: QuickLaunchInstall) => addTab(null, { typeText: agent.command, title: `${t('install')}: ${agent.label}` });

  const renderNode = (tab: Tab, node: PaneNode, path: PanePath, split: boolean): ReactNode => {
    if (node.type === 'leaf') {
      const active = node.leafId === tab.activePane;
      return (
        <div
          key={node.leafId}
          className="terminal-leaf"
          data-pane={node.leafId}
          data-active={active}
          data-split={split || undefined}
          style={{ opacity: !split || active ? ACTIVE_PANE_OPACITY : INACTIVE_PANE_OPACITY }}
          ref={leafRef(node.leafId)}
          onMouseDown={() => focusPane(tab.key, node.leafId)}
          onFocus={() => focusPane(tab.key, node.leafId)}
          onContextMenu={(e) => {
            // 右クリックで分割・区画を閉じる・文字の大きさ
            e.preventDefault();
            focusPane(tab.key, node.leafId);
            setPaneMenu({ x: e.clientX, y: e.clientY, tabKey: tab.key, paneKey: node.leafId, split });
          }}
        />
      );
    }
    const vertical = node.direction === 'vertical';
    return (
      <div key={path} className={`terminal-split ${vertical ? 'is-vertical' : 'is-horizontal'}`}>
        <div className="terminal-split__child" style={{ flex: `${node.ratio} 1 0%` }}>
          {renderNode(tab, node.first, `${path}0`, true)}
        </div>
        <PaneDivider vertical={vertical} onRatio={(ratio) => setSplitRatio(tab.key, path, ratio)} />
        <div className="terminal-split__child" style={{ flex: `${1 - node.ratio} 1 0%` }}>
          {renderNode(tab, node.second, `${path}1`, true)}
        </div>
      </div>
    );
  };

  return (
    <section ref={sectionRef} onKeyDownCapture={onKeyDownCapture} className="terminal-pane" data-testid="terminal-pane" aria-label={t('label')}>
      <div className="terminal-tabs" role="tablist">
        {visibleTabs.map((tab) => {
          const ids = leafIds(tab.layout);
          const pane = panes[tab.activePane];
          const title = pane?.title ?? t('shell');
          const state = STATE_PRIORITY.find((s) => ids.some((id) => panes[id]?.state === s)) ?? null;
          const stateLabel = state ? t(STATE_LABEL[state]) : t('shell');
          return (
            <div
              key={tab.key}
              className="terminal-tab"
              role="tab"
              aria-selected={tab.key === activeKey}
              onClick={() => setActiveKey(tab.key)}
              data-testid={`terminal-tab-${tab.key}`}
            >
              {/* Agentの状態の印。分割していれば一番気づいてほしいペインの状態 */}
              <span className={`terminal-tab__state terminal-tab__state--${state ?? 'shell'}`} title={stateLabel} aria-label={stateLabel} />
              {pane?.launch && <Bot className="terminal-tab__agent" size={12} strokeWidth={1.75} aria-hidden="true" />}
              {/* 省略されても全体を読めるように（Orca #2966） */}
              <span className="terminal-tab__title" title={title}>
                {title}
              </span>
              {ids.length > 1 && (
                <span className="terminal-tab__count" title={t('splitInto', { count: ids.length })}>
                  {ids.length}
                </span>
              )}
              <button
                type="button"
                className="terminal-tab__close"
                aria-label={t('closeNamed', { title })}
                title={t('closeTab')}
                onClick={(event) => {
                  event.stopPropagation();
                  if (confirmCloseRunning(leafIds(tab.layout))) closeTab(tab.key);
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
        <QuickLaunchButton
          agents={menuAgents}
          installable={installable}
          onNewTerminal={() => addTab(null)}
          onLaunchAgent={(agent) => addTab(agent)}
          onInstall={installAgent}
          search={quickSearch}
        />
        <div className="terminal-tabs__actions">
          <QuickLaunchButton
            icon={<Columns2 size={14} strokeWidth={1.75} />}
            label={`${t('splitRight')} (${splitShortcut('vertical')})`}
            testId="terminal-split-right"
            agents={menuAgents}
            disabled={!activeTab}
            onNewTerminal={() => void splitPane('vertical')}
            onLaunchAgent={(agent) => void splitPane('vertical', agent)}
          />
          <QuickLaunchButton
            icon={<Rows2 size={14} strokeWidth={1.75} />}
            label={`${t('splitDown')} (${splitShortcut('horizontal')})`}
            testId="terminal-split-down"
            agents={menuAgents}
            disabled={!activeTab}
            onNewTerminal={() => void splitPane('horizontal')}
            onLaunchAgent={(agent) => void splitPane('horizontal', agent)}
          />
        </div>
      </div>

      {paneMenu && (
        <PaneContextMenu
          at={paneMenu}
          onClose={() => setPaneMenu(null)}
          onSplit={(direction) => {
            setPaneMenu(null);
            void splitPane(direction);
          }}
          onClosePane={() => {
            setPaneMenu(null);
            if (confirmCloseRunning([paneMenu.paneKey])) closePane(paneMenu.tabKey, paneMenu.paneKey);
          }}
          onFontSize={(action) => {
            setPaneMenu(null);
            changeFontSize(action);
          }}
        />
      )}
      <div className="terminal-surfaces">
        {visibleTabs.length === 0 && (
          <EmptyState
            size="sm"
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            actions={
              <>
                <Button variant="default" icon={<SquareTerminal size={15} strokeWidth={1.75} />} onClick={() => addTab(null)}>
                  {t('openShell')}
                </Button>
                {menuAgents.slice(0, 4).map((agent) => (
                  <Button key={agent.id} variant="ghost" icon={<Bot size={15} strokeWidth={1.75} />} onClick={() => addTab(agent.id)}>
                    {agent.label}
                  </Button>
                ))}
              </>
            }
          />
        )}
        {/* 裏のプロジェクトのタブも描画したまま隠す（PTYと分割の形を保つ） */}
        {tabs.map((tab) => (
          <div key={tab.key} className="terminal-surface" hidden={tab.key !== activeKey || (tab.projectId ?? '') !== projectKey}>
            {renderNode(tab, tab.layout, '', tab.layout.type === 'split')}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * ペインの間の区切り線。掴める幅は見える線より広く、線そのものは CSS の ::after で描く（Orca と同じ）。
 * ドラッグ中は1フレームに1回だけ比率を更新する。
 */
function PaneDivider({ vertical, onRatio }: { vertical: boolean; onRatio: (ratio: number) => void }) {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const divider = event.currentTarget;
    const split = divider.parentElement;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    const start = vertical ? rect.left : rect.top;
    const total = (vertical ? rect.width : rect.height) - DIVIDER_HIT_SIZE;
    let frame = 0;
    divider.setPointerCapture(event.pointerId);
    setDragging(true);
    holdPtyResize(true);
    const onMove = (move: PointerEvent) => {
      const offset = (vertical ? move.clientX : move.clientY) - start - DIVIDER_HIT_SIZE / 2;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => onRatio(ratioFromDrag(offset, total)));
    };
    const onEnd = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onEnd);
      divider.removeEventListener('pointercancel', onEnd);
      setDragging(false);
      holdPtyResize(false);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onEnd);
    divider.addEventListener('pointercancel', onEnd);
  };

  return (
    <div
      className={`terminal-divider ${vertical ? 'is-vertical' : 'is-horizontal'}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      style={{
        [vertical ? 'width' : 'height']: DIVIDER_HIT_SIZE,
        ['--divider-thickness' as string]: `${DIVIDER_THICKNESS_PX}px`,
        ['--divider-extension' as string]: `${DIVIDER_HIT_SIZE / 2}px`,
      }}
      onPointerDown={onPointerDown}
      // ダブルクリックで半分ずつに戻す（Orca #9644）
      onDoubleClick={() => onRatio(0.5)}
    />
  );
}

/**
 * ターミナルの区画の右クリックのメニュー。右に分割・下に分割・文字の大きさと、分割しているときは区画を閉じる。
 * 外を押す・Esc で閉じる。画面の端からはみ出さないよう位置を寄せる
 */
function PaneContextMenu({
  at,
  onClose,
  onSplit,
  onClosePane,
  onFontSize,
}: {
  at: { x: number; y: number; split: boolean };
  onClose: () => void;
  onSplit: (direction: PaneSplitDirection) => void;
  onClosePane: () => void;
  onFontSize: (action: 'bigger' | 'smaller' | 'reset') => void;
}) {
  const t = useTermT();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const left = Math.max(4, Math.min(at.x, window.innerWidth - 220));
  const top = Math.max(4, Math.min(at.y, window.innerHeight - 220));
  const item = (icon: ReactNode, label: string, onClick: () => void, shortcut?: string) => (
    <button type="button" role="menuitem" className="pane-menu__item" onClick={onClick}>
      {icon}
      <span>{label}</span>
      {shortcut && <kbd className="pane-menu__key">{shortcut}</kbd>}
    </button>
  );
  return createPortal(
    <div ref={ref} className="pane-menu" role="menu" aria-label={t('paneMenu')} style={{ left, top }}>
      {item(<Columns2 size={14} strokeWidth={1.75} aria-hidden="true" />, t('splitRight'), () => onSplit('vertical'), splitShortcut('vertical'))}
      {item(<Rows2 size={14} strokeWidth={1.75} aria-hidden="true" />, t('splitDown'), () => onSplit('horizontal'), splitShortcut('horizontal'))}
      <div className="pane-menu__separator" role="separator" />
      {item(<Plus size={14} strokeWidth={1.75} aria-hidden="true" />, t('fontBigger'), () => onFontSize('bigger'))}
      {item(<Minus size={14} strokeWidth={1.75} aria-hidden="true" />, t('fontSmaller'), () => onFontSize('smaller'))}
      {item(<RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />, t('fontReset'), () => onFontSize('reset'))}
      {at.split && (
        <>
          <div className="pane-menu__separator" role="separator" />
          {item(<X size={14} strokeWidth={1.75} aria-hidden="true" />, t('closePane'), onClosePane)}
        </>
      )}
    </div>,
    document.body,
  );
}
