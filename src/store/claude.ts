import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  BRIEF_RULES,
  isTauri,
  oneshot,
  probe,
  probeRate,
  respond,
  send as claudeSend,
  sendMore,
  sessions as claudeSessions,
  stop as claudeStop,
  transcript as claudeTranscript,
  type Block,
  type Decision,
  type SessionInfo,
} from "@/lib/claude";
import type { Chat, LogLine, Todo } from "@/lib/types";
import {
  chats,
  EFFORTS,
  ensureRepo,
  flushLogs,
  fmtMs,
  fmtTokens,
  info,
  isProjectChat,
  log,
  logs,
  markDirty,
  MODELS,
  MODES,
  modelLabel,
  nextId,
  notify,
  openResume,
  projectKey,
  queue,
  rate,
  rateLoading,
  refreshGit,
  repo,
  repoId,
  repos,
  runs,
  selectChat,
  settings,
  suggestions,
  tab,
  tabs,
  touch,
  usageOpen,
  type Attachment,
  type Run,
  type Tab,
} from "./state";

async function suggest(c: Chat) {
  const lines = logs.get(c.key) ?? [];
  const user = lines.findLast((l) => l.kind === "user")?.text ?? "";
  const reply = lines
    .filter((l) => l.kind === "text")
    .slice(-3)
    .map((l) => l.text)
    .join("\n");
  const r = repos.find((x) => x.id === c.repo);
  if (!r || !reply) return;
  const prompt = [
    "You predict the next message a developer will type to their coding assistant (Claude Code).",
    "Last exchange:",
    `DEVELOPER: ${user.slice(-1200)}`,
    `ASSISTANT: ${reply.slice(-2000)}`,
    "Reply with ONLY the developer's most likely next message: short (under 12 words), in their casual style, no quotes.",
    "If there is no obvious next step, reply NONE.",
  ].join("\n");
  try {
    const out = (await oneshot(r.path, prompt))
      .split("\n")[0]
      .trim()
      .replace(/^["'`]|["'`]$/g, "");
    if (out && out !== "NONE" && out.length <= 120 && !runs[c.key]) suggestions[c.key] = out;
  } catch {}
}
export async function startClaude(t: Tab, args: string[]) {
  t.mode = "claude";
  t.chat = undefined;
  const key = projectKey(ensureRepo(t.cwd));
  const c = chats.find((x) => x.key === key)!;
  loadCommands(c.repo);
  const words: string[] = [];
  const ignored: string[] = [];
  let action: "new" | "resume" | "continue" = "new";
  let resumeId = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => (args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : "");
    if (a === "--resume" || a === "-r") ((action = "resume"), (resumeId = value()));
    else if (a === "--continue" || a === "-c") action = "continue";
    else if (a === "--model") settings.model = value();
    else if (a === "--effort") settings.effort = value();
    else if (a === "--permission-mode") settings.mode = value() || settings.mode;
    else if (a.startsWith("-")) ignored.push(a);
    else words.push(a);
  }
  if (action === "resume") {
    if (resumeId) await resume(c, resumeId);
    else openResume(t, "shell");
  } else if (action === "continue") {
    const latest = (await listSessions(c))[0];
    if (latest) await resume(c, latest.id);
  } else if (!runs[c.key]) newSession(c);
  if (ignored.length) log(c.key, "sys", `Ignored ${ignored.join(" ")} — not supported in Cockpit.`);
  if (words.length) ask(c, words.join(" ").replace(/^["']|["']$/g, ""));
}

export function addTicket(input: string) {
  const key = input.toUpperCase().match(/([A-Z][A-Z0-9]+-\d+)/)?.[1];
  if (!key) return null;
  if (!chats.some((c) => c.key === key)) chats.push({ key, repo: repoId.value || ensureRepo(tab.value.cwd), title: key });
  selectChat(key);
  return key;
}

async function loadCommands(id: string) {
  const r = repos.find((x) => x.id === id);
  if (!isTauri || !r || info.commands[id]) return;
  try {
    const s = await probe(r.path);
    if (s) {
      info.commands[id] = s.commands;
      info.model ||= s.model;
      info.version ||= s.version;
    }
  } catch {}
}

async function refreshRate() {
  if (!isTauri || rateLoading.value || !repo.value) return;
  rateLoading.value = true;
  try {
    const r = await probeRate(repo.value.path);
    if (r) rate.value = { fiveHour: r.fiveHour, sevenDay: r.sevenDay, at: Date.now() };
  } catch {
  } finally {
    rateLoading.value = false;
  }
}

export function showUsage() {
  usageOpen.value = true;
  if (!rate.value || Date.now() - rate.value.at > 60_000) refreshRate();
}

function newSession(c: Chat) {
  markDirty(c.key);
  delete suggestions[c.key];
  c.session = undefined;
  c.cost = undefined;
  logs.set(c.key, []);
}

export async function listSessions(c: Chat): Promise<SessionInfo[]> {
  const r = repos.find((x) => x.id === c.repo);
  if (!isTauri || !r) return [];
  try {
    return await claudeSessions(r.path);
  } catch {
    return [];
  }
}

export async function resume(c: Chat, id: string) {
  const r = repos.find((x) => x.id === c.repo);
  if (!r || runs[c.key]) return;
  let items;
  try {
    items = await claudeTranscript(r.path, id);
  } catch {
    log(c.key, "err", `No session ${id} in ${r.path}`);
    return;
  }
  newSession(c);
  c.session = id;
  for (const it of items) {
    if (it.kind === "toolResult") {
      const l = logs.get(c.key)?.findLast((x) => x.toolId === it.id);
      if (l) Object.assign(l, { out: it.output, error: it.isError });
    } else if (it.kind === "tool") Object.assign(log(c.key, "tool", it.name, it.detail), { toolId: it.id, diff: it.diff ?? undefined });
    else log(c.key, it.kind, it.text);
  }
  log(c.key, "sys", "Resumed — new messages continue this session.");
}

function brief(c: Chat) {
  return isProjectChat(c) ? BRIEF_RULES : `You're working on Jira ticket ${c.key}.\n\n${BRIEF_RULES}`;
}

function builtin(c: Chat, prompt: string) {
  const [cmd, arg = ""] = prompt.slice(1).split(/\s+/, 2);
  switch (cmd) {
    case "model": {
      const m = MODELS.find((x) => x.id === arg || x.label.toLowerCase().startsWith(arg.toLowerCase()));
      if (arg && m) settings.model = m.id;
      log(c.key, "sys", `Model: ${settings.model ? modelLabel(settings.model) : "Default"}`);
      return true;
    }
    case "effort":
      if (EFFORTS.includes(arg)) settings.effort = arg;
      log(c.key, "sys", `Effort: ${settings.effort || "default"}`);
      return true;
    case "clear":
      newSession(c);
      notify("Fresh session");
      return true;
    case "usage":
    case "cost":
      showUsage();
      return true;
    case "exit":
    case "quit":
      tab.value.mode = "shell";
      return true;
    case "memory":
      openMemory(c);
      return true;
    case "permissions":
    case "hooks":
    case "config":
      showSettings(c, cmd);
      return true;
    case "rewind":
      rewindRequest.value = { key: c.key, at: nextId() };
      return true;
    case "help":
      log(
        c.key,
        "sys",
        "↵ send · ⇧↵ newline · esc stop · esc esc rewind · ⇧tab mode\n/ commands · @ mention a file · ! run a shell command · # save a memory\n⌘K jump or add a Jira key · ⌘L focus input · ^C back to the terminal",
      );
      return true;
  }
  return false;
}

export async function runBang(c: Chat, cmd: string) {
  const r = repos.find((x) => x.id === c.repo);
  if (!r || !cmd.trim()) return;
  const line = log(c.key, "bang", cmd);
  const started = Date.now();
  const res = await invoke<{ output: string; code: number }>("run_command", { cwd: r.path, cmd, input: null }).catch((e) => ({ output: String(e), code: 1 }));
  Object.assign(line, { out: res.output, error: res.code !== 0, ms: Date.now() - started });
  touch(line);
  c.bang = `${c.bang ?? ""}<bash-input>${cmd}</bash-input>\n<bash-stdout>${res.output.slice(0, 20000)}</bash-stdout>\n`;
}

const memoryPaths = (c: Chat) => {
  const r = repos.find((x) => x.id === c.repo);
  return { project: `${r?.path ?? "~"}/CLAUDE.md`, user: "~/.claude/CLAUDE.md" };
};

export async function saveMemory(c: Chat, text: string, scope: "project" | "user") {
  const path = memoryPaths(c)[scope];
  await invoke("append_file", { path, text: `- ${text.replace(/^#\s*/, "")}` })
    .then(() => notify(`Saved to ${path}`))
    .catch((e) => log(c.key, "err", String(e)));
}

function openMemory(c: Chat) {
  const { project, user } = memoryPaths(c);
  log(c.key, "sys", `Memory files (click to open):\n${project}\n${user}`).meta = "paths";
}

async function showSettings(c: Chat, section: string) {
  const r = repos.find((x) => x.id === c.repo);
  const files = await invoke<[string, Record<string, any>][]>("read_settings", { cwd: r?.path ?? "~" }).catch(() => []);
  const lines: string[] = [];
  for (const [path, json] of files) {
    if (section === "permissions") {
      const allow = json.permissions?.allow ?? [];
      const deny = json.permissions?.deny ?? [];
      if (allow.length || deny.length) lines.push(path, ...allow.map((x: string) => `  allow  ${x}`), ...deny.map((x: string) => `  deny   ${x}`), "");
    } else if (section === "hooks") {
      for (const [event, entries] of Object.entries<any[]>(json.hooks ?? {}))
        for (const e of entries) for (const h of e.hooks ?? []) lines.push(`${path}  ${event}${e.matcher ? ` (${e.matcher})` : ""}  ${h.command ?? h.type}`);
    } else lines.push(path);
  }
  const empty = { permissions: "No permission rules.", hooks: "No hooks configured.", config: "No settings files." }[section];
  log(c.key, "sys", lines.length ? lines.join("\n").trimEnd() : (empty ?? "")).meta = "paths";
}

export const rewindRequest = ref<{ key: string; at: number } | null>(null);
export const statusLines = reactive<Record<string, string>>({});
const statusCommands = new Map<string, string | null>();

async function refreshStatusLine(c: Chat) {
  const r = repos.find((x) => x.id === c.repo);
  if (!isTauri || !r) return;
  if (!statusCommands.has(r.path)) {
    const files = await invoke<[string, Record<string, any>][]>("read_settings", { cwd: r.path }).catch(() => []);
    statusCommands.set(
      r.path,
      files
        .map(([, j]) => j.statusLine?.command)
        .filter(Boolean)
        .at(-1) ?? null,
    );
  }
  const command = statusCommands.get(r.path);
  if (!command) return;
  const input = JSON.stringify({
    session_id: c.session,
    cwd: r.path,
    model: { id: info.model, display_name: modelLabel(settings.model || info.model) },
    workspace: { current_dir: r.path, project_dir: r.path },
    cost: { total_cost_usd: c.cost ?? 0 },
  });
  const res = await invoke<{ output: string }>("run_command", { cwd: r.path, cmd: command, input }).catch(() => null);
  if (res) statusLines[c.key] = res.output.split("\n")[0];
}

export async function rewind(c: Chat, keep: number) {
  const r = repos.find((x) => x.id === c.repo);
  if (!r || !c.session || runs[c.key]) return;
  const id = await invoke<string>("session_rewind", { cwd: r.path, id: c.session, keepUsers: keep }).catch((e) => {
    log(c.key, "err", String(e));
    return "";
  });
  if (id) await resume(c, id);
}

export function cycleMode() {
  const i = MODES.findIndex((m) => m.id === settings.mode);
  settings.mode = MODES[(i + 1) % MODES.length].id;
}

export async function decide(line: LogLine, decision: Decision, answers?: Record<string, string>) {
  const p = line.permission;
  if (!p || p.state !== "pending") return;
  const plan = p.request.tool === "ExitPlanMode" && decision !== "deny";
  const extra = plan
    ? { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }
    : answers
      ? { updatedInput: { ...p.request.input, answers } }
      : {};
  if (answers) p.answers = answers;
  try {
    await respond(p.run, p.request, plan ? "allow" : decision, extra);
    p.state = decision;
    touch(line);
    if (plan) settings.mode = "acceptEdits";
  } catch {
    p.state = "expired";
    touch(line);
  }
}

export async function ask(c: Chat, text: string, images: Attachment[] = []) {
  const prompt = text.trim();
  const r = repos.find((x) => x.id === c.repo);
  if ((!prompt && !images.length) || !r) return;
  if (!images.length && /^(exit|quit)$/i.test(prompt)) return builtin(c, `/${prompt.toLowerCase()}`);
  if (!images.length && prompt.startsWith("/") && builtin(c, prompt)) return;
  const active = runs[c.key];
  if (active) {
    const blocks: Block[] = [
      ...images.map((i): Block => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })),
      ...(prompt ? [{ type: "text", text: prompt } as Block] : []),
    ];
    try {
      await sendMore(active.id, blocks);
      Object.assign(log(c.key, "user", prompt), images.length ? { images: images.map((i) => i.thumb) } : {});
    } catch {
      (queue[c.key] ??= []).push({ text: prompt, images });
    }
    return;
  }

  delete suggestions[c.key];
  Object.assign(log(c.key, "user", prompt), images.length ? { images: images.map((i) => i.thumb) } : {});

  if (!isTauri) {
    log(c.key, "text", "Preview mode — run `bun tauri dev` to talk to Claude Code.");
    return;
  }

  const run: Run = { id: `${c.key}-${Date.now()}`, started: Date.now(), tokens: 0, context: 0, thinking: 0 };
  runs[c.key] = run;
  let stream: LogLine | null = null;
  const base = c.session || prompt.startsWith("/") ? prompt : brief(c) + prompt;
  const full = c.bang && !prompt.startsWith("/") ? `${c.bang}\n${base}` : base;
  if (!prompt.startsWith("/")) c.bang = undefined;
  const content: Block[] = [
    ...images.map((i): Block => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })),
    ...(full ? [{ type: "text", text: full } as Block] : []),
  ];
  const opts = { session: c.session, model: settings.model || undefined, effort: settings.effort || undefined, mode: settings.mode };

  await claudeSend(run.id, r.path, content, opts, {
    onEvent: (e) => {
      if (e.kind !== "delta" && e.kind !== "tokens" && e.kind !== "thinking") {
        markDirty(c.key);
        flushLogs();
      }
      const live = runs[c.key];
      switch (e.kind) {
        case "session":
          c.session = e.id;
          info.model = e.model;
          info.version ||= e.version;
          info.commands[c.repo] = e.commands;
          break;
        case "delta":
          stream ??= log(c.key, "text", "");
          stream.text += e.text;
          break;
        case "text":
          if (stream) stream.text = e.text;
          else log(c.key, "text", e.text);
          stream = null;
          break;
        case "tool":
          stream = null;
          Object.assign(log(c.key, "tool", e.name, e.detail), { toolId: e.id, diff: e.diff });
          if (e.name === "TodoWrite" && Array.isArray(e.input.todos)) c.todos = e.input.todos as Todo[];
          break;
        case "toolResult": {
          const l = logs.get(c.key)?.findLast((x) => x.toolId === e.id);
          if (l) Object.assign(l, { out: e.output, error: e.isError, ms: Date.now() - l.at });
          break;
        }
        case "permission":
          stream = null;
          log(c.key, "perm", e.request.tool, e.request.detail).permission = { run: run.id, request: e.request, state: "pending" };
          break;
        case "sub": {
          const l = logs.get(c.key)?.findLast((x) => x.toolId === e.parent);
          if (l) (l.children ??= []).push({ name: e.name, detail: e.detail });
          break;
        }
        case "subProgress": {
          const l = logs.get(c.key)?.findLast((x) => x.toolId === e.parent);
          if (l) l.progress = e.text;
          break;
        }
        case "thinking":
          if (live) live.thinking = e.tokens;
          break;
        case "tokens":
          if (live) Object.assign(live, { tokens: e.output, context: e.context });
          if (e.context) c.context = e.context;
          break;
        case "result": {
          const spent = Math.max(0, e.cost - (c.cost ?? 0));
          c.cost = e.cost;
          log(c.key, "stats", `${fmtMs(e.ms || Date.now() - run.started)} · ↓ ${fmtTokens(e.output || run.tokens)} tokens · $${spent.toFixed(2)}`);
          break;
        }
        case "rate":
          rate.value = { fiveHour: e.fiveHour, sevenDay: e.sevenDay, at: Date.now() };
          break;
        case "error":
          stream = null;
          log(c.key, "err", e.text);
      }
    },
    onDone: () => {
      logs.get(c.key)?.forEach((l) => l.permission?.state === "pending" && (l.permission.state = "expired"));
      markDirty(c.key);
      flushLogs();
      if (runs[c.key]?.id === run.id) delete runs[c.key];
      tabs.filter((t) => t.mode === "claude").forEach(refreshGit);
      const next = queue[c.key]?.shift();
      if (next) ask(c, next.text, next.images);
      else if (logs.get(c.key)?.at(-1)?.kind === "stats") suggest(c);
      refreshStatusLine(c);
    },
  });
}

export function cancel(c?: Chat) {
  const run = c && runs[c.key];
  if (!run) return;
  queue[c.key] = [];
  claudeStop(run.id);
}
