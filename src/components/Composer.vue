<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { Square, X } from "@lucide/vue";
import { highlight, withCursor } from "@/lib/highlight";
import { ansi } from "@/lib/ansi";
import { BUILTINS, EFFORTS, MODELS, MODES, fmtTokens, modelLabel, useCockpit, type Attachment } from "@/composables/useCockpit";
import { invoke } from "@tauri-apps/api/core";

const {
  chat,
  tab,
  busy: claudeBusy,
  live,
  toast,
  ask,
  cancel,
  settings,
  info,
  rate,
  showUsage,
  queue,
  currentLog,
  pendingPermission,
  decide,
  cycleMode,
  shellRuns,
  runCommand,
  interruptTab,
  openResume,
  sendInput,
  suggestions,
  knownCommands,
  git,
  clearShell,
  zshComplete,
  runBang,
  saveMemory,
  rewind,
  rewindRequest,
  statusLines,
} = useCockpit();

const shell = computed(() => tab.value.mode === "shell");
const shellSegments = computed(() => {
  const segs = highlight(draft.value, knownCommands.value);
  if (!caret.value.show) return segs;
  const g = shellGhost.value;
  if (g) return [...segs, { text: g[0], cls: "text-paper-faint", cursor: true }, { text: g.slice(1), cls: "text-paper-faint" }];
  return withCursor(segs, caret.value.before.length);
});
const ghost = computed(() =>
  !shell.value && chat.value && !draft.value && !attachments.value.length && !claudeBusy.value && !pending.value ? (suggestions[chat.value.key] ?? "") : "",
);
const busy = computed(() => (shell.value ? !!shellRuns[tab.value.id] : claudeBusy.value));
const suggestion = ref("");
const shellGhost = computed(() => {
  if (!shell.value || !draft.value || busy.value || picker.value || caret.value.before.length !== draft.value.length) return "";
  return suggestion.value.startsWith(draft.value) ? suggestion.value.slice(draft.value.length) : "";
});

const pathCache = new Map<string, Promise<string[]>>();
function listPath(cwd: string, partial: string) {
  const key = `${cwd}\u0000${partial}`;
  if (!pathCache.has(key)) {
    if (pathCache.size > 200) pathCache.clear();
    pathCache.set(
      key,
      invoke<string[]>("complete_path", { cwd, partial }).catch(() => []),
    );
  }
  return pathCache.get(key)!;
}

async function validInCwd(command: string, cwd: string) {
  const [first, ...rest] = command.trim().split(/\s+/);
  if (first === "cd") {
    const target = rest.join(" ").replace(/\/$/, "");
    if (!target || target === "-" || target === "~") return true;
    const options = await listPath(cwd, target);
    return options.includes(`${target}/`);
  }
  return knownCommands.value.has(first) || first.includes("/");
}

async function suggestFor(text: string, cwd: string) {
  const local = currentLog.value
    .filter((l) => l.kind === "user")
    .map((l) => l.text)
    .reverse();
  const seen = new Set<string>();
  const candidates = [...local, ...shellHistory.value].filter((h) => h.startsWith(text) && h !== text && !seen.has(h) && seen.add(h)).slice(0, 8);
  for (const c of candidates) if (await validInCwd(c, cwd)) return c;
  const word = text.match(/\S+$/)?.[0];
  if (!word || !/\s/.test(text)) return "";
  const dirsOnly = /^\s*cd\s/.test(text);
  const options = (await listPath(cwd, word)).filter((o) => !dirsOnly || o.endsWith("/"));
  return options[0] ? text + options[0].slice(word.length) : "";
}

const started = computed(() => (shell.value ? (shellRuns[tab.value.id]?.started ?? 0) : live.value.started));

const attachments = ref<Attachment[]>([]);
const mode = computed(() => MODES.find((m) => m.id === settings.mode) ?? MODES[0]);
const pending = computed(() => (chat.value ? pendingPermission(chat.value.key) : undefined));
const queued = computed(() => (chat.value ? (queue[chat.value.key] ?? []) : []));

