// Agent terminal tabs (xterm.js front ends for node-pty sessions in main). Module-level so tabs survive
// React re-mounts and screen switches.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { AgentActivity } from '@shared/types';
import { api } from './api';

export interface Tab {
  id: string;
  title: string;
  agentId?: string;
  activity: AgentActivity;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

type Listener = () => void;

class TerminalStore {
  tabs: Tab[] = [];
  activeId: string | null = null;
  private listeners = new Set<Listener>();
  private pendingData = new Map<string, string[]>();

  constructor() {
    api.on('pty:data', (id, data) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (tab) tab.term.write(data);
      else {
        const q = this.pendingData.get(id) ?? [];
        q.push(data);
        this.pendingData.set(id, q);
      }
    });
    api.on('pty:exit', (id) => this.update(id, { activity: 'exited' }));
    api.on('pty:activity', (id, a) => this.update(id, { activity: a }));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private update(id: string, patch: Partial<Tab>): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    Object.assign(tab, patch);
    this.tabs = [...this.tabs];
    this.emit();
  }

  async spawn(cwd: string, o: { agentId?: string; command?: string; title?: string; typeOnly?: string } = {}): Promise<Tab> {
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK JP', monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: {
        background: '#0b0c0d',
        foreground: '#e2e2e5',
        cursor: '#ff4a3d',
        selectionBackground: 'rgba(255,74,61,0.25)',
        black: '#1b1c1f',
        brightBlack: '#5c5f66',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void api.invoke('app:openExternal', uri)));
    const el = document.createElement('div');
    el.className = 'term';
    const info = await api.invoke('pty:spawn', {
      cwd,
      cols: 100,
      rows: 30,
      ...(o.agentId ? { agentId: o.agentId } : {}),
      ...(o.command ? { command: o.command } : {}),
    });
    const tab: Tab = { id: info.id, title: o.title ?? info.title, activity: 'starting', term, fit, el };
    if (info.agentId) tab.agentId = info.agentId;
    term.onData((d) => api.send('pty:write', info.id, d));
    term.onResize(({ cols, rows }) => api.send('pty:resize', info.id, cols, rows));
    const queued = this.pendingData.get(info.id);
    if (queued) {
      for (const d of queued) term.write(d);
      this.pendingData.delete(info.id);
    }
    if (o.typeOnly) setTimeout(() => api.send('pty:write', info.id, o.typeOnly!), 500);
    this.tabs = [...this.tabs, tab];
    this.activeId = tab.id;
    this.emit();
    return tab;
  }

  /** Attach the xterm to its DOM element the first time it becomes visible. */
  mount(tab: Tab, host: HTMLElement): void {
    if (tab.el.parentElement !== host) host.appendChild(tab.el);
    if (!tab.term.element) {
      tab.term.open(tab.el);
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        tab.term.loadAddon(gl);
      } catch {
        /* DOM renderer fallback */
      }
    }
  }

  fitActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || !tab.term.element || tab.el.clientWidth === 0) return;
    try {
      tab.fit.fit();
    } catch {
      /* not visible */
    }
  }

  activate(id: string): void {
    this.activeId = id;
    this.emit();
  }

  close(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    void api.invoke('pty:kill', id);
    tab.term.dispose();
    tab.el.remove();
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.pendingData.delete(id);
    if (this.activeId === id) this.activeId = this.tabs[this.tabs.length - 1]?.id ?? null;
    this.emit();
  }

  closeAll(): void {
    for (const t of [...this.tabs]) this.close(t.id);
  }

  /**
   * Target for a prompt: a tab running the prompt's agent if it names one (not "default"), else the active tab.
   */
  targetFor(agent?: string): Tab | null {
    if (agent && agent !== 'default') {
      const active = this.tabs.find((t) => t.id === this.activeId);
      if (active?.agentId === agent && active.activity !== 'exited') return active;
      const any = this.tabs.find((t) => t.agentId === agent && t.activity !== 'exited');
      if (any) return any;
    }
    return this.tabs.find((t) => t.id === this.activeId && t.activity !== 'exited') ?? null;
  }

  paste(tab: Tab, text: string): void {
    api.send('pty:paste', tab.id, text);
    this.activate(tab.id);
    tab.term.focus();
  }
}

export const terminals = new TerminalStore();
