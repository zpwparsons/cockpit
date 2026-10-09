import { computed, reactive, ref, shallowRef, watch } from "vue";
import { useDebounceFn } from "@vueuse/core";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/claude";
import { persist, read } from "@/lib/persist";
import type { Chat, LogKind, LogLine, Rate, Repo } from "@/lib/types";

export const MODELS = [
  { id: "", label: "Default", hint: "Whatever Claude Code is set to" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "Most capable" },
  { id: "opus", label: "Opus 5.5", hint: "Best for complex work" },
  { id: "sonnet", label: "Sonnet 5.5", hint: "Fast, everyday tasks" },
  { id: "haiku", label: "Haiku 5.5", hint: "Fastest, cheapest" },
];
export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
export const MODES = [
  { id: "manual", label: "ask before acting", glyph: "" },
  { id: "acceptEdits", label: "accept edits on", glyph: "⏵⏵" },
  { id: "plan", label: "plan mode on", glyph: "⏸" },
  { id: "auto", label: "auto mode on", glyph: "⏵⏵" },
];
export const BUILTINS = [
  { name: "model", hint: "Switch model" },
  { name: "effort", hint: "Set reasoning effort" },
  { name: "resume", hint: "Pick up a previous Claude session" },
  { name: "clear", hint: "Start a fresh session" },
  { name: "usage", hint: "Plan limits and session cost" },
  { name: "memory", hint: "Open your CLAUDE.md memory files" },
  { name: "permissions", hint: "Show allow/deny rules" },
  { name: "hooks", hint: "Show configured hooks" },
  { name: "config", hint: "Show settings files" },
  { name: "rewind", hint: "Go back to an earlier message" },
  { name: "exit", hint: "Back to the terminal" },
  { name: "help", hint: "Keys and commands" },
];

export const repos = reactive<Repo[]>(read<Repo[]>("cockpit.repos.v1", []).map(({ id, name, path }) => ({ id, name, path })));
persist("cockpit.repos.v1", repos);

export const chats = reactive<Chat[]>(read<Chat[]>("cockpit.chats.v1", []).filter((c) => repos.some((r) => r.id === c.repo)));
persist("cockpit.chats.v1", chats);

export const logs = reactive(new Map<string, LogLine[]>());
let seq = Date.now();
export const nextId = () => ++seq;
const dirty = new Set<string>();
let logsReady = false;

export function markDirty(key: string) {
  if (!key.startsWith("sh:")) dirty.add(key);
}

export function saveLogs() {
  if (!logsReady || !isTauri) return;
  for (const key of dirty) invoke("log_save", { key, json: JSON.stringify(logs.get(key) ?? []) }).catch(() => {});
  dirty.clear();
}
export const flushLogs = useDebounceFn(saveLogs, 1000, { maxWait: 5000 });

async function loadLogs() {
  if (!isTauri) return;
  const disk = await invoke<Record<string, LogLine[]>>("logs_load_all").catch(() => ({}) as Record<string, LogLine[]>);
  for (const [key, lines] of Object.entries(disk)) {
    const current = logs.get(key);
    if (current) {
      current.unshift(...lines);
      markDirty(key);
    } else logs.set(key, lines);
  }
  const legacy = read<Record<string, LogLine[]> | null>("cockpit.logs.v1", null);
  if (legacy) {
    for (const [key, lines] of Object.entries(legacy))
      if (!key.startsWith("sh:") && !logs.has(key)) {
        logs.set(key, lines);
        markDirty(key);
      }
    localStorage.removeItem("cockpit.logs.v1");
  }
  logsReady = true;
  flushLogs();
}
loadLogs();
window.addEventListener("blur", saveLogs);
window.addEventListener("beforeunload", saveLogs);

export const settings = reactive({ model: "", effort: "", mode: "acceptEdits", ...read("cockpit.settings.v1", {}) });
persist("cockpit.settings.v1", settings);

export const rate = shallowRef<Rate | null>(read("cockpit.rate.v1", null));
persist("cockpit.rate.v1", rate);

export const projectKey = (repo: string) => `#${repo}`;
export const isProjectChat = (c: Chat) => c.key.startsWith("#");

export function ensureProjectChat(repo: string) {
  const key = projectKey(repo);
  if (!chats.some((c) => c.key === key)) chats.push({ key, repo, title: repos.find((r) => r.id === repo)?.name ?? repo });
  return key;
}
repos.forEach((r) => ensureProjectChat(r.id));

export interface Tab {
  id: string;
  cwd: string;
  mode: "shell" | "claude";
  chat?: string;
}

let home = "";
if (isTauri)
  import("@tauri-apps/api/path")
    .then(({ homeDir }) => homeDir())
    .then((h) => (home = h.replace(/\/$/, "")))
    .catch(() => {});