function readImage(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 240 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      attachments.value.push({ type: file.type, data: url.split(",")[1], thumb: canvas.toDataURL("image/jpeg", 0.7) });
    };
    img.src = url;
  };
  reader.readAsDataURL(file);
}

function onPaste(e: ClipboardEvent) {
  if (shell.value) return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(readImage);
}

function onDrop(e: DragEvent) {
  [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/")).forEach(readImage);
}

let lastEsc = 0;
let historyAt = -1;
let stash = "";
const history = computed(() =>
  currentLog.value
    .filter((l) => l.kind === "user" && l.text)
    .map((l) => l.text)
    .reverse(),
);

function recall(dir: 1 | -1) {
  const next = historyAt + dir;
  if (next < -1 || next >= history.value.length) return false;
  if (historyAt === -1) stash = draft.value;
  historyAt = next;
  draft.value = next === -1 ? stash : history.value[next];
  nextTick(() => {
    grow();
    const el = input.value!;
    el.selectionStart = el.selectionEnd = el.value.length;
  });
  return true;
}

const input = ref<HTMLTextAreaElement>();
const draft = ref("");
const focused = ref(false);
const caret = ref({ before: "", ch: " ", show: true, tick: 0 });

function syncCaret() {
  const el = input.value;
  if (!el) return;
  const at = el.selectionStart;
  caret.value = {
    before: el.value.slice(0, at),
    ch: el.value[at] && el.value[at] !== "\n" ? el.value[at] : " ",
    show: el.selectionStart === el.selectionEnd,
    tick: caret.value.tick + 1,
  };
}
useEventListener(document, "selectionchange", () => document.activeElement === input.value && syncCaret());
watch(draft, () => nextTick(syncCaret));
const bashMode = computed(() => !shell.value && draft.value.startsWith("!"));
const memoryMode = computed(() => !shell.value && draft.value.startsWith("#"));
const todos = computed(() => (!shell.value && chat.value?.todos?.some((t) => t.status !== "completed") ? chat.value.todos : []));
const mention = computed(() => {
  if (shell.value || !input.value) return null;
  const m = caret.value.before.match(/(?:^|\s)@([^\s@]*)$/);
  return m ? m[1] : null;
});
const mentionFiles = ref<string[]>([]);
let mentionTimer: number | undefined;
watch(mention, (q) => {
  clearTimeout(mentionTimer);
  if (q == null) return (mentionFiles.value = []);
  mentionTimer = window.setTimeout(() => loadMentions(q), 80);
});
async function loadMentions(q: string) {
  const found = await invoke<string[]>("list_files", { cwd: tab.value.cwd, query: q }).catch(() => [] as string[]);
  if (mention.value === q) mentionFiles.value = found;
}
const now = ref(Date.now());
let timer: number | undefined;

const VERBS = ["Vectoring", "Triangulating", "Locking on", "Calibrating", "Deciphering", "Plotting", "Banking", "Climbing"];
const verb = computed(() => VERBS[Math.floor((now.value - started.value) / 4000) % VERBS.length]);
const elapsed = computed(() => {
  const s = Math.max(0, Math.floor((now.value - started.value) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
});
watch(busy, (b) => {
  clearInterval(timer);
  if (b) timer = window.setInterval(() => (now.value = Date.now()), 250);
});
onBeforeUnmount(() => clearInterval(timer));
watch(
  () => [tab.value.id, tab.value.mode],
  () => nextTick(() => input.value?.focus()),
);
onMounted(() =>
  invoke<string[]>("shell_history")
    .then((h) => (shellHistory.value = h))
    .catch(() => {}),
);

type Picker = "model" | "effort" | "history" | "complete" | "memory" | "rewind";
type Item = { id: string; label: string; hint: string; current?: boolean; run: () => void };
const picker = ref<Picker | null>(null);
const shellHistory = ref<string[]>([]);
const completions = ref<{ span: number; options: { value: string; desc: string }[] }>({ span: 0, options: [] });
const cursor = ref(0);

const slash = computed(() => (!shell.value && /^\/\S*$/.test(draft.value) ? draft.value.slice(1).toLowerCase() : null));

const items = computed<Item[]>(() => {
  const c = chat.value!;
  if (picker.value === "model")
    return MODELS.map((m) => ({
      id: m.id || "default",
      label: m.label,
      hint: m.hint,
      current: settings.model === m.id,
      run: () => pick(() => (settings.model = m.id)),
    }));
  if (picker.value === "effort")
    return EFFORTS.map((e) => ({
      id: e || "default",
      label: e || "default",
      hint: "",
      current: settings.effort === e,
      run: () => pick(() => (settings.effort = e)),
    }));
  if (picker.value === "history") {
    const q = draft.value.toLowerCase();
    return shellHistory.value
      .filter((h) => h.toLowerCase().includes(q))
      .slice(0, 60)
      .map((h, i) => ({ id: `${i}:${h}`, label: h, hint: "", run: () => fill(h) }));
  }
  if (picker.value === "memory")
    return [
      { id: "project", label: "Project memory", hint: "CLAUDE.md in this project", run: () => commitMemory("project") },
      { id: "user", label: "User memory", hint: "~/.claude/CLAUDE.md, all projects", run: () => commitMemory("user") },
    ];
  if (picker.value === "rewind")
    return userTurns.value.map((t, i) => ({ id: String(i), label: `${i + 1}`.padStart(3), hint: t, run: () => doRewind(i) })).reverse();
  if (mention.value != null && mentionFiles.value.length)
    return mentionFiles.value.map((f) => ({ id: f, label: `@${f}`, hint: "", run: () => insertMention(f) }));
  if (picker.value === "complete")
    return completions.value.options.map((o) => ({ id: o.value, label: o.value, hint: o.desc, run: () => applyCompletion(o.value) }));
  const q = slash.value;
  if (q == null) return [];
  const built = BUILTINS.filter((b) => b.name.includes(q)).map((b) => ({ id: b.name, label: `/${b.name}`, hint: b.hint, run: () => command(b.name) }));
  const cli = (info.commands[c.repo] ?? [])
    .filter((n) => n.toLowerCase().includes(q) && !BUILTINS.some((b) => b.name === n))
    .slice(0, 40)
    .map((n) => ({ id: n, label: `/${n}`, hint: "", run: () => command(n) }));
  return [...built, ...cli].sort((a, b) => Number(!a.id.startsWith(q)) - Number(!b.id.startsWith(q)));
});
watch(items, () => (cursor.value = 0));

const userTurns = computed(() => currentLog.value.filter((l) => l.kind === "user").map((l) => l.text));
let memoryText = "";

function commitMemory(scope: "project" | "user") {
  picker.value = null;
  saveMemory(chat.value!, memoryText, scope);
  memoryText = "";
  nextTick(() => input.value?.focus());
}

function doRewind(index: number) {
  picker.value = null;
  const text = userTurns.value[index];
  rewind(chat.value!, index).then(() => fill(text));
}

function insertMention(file: string) {
  const at = input.value!.selectionStart;
  const before = draft.value.slice(0, at).replace(/@[^\s@]*$/, `@${file} `);
  draft.value = before + draft.value.slice(at);
  mentionFiles.value = [];
  nextTick(() => {
    grow();
    input.value!.focus();
    input.value!.selectionStart = input.value!.selectionEnd = before.length;
  });
}

watch(rewindRequest, (r) => r && chat.value?.key === r.key && (picker.value = "rewind"));

function fill(text: string) {
  picker.value = null;
  draft.value = text;
  nextTick(() => {
    grow();
    input.value!.focus();
    input.value!.selectionStart = input.value!.selectionEnd = text.length;
  });
}

async function openHistory() {
  const seen = new Set<string>();
  const recent = currentLog.value
    .filter((l) => l.kind === "user")
    .map((l) => l.text)
    .reverse();
  const disk = await invoke<string[]>("shell_history").catch(() => [] as string[]);
  shellHistory.value = [...recent, ...disk].filter((h) => !seen.has(h) && seen.add(h));
  picker.value = "history";
}

function currentWord() {
  const at = input.value!.selectionStart;
  const before = draft.value.slice(0, at);
  const word = before.match(/[^\s|;&<>]*$/)![0];
  const first = /^\s*$/.test(before.slice(0, before.length - word.length).replace(/.*(?:\|\||&&|[|;])/s, ""));
  return { at, word, first };
}

function replaceBefore(span: number, text: string) {
  const at = input.value!.selectionStart;
  draft.value = draft.value.slice(0, at - span) + text + draft.value.slice(at);
  const pos = at - span + text.length;
  nextTick(() => {
    grow();
    input.value!.focus();
    input.value!.selectionStart = input.value!.selectionEnd = pos;
  });
}

function applyCompletion(option: string) {
  picker.value = null;
  replaceBefore(completions.value.span, option + (option.endsWith("/") ? "" : " "));
}

async function complete() {
  const at = input.value!.selectionStart;
  const { word, first } = currentWord();
  const native = await zshComplete(tab.value, draft.value.slice(0, at));
  let span = word.length;
  let options: { value: string; desc: string }[];
  if (native?.matches.length) {
    span = native.span;
    options = native.matches;
  } else {
    const names =
      first && !word.includes("/")
        ? [...knownCommands.value]
            .filter((c) => c.startsWith(word))
            .sort()
            .slice(0, 200)
        : await invoke<string[]>("complete_path", { cwd: tab.value.cwd, partial: word }).catch(() => [] as string[]);
    options = names.map((value) => ({ value, desc: "" }));
  }
  if (!options.length) return;
  completions.value = { span, options };
  if (options.length === 1) return applyCompletion(options[0].value);
  let common = options[0].value;
  for (const o of options) while (!o.value.startsWith(common)) common = common.slice(0, -1);
  const typed = draft.value.slice(at - span, at);
  if (common.length > typed.length && common.startsWith(typed)) {
    replaceBefore(span, common);
    completions.value = { span: common.length, options };
  }
  picker.value = "complete";
}

function pick(fn: () => unknown) {
  fn();
  close();
}

function close() {
  picker.value = null;
  draft.value = "";
  nextTick(() => input.value?.focus());
}

async function openPicker(p: Picker) {
  draft.value = "";
  picker.value = p;
}

function command(name: string) {
  if (name === "resume") return ((draft.value = ""), openResume(tab.value, "chat"));
  if (name === "model" || name === "effort") return openPicker(name);
  draft.value = "";
  ask(chat.value!, `/${name}`);
}

function grow() {
  const el = input.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

function submit() {
  if (shell.value) {
    if (busy.value) {
      sendInput(tab.value, draft.value);
      draft.value = "";
      return nextTick(grow);
    }
    if (!draft.value.trim()) return;
    runCommand(tab.value, draft.value);
    draft.value = "";
    historyAt = -1;
    return nextTick(grow);
  }
  if (!draft.value.trim() && !attachments.value.length) return;
  if (bashMode.value) {
    runBang(chat.value!, draft.value.slice(1).trim());
    draft.value = "";
    return nextTick(grow);
  }
  if (memoryMode.value) {
    memoryText = draft.value.slice(1).trim();
    draft.value = "";
    picker.value = "memory";
    return;
  }
  ask(chat.value!, draft.value, attachments.value);
  draft.value = "";
  attachments.value = [];
  historyAt = -1;
  nextTick(grow);
}

function onKey(e: KeyboardEvent) {
  const menu = items.value.length > 0;
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "r" && shell.value) {
    e.preventDefault();
    return picker.value === "history" ? (cursor.value = (cursor.value + 1) % Math.max(1, items.value.length)) : openHistory();
  }
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    return shell.value && clearShell(tab.value);
  }
  if (e.key === "Tab" && !e.shiftKey && shell.value && !menu && !busy.value) {
    e.preventDefault();
    return complete();
  }
  if (picker.value === "complete" && !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) picker.value = null;
  const empty = !draft.value && !attachments.value.length;
  if (e.key === "Tab" && e.shiftKey && !shell.value) {
    e.preventDefault();
    return cycleMode();
  }
  if (pending.value && empty && !menu) {
    if (pending.value.text === "AskUserQuestion" && e.key !== "Escape") return;
    if (e.key === "Enter") return (e.preventDefault(), decide(pending.value, "allow"));
    if (e.key === "Tab") return (e.preventDefault(), decide(pending.value, "always"));
    if (e.key === "Escape") return (e.preventDefault(), decide(pending.value, "deny"));
  }
  if (shellGhost.value && !menu && (e.key === "ArrowRight" || (e.ctrlKey && e.key.toLowerCase() === "f"))) {
    e.preventDefault();
    draft.value += shellGhost.value;
    return nextTick(() => {
      grow();
      input.value!.selectionStart = input.value!.selectionEnd = draft.value.length;
    });
  }
  if (ghost.value && !menu && (e.key === "Tab" || e.key === "ArrowRight")) {
    e.preventDefault();
    draft.value = ghost.value;
    return nextTick(() => {
      grow();
      input.value!.selectionStart = input.value!.selectionEnd = draft.value.length;
    });
  }
  const el = input.value!;
  if (!menu && e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0 && recall(1)) return e.preventDefault();
  if (!menu && e.key === "ArrowDown" && historyAt > -1 && el.selectionStart === el.value.length && recall(-1)) return e.preventDefault();
  if (e.key === "Backspace" && empty === false && !draft.value && attachments.value.length) return attachments.value.pop();
  if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = items.value.length;
    cursor.value = (cursor.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    document.getElementById(`opt-${cursor.value}`)?.scrollIntoView({ block: "nearest" });
  } else if (menu && e.key === "Tab") {
    e.preventDefault();
    const it = items.value[cursor.value];
    if (picker.value || mention.value != null) it.run();
    else draft.value = `${it.label} `;
  } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.isComposing) {
    e.preventDefault();
    if (menu) items.value[cursor.value].run();
    else submit();
  } else if (e.key === "Escape") {
    const now = Date.now();
    const double = now - lastEsc < 500;
    lastEsc = now;
    if (picker.value === "history" || picker.value === "complete" || picker.value === "memory" || picker.value === "rewind") picker.value = null;
    else if (!shell.value && !busy.value && !draft.value && double && chat.value?.session && userTurns.value.length) picker.value = "rewind";
    else if (picker.value) close();
    else if (slash.value != null) draft.value = "";
    else if (busy.value && !shell.value) cancel(chat.value);
  }
}

const fiveHour = computed(() => (rate.value?.fiveHour ? Math.round(rate.value.fiveHour.utilization * 100) : null));
const TITLES: Record<Picker, string> = {
  model: "Model",
  effort: "Effort",
  history: "History search · type to filter",
  memory: "Save memory to",
  rewind: "Rewind the conversation to before…",
  complete: "Completions",
};

let suggestSeq = 0;
watch([draft, () => tab.value.cwd, shell], async ([text, cwd, isShell]) => {
  const id = ++suggestSeq;
  if (!isShell || !text) return (suggestion.value = "");
  const next = await suggestFor(text, cwd);
  if (id === suggestSeq) suggestion.value = next;
});

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="relative shrink-0">
    <div>
      <div
        v-if="picker || items.length"
        class="border-hair-strong bg-ink-1/95 absolute right-0 bottom-full left-0 max-h-80 overflow-y-auto border-t px-3 py-1.5 backdrop-blur-xl"
      >
        <div v-if="picker" class="text-paper-faint flex justify-between px-2 pb-1 text-[13px]">
          {{ TITLES[picker] }}<span class="tracking-normal normal-case">esc</span>
        </div>
        <div v-if="picker === 'history' && !items.length" class="text-paper-mute px-2.5 py-2 text-[13px]">No matching commands.</div>
        <button
          v-for="(it, i) in items"
          :id="`opt-${i}`"
          :key="it.id"
          class="flex w-full items-baseline gap-4 px-2 py-0.5 text-left"
          :class="i === cursor ? 'bg-amber/12' : ''"
          @mousemove="cursor = i"
          @click="it.run()"
        >
          <span
            class="shrink-0 text-[14px] whitespace-nowrap"
            :class="[i === cursor ? 'text-amber' : 'text-paper', picker === 'history' || picker === 'complete' ? 'truncate' : 'min-w-44']"
            >{{ it.label }}</span
          >
          <span class="min-w-0 truncate text-[14px]" :class="i === cursor ? 'text-paper-dim' : 'text-paper-mute'">{{ it.hint }}</span>
          <span v-if="it.current" class="text-amber ml-auto shrink-0 text-[13px]">*</span>
        </button>
      </div>

      <div v-if="queued.length" class="px-5 pb-1">
        <div v-for="(q, i) in queued" :key="i" class="group text-paper-faint flex items-baseline gap-2 text-[13px]">
          <span class="text-paper-mute">queued</span>
          <span class="truncate">{{ q.text || `${q.images.length} image(s)` }}</span>
          <button class="hover:text-stop opacity-0 transition group-hover:opacity-100" @click="queued.splice(i, 1)"><X class="size-3" /></button>
        </div>
      </div>

      <div v-if="todos?.length" class="px-5 pb-1 text-[13px] leading-[1.45]">
        <div
          v-for="(t, i) in todos"
          :key="i"
          class="flex gap-2"
          :class="t.status === 'completed' ? 'text-paper-faint line-through' : t.status === 'in_progress' ? 'text-amber' : 'text-paper-mute'"
        >
          <span class="shrink-0">{{ t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]" }}</span>
          <span class="truncate">{{ t.content }}</span>
        </div>
      </div>

      <div v-if="pending || busy || toast || bashMode || memoryMode" class="flex h-7 items-center gap-2.5 px-5">
        <template v-if="bashMode">
          <span class="text-warn text-[13px]">! bash mode</span>
          <span class="text-paper-faint text-[12px]">runs in {{ tab.cwd }} · output is shared with Claude on your next message</span>
        </template>
        <template v-else-if="memoryMode">
          <span class="text-sky text-[13px]"># memory</span>
          <span class="text-paper-faint text-[12px]">↵ to choose where to save it</span>
        </template>
        <template v-else-if="pending">
          <template v-if="pending.text === 'AskUserQuestion'">
            <span class="text-sky text-[13px]">Claude has a question</span>
            <span class="text-paper-faint text-[12px]">pick an answer above · esc to skip</span>
          </template>
          <template v-else>
            <span class="text-warn text-[13px]">permission needed</span>
            <span class="text-paper-faint text-[12px]">↵ allow · tab always · esc deny</span>
          </template>
        </template>
        <template v-else-if="busy">
          <span class="live-dot" />
          <span class="text-amber text-[13px]">{{ shell ? "running" : verb }}…</span>
          <span class="text-paper-faint tnum text-[12px]">
            {{ elapsed }}<template v-if="!shell && live.thinking && !live.tokens"> · ✻ thinking {{ fmtTokens(live.thinking) }}</template
            ><template v-if="!shell && live.tokens"> · ↓ {{ fmtTokens(live.tokens) }} tokens</template> · {{ shell ? "^C to interrupt" : "esc to stop" }}
          </span>
        </template>
        <Transition
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
          enter-active-class="transition duration-300"
          leave-active-class="transition duration-300"
        >
          <span v-if="toast" :key="toast.id" class="text-sky ml-auto text-[12px]">{{ toast.text }}</span>
        </Transition>
      </div>

      <div class="border-hair-strong border-y px-5 py-2.5" @dragover.prevent @drop.prevent="onDrop">
        <div v-if="attachments.length" class="mb-2 flex flex-wrap gap-2">
          <div v-for="(a, i) in attachments" :key="i" class="group border-hair-strong relative border">
            <img :src="a.thumb" class="block h-14 w-auto" />
            <button
              class="bg-ink-4 text-paper hover:bg-stop absolute -top-2 -right-2 hidden size-4 place-items-center group-hover:grid"
              @click="attachments.splice(i, 1)"
            >
              <X class="size-2.5" />
            </button>
          </div>
        </div>
        <div class="group flex items-start gap-0">
          <div class="relative min-w-0 flex-1">
            <textarea
              ref="input"
              v-model="draft"
              rows="1"
              class="placeholder:text-paper-faint block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-[14px] leading-6 caret-transparent focus:outline-none"
              :class="shell ? 'text-transparent' : 'text-paper'"
              spellcheck="false"
              autofocus
              @input="grow"
              @keydown="onKey"
              @paste="onPaste"
              @focus="((focused = true), syncCaret())"
              @blur="focused = false"
              @scroll="syncCaret"
            />
            <div
              v-if="caret.show || shell"
              aria-hidden="true"
              class="pointer-events-none absolute inset-0 overflow-hidden py-0.5 text-[14px] leading-6 break-words whitespace-pre-wrap text-transparent"
              :style="{ transform: `translateY(-${input?.scrollTop ?? 0}px)` }"
            >
              <template v-if="shell"
                ><span
                  v-for="(seg, i) in shellSegments"
                  :key="i + (seg.cursor ? `c${caret.tick}` : '')"
                  :class="[seg.cls, seg.cursor && (focused ? 'shell-cursor' : 'idle-cursor')]"
                  >{{ seg.text }}</span
                ></template
              ><template v-else-if="ghost"
                ><span :key="caret.tick" :class="focused ? 'dos-cursor ghost' : 'idle-cursor text-paper-faint'">{{ ghost[0] }}</span
                ><span class="text-paper-faint">{{ ghost.slice(1) }}</span
                ><span class="text-paper-faint/60 ml-3 text-[12px]">⇥ tab</span></template
              ><template v-else
                >{{ caret.before }}<span :key="caret.tick" :class="focused ? 'dos-cursor' : 'idle-cursor'">{{ caret.ch }}</span></template
              >
            </div>
          </div>
          <button
            v-if="busy"
            class="text-paper-mute hover:bg-stop hover:text-ink-0 mt-0.5 flex h-6 shrink-0 items-center gap-1.5 px-2 text-[12px] transition"
            title="Stop (esc)"
            @click="interruptTab(tab)"
          >
            <Square class="size-2.5 fill-current" /> esc
          </button>
        </div>
      </div>

      <div v-if="shell" class="text-paper-faint flex h-8 items-center gap-4 px-5 text-[12px] tracking-normal">
        <span class="flex min-w-0 items-baseline gap-3">
          <span class="text-sky truncate">{{ tab.cwd }}</span>
          <span v-if="git[tab.id]" class="text-paper-mute shrink-0"
            >git:(<span class="text-[#d48cff]">{{ git[tab.id]!.branch }}</span
            >)<span v-if="git[tab.id]!.dirty" class="text-warn"> ✗</span></span
          >
        </span>
      </div>
      <div v-else-if="chat" class="text-paper-faint flex h-8 items-center gap-4 px-5 text-[12px] tracking-normal">
        <button class="hover:text-paper transition" :class="mode.id === 'manual' ? '' : mode.id === 'plan' ? 'text-sky' : 'text-amber'" @click="cycleMode()">
          {{ mode.glyph }} {{ mode.label }} <span class="text-paper-faint">(⇧tab)</span>
        </button>
        <button class="hover:text-paper transition" @click="openPicker('model')">
          {{ settings.model ? modelLabel(settings.model) : info.model ? modelLabel(info.model) : "Default model" }}
        </button>
        <button class="hover:text-paper transition" @click="openPicker('effort')">Effort {{ settings.effort || "default" }}</button>
        <span v-if="live.context || chat.context" class="tnum">Ctx {{ fmtTokens(live.context || chat.context || 0) }}</span>
        <span v-if="chat.cost" class="tnum">${{ chat.cost.toFixed(2) }}</span>
        <span v-if="statusLines[chat.key]" class="min-w-0 truncate" v-html="ansi(statusLines[chat.key])" />
        <button v-if="fiveHour != null" class="tnum hover:text-paper ml-auto flex items-center gap-2 transition" @click="showUsage()">
          5h {{ fiveHour }}%
          <span class="bg-ink-4 inline-block h-[3px] w-10 overflow-hidden">
            <span class="block h-full" :class="fiveHour >= 90 ? 'bg-stop' : 'bg-amber'" :style="{ width: fiveHour + '%' }" />
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
