import { reactive } from "vue";
import { isTauri } from "@/lib/claude";
import { BlockTerm } from "@/lib/blockterm";
import { close as ptyClose, open as ptyOpen, resize as ptyResize, write as ptyWrite, type PtyEvent } from "@/lib/pty";
import type { LogLine } from "@/lib/types";
import { activeId, fmtMs, git, HOME_DIR, log, logs, newId, projectKey, refreshGit, repoAt, runs, shellKey, tab, tabs, tilde, type Tab } from "./state";
import { startClaude } from "./claude";

export const shellRuns = reactive<Record<string, { id: string; started: number }>>({});

export function newTab(cwd = tab.value.cwd) {
  const t: Tab = { id: newId(), cwd, mode: "shell" };
  tabs.splice(tabs.indexOf(tab.value) + 1, 0, t);
  activeId.value = t.id;
  openShell(tabs.find((x) => x.id === t.id)!);
}

export function closeTab(id = activeId.value) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const t = tabs[i];
  ptyClose(t.id);
  blocks.get(t.id)?.term.dispose();
  blocks.delete(t.id);
  logs.delete(shellKey(t));
  delete git[t.id];
  delete shellRuns[t.id];
  delete altScreen[t.id];
  altPending.delete(t.id);
  readyTabs.delete(t.id);
  waiting.delete(t.id);
  tabs.splice(i, 1);
  if (!tabs.length) {
    tabs.push({ id: newId(), cwd: HOME_DIR, mode: "shell" });
    openShell(tabs[0]);
  }
  if (activeId.value === id) activeId.value = tabs[Math.min(i, tabs.length - 1)].id;
}

export function tabBusy(t: Tab) {
  if (shellRuns[t.id]) return true;
  if (t.mode !== "claude") return false;
  const id = repoAt(t.cwd);
  return !!runs[t.chat ?? (id ? projectKey(id) : "")];
}

export function selectTab(i: number) {
  if (tabs[i]) activeId.value = tabs[i].id;
}

interface CommandRun {
  out: LogLine;
  term: BlockTerm;
  started: number;
  gotCmd: boolean;
  early: string;
  render?: number;
}

const blocks = new Map<string, CommandRun>();
export const altScreen = reactive<Record<string, boolean>>({});
export const altSinks = new Map<string, (data: string) => void>();
const altPending = new Map<string, string>();
const readyTabs = new Set<string>();
const waiting = new Map<string, string>();

export interface Completion {
  span: number;
  matches: { value: string; desc: string }[];
}
const compRequests = new Map<string, Completion & { resolve: (c: Completion | null) => void }>();