export const tilde = (p: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
export const untilde = (p: string) => (home ? p.replace(/^~(?=\/|$)/, home) : p);
export const HOME_DIR = "~/Code";
export const newId = () => Math.random().toString(36).slice(2, 10);

export const tabs = reactive<Tab[]>([{ id: newId(), cwd: HOME_DIR, mode: "shell" }]);
export const activeId = ref(tabs[0].id);
export const tab = computed(() => tabs.find((t) => t.id === activeId.value) ?? tabs[0]);

export function ensureRepo(cwd: string) {
  const path = tilde(cwd);
  const found = repos.find((r) => r.path === path);
  if (found) return found.id;
  const name = path.split("/").filter(Boolean).pop() ?? "~";
  let id = name;
  for (let n = 2; repos.some((r) => r.id === id); n++) id = `${name}-${n}`;
  repos.push({ id, name, path });
  ensureProjectChat(id);
  return id;
}

export const repoAt = (cwd: string) => repos.find((r) => r.path === tilde(cwd))?.id;
export const chatKey = computed(() => {
  if (tab.value.mode !== "claude") return "";
  const id = repoAt(tab.value.cwd);
  return tab.value.chat ?? (id ? projectKey(id) : "");
});
export const repoId = computed(() => chats.find((c) => c.key === chatKey.value)?.repo ?? repoAt(tab.value.cwd) ?? "");
export const shellKey = (t: Tab) => `sh:${t.id}`;

export const repo = computed(() => repos.find((r) => r.id === repoId.value));
export const chat = computed(() => chats.find((c) => c.key === chatKey.value));
export const currentLog = computed(() => logs.get(tab.value.mode === "claude" ? chatKey.value : shellKey(tab.value)) ?? []);

export interface Attachment {
  type: string;
  data: string;
  thumb: string;
}
export interface Run {
  id: string;
  started: number;
  tokens: number;
  context: number;
  thinking: number;
}
export const runs = reactive<Record<string, Run>>({});
export const queue = reactive<Record<string, { text: string; images: Attachment[] }[]>>({});
export const busy = computed(() => !!runs[chatKey.value]);
export const suggestions = reactive<Record<string, string>>({});

export const live = computed(() => runs[chatKey.value] ?? { id: "", started: 0, tokens: 0, context: 0, thinking: 0 });
export const info = reactive<{ model: string; version: string; commands: Record<string, string[]> }>({ model: "", version: "", commands: {} });
export const usageOpen = ref(false);
export const rateLoading = ref(false);
export const toast = shallowRef<{ id: number; text: string } | null>(null);

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
export const fmtMs = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
export const modelLabel = (id: string) => MODELS.find((m) => m.id && id.includes(m.label.split(" ")[0].toLowerCase()))?.label ?? id;

export function notify(text: string) {
  const id = nextId();
  toast.value = { id, text };
  setTimeout(() => toast.value?.id === id && (toast.value = null), 2400);
}

export function log(key: string, kind: LogKind, text: string, meta?: string) {
  markDirty(key);
  flushLogs();
  if (!logs.has(key)) logs.set(key, []);
  const lines = logs.get(key)!;
  lines.push({ id: nextId(), kind, text, meta, at: Date.now() });
  return lines[lines.length - 1];
}

export function selectChat(key: string) {
  const c = chats.find((x) => x.key === key);
  const r = c && repos.find((x) => x.id === c.repo);
  if (!c || !r) return;
  Object.assign(tab.value, { mode: "claude", chat: isProjectChat(c) ? undefined : key, cwd: r.path });
}

export const knownCommands = shallowRef(new Set(["claude", "clear", "exit", "cd"]));
export const git = reactive<Record<string, { branch: string; dirty: boolean } | null>>({});

if (isTauri)
  invoke<string[]>("shell_commands")
    .then((list) => (knownCommands.value = new Set([...knownCommands.value, ...list])))
    .catch(() => {});

export async function refreshGit(t: Tab) {
  if (!isTauri) return;
  git[t.id] = await invoke<{ branch: string; dirty: boolean } | null>("git_info", { cwd: t.cwd }).catch(() => null);
}
watch(
  () => tab.value.cwd,
  () => refreshGit(tab.value),
  { immediate: true },
);
export const resumeScreen = reactive<Record<string, "shell" | "chat">>({});

export function openResume(t: Tab, from: "shell" | "chat") {
  t.mode = "claude";
  resumeScreen[t.id] = from;
}

export function closeResume(t: Tab) {
  const from = resumeScreen[t.id];
  delete resumeScreen[t.id];
  if (from === "shell") t.mode = "shell";
}

export function touch(line: LogLine) {
  for (const [key, lines] of logs) if (lines.includes(line)) markDirty(key);
  flushLogs();
}

export function pendingPermission(key: string) {
  return logs.get(key)?.findLast((l) => l.permission?.state === "pending");
}