export function zshComplete(t: Tab, line: string): Promise<Completion | null> {
  if (!isTauri || !readyTabs.has(t.id) || blocks.has(t.id) || compRequests.has(t.id)) return Promise.resolve(null);
  const hex = [...new TextEncoder().encode(line)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Promise((resolve) => {
    compRequests.set(t.id, { span: 0, matches: [], resolve });
    setTimeout(() => {
      if (compRequests.get(t.id)?.resolve !== resolve) return;
      compRequests.delete(t.id);
      resolve(null);
    }, 2000);
    ptyWrite(t.id, `\x1b[200~__ck_complete ${hex}\x1b[201~\r`);
  });
}

export function drainAlt(tabId: string) {
  const data = altPending.get(tabId) ?? "";
  altPending.delete(tabId);
  return data;
}
const termSize = { cols: 120, rows: 32 };
const LIVE_ROWS = 400;

export function setTermSize(cols: number, rows: number) {
  if (cols === termSize.cols && rows === termSize.rows) return;
  Object.assign(termSize, { cols, rows });
  tabs.forEach((t) => ptyResize(t.id, cols, rows));
}

function renderBlock(b: CommandRun) {
  if (b.render) return;
  b.render = window.setTimeout(() => {
    b.render = undefined;
    b.out.html = b.term.html(LIVE_ROWS);
  }, 80);
}

function finishBlock(t: Tab, b: CommandRun, code: number) {
  if (!b.gotCmd && b.early) b.term.write(b.early.replace(/^[^\n]*\n?/, ""));
  const stats = log(shellKey(t), "stats", `${code === 0 ? "ok" : `exit ${code}`} · ${fmtMs(Date.now() - b.started)}`);
  stats.error = code !== 0;
  b.term.write("", () => {
    clearTimeout(b.render);
    b.out.html = b.term.html();
    b.term.dispose();
  });
  blocks.delete(t.id);
  delete shellRuns[t.id];
}

function onPty(t: Tab, e: PtyEvent) {
  const b = blocks.get(t.id);
  switch (e.kind) {
    case "data":
      if (altScreen[t.id]) {
        const sink = altSinks.get(t.id);
        if (sink) sink(e.data);
        else altPending.set(t.id, ((altPending.get(t.id) ?? "") + e.data).slice(-2_000_000));
      }
      if (b?.gotCmd) {
        b.term.write(e.data);
        if (!altScreen[t.id]) renderBlock(b);
      } else if (b) b.early += e.data;
      break;
    case "cmd":
      if (b) b.gotCmd = true;
      break;
    case "alt":
      altScreen[t.id] = e.on;
      if (!e.on) altPending.delete(t.id);
      break;
    case "done":
      if (e.cwd) t.cwd = tilde(e.cwd);
      refreshGit(t);
      if (!readyTabs.has(t.id)) {
        readyTabs.add(t.id);
        const queued = waiting.get(t.id);
        waiting.delete(t.id);
        if (queued) ptyWrite(t.id, queued);
        break;
      }
      if (b) finishBlock(t, b, e.code);
      break;
    case "compSpan": {
      const r = compRequests.get(t.id);
      if (r) r.span = e.len;
      break;
    }
    case "compMatch": {
      const r = compRequests.get(t.id);
      if (r && !r.matches.some((m) => m.value === e.value)) r.matches.push({ value: e.value, desc: e.desc });
      break;
    }
    case "compEnd": {
      const r = compRequests.get(t.id);
      compRequests.delete(t.id);
      r?.resolve({ span: r.span, matches: r.matches });
      break;
    }
    case "exit":
      if (b) finishBlock(t, b, 1);
      if (tabs.includes(t)) closeTab(t.id);
  }
}

export function openShell(t: Tab) {
  ptyOpen(t.id, t.cwd, termSize.cols, termSize.rows, (e) => onPty(t, e))?.catch((err) => log(shellKey(t), "out", String(err)));
}
openShell(tabs[0]);

export function runCommand(t: Tab, text: string) {
  const cmd = text.trim();
  const key = shellKey(t);
  if (!cmd || shellRuns[t.id]) return;
  if (cmd === "clear") return clearShell(t);
  const claude = cmd.match(/^claude(?:\s+(.*))?$/);
  if (claude) return startClaude(t, (claude[1] ?? "").split(/\s+/).filter(Boolean));

  log(key, "user", cmd, t.cwd);
  if (!isTauri) return log(key, "out", "Preview mode — run `bun tauri dev` for a real shell.");

  const out = log(key, "out", "");
  blocks.set(t.id, { out, term: new BlockTerm(termSize.cols, termSize.rows), started: Date.now(), gotCmd: false, early: "" });
  shellRuns[t.id] = { id: t.id, started: Date.now() };
  const line = `\x1b[200~${cmd}\x1b[201~\r`;
  if (readyTabs.has(t.id)) ptyWrite(t.id, line);
  else waiting.set(t.id, line);
}

export function clearShell(t: Tab) {
  logs.set(shellKey(t), []);
}

export function sendInput(t: Tab, text: string) {
  ptyWrite(t.id, `${text}\r`);
}

export function writeRaw(t: Tab, data: string) {
  ptyWrite(t.id, data);
}
