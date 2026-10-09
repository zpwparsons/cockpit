<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useCockpit } from "@/composables/useCockpit";
import { ansi } from "@/lib/ansi";
import { md } from "@/lib/markdown";
import type { LogLine } from "@/lib/types";

const props = defineProps<{ item: LogLine; streaming?: boolean }>();
const { decide } = useCockpit();
const open = ref(false);

const TOOL_VERB: Record<string, string> = { Bash: "run", Edit: "edit", MultiEdit: "edit", Write: "write", WebFetch: "fetch", ExitPlanMode: "start building" };
const STATE_LABEL = { allow: "allowed", always: "always allowed", deny: "denied", expired: "no longer needed", pending: "" };

const html = computed(() => (props.item.kind === "text" ? md(props.item.text) : ""));
const outHtml = computed(() => (props.item.kind === "out" ? ansi(props.item.text) : open.value && props.item.out ? ansi(props.item.out.trimEnd()) : ""));
const outLines = computed(() => (props.item.out ?? "").trimEnd().split("\n").length);
const diffStat = computed(() => {
  const count = (k: "old" | "new") => (props.item.diff ?? []).reduce((n, d) => n + (d[k] ? d[k].split("\n").length : 0), 0);
  return { add: count("new"), del: count("old") };
});
const diffLines = computed(() =>
  open.value
    ? (props.item.diff ?? []).flatMap((d, i) => [
        ...(i ? [{ cls: "text-paper-faint", text: "  ⋯" }] : []),
        ...(d.old ? d.old.split("\n").map((t) => ({ cls: "diff-del", text: `- ${t}` })) : []),
        ...(d.new ? d.new.split("\n").map((t) => ({ cls: "diff-add", text: `+ ${t}` })) : []),
      ])
    : [],
);
const planHtml = computed(() => (props.item.permission?.request.input.plan ? md(String(props.item.permission.request.input.plan)) : ""));
const toolMs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const toggle = () => (props.item.out != null || props.item.diff || props.item.children?.length) && (open.value = !open.value);

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}
const questions = computed(() => (props.item.text === "AskUserQuestion" ? ((props.item.permission?.request.input.questions as Question[]) ?? []) : []));
const chosen = reactive<Record<string, string[]>>({});
function choose(q: Question, label: string) {
  const cur = chosen[q.question] ?? [];
  chosen[q.question] = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
  if (!q.multiSelect && questions.value.length === 1) submitAnswers();
}
const ready = computed(() => questions.value.every((q) => chosen[q.question]?.length));
function submitAnswers() {
  if (!ready.value) return;
  decide(props.item, "allow", Object.fromEntries(questions.value.map((q) => [q.question, chosen[q.question].join(", ")])));
}

const pathLines = computed(() =>
  props.item.meta === "paths"
    ? props.item.text.split("\n").map((t) => ({ t, path: /^[~/]\S*$/.test(t.trim().split(/\s+/)[0]) ? t.trim().split(/\s+/)[0] : "" }))
    : [],
);
</script>

<template>
  <div v-if="item.kind === 'text'" class="text-paper-dim py-1 select-text" :class="streaming && 'caret'" v-html="html" />

  <pre v-else-if="item.kind === 'out'" class="text-paper-dim py-0.5 text-[13px] leading-[1.35] whitespace-pre-wrap select-text" v-html="outHtml" />

  <pre v-else-if="item.kind === 'sys' && item.meta === 'paths'" class="text-paper-mute py-0.5 whitespace-pre-wrap select-text"><div
      v-for="(l, i) in pathLines"
      :key="i"
    ><span v-if="l.path" class="md-a" :data-path="l.path">{{ l.path }}</span>{{ l.path ? l.t.trim().slice(l.path.length) : l.t }}</div></pre>

  <pre v-else-if="item.kind === 'sys'" class="text-paper-mute py-0.5 whitespace-pre-wrap select-text">{{ item.text }}</pre>

  <div
    v-else-if="item.kind === 'perm' && item.permission && item.text === 'AskUserQuestion'"
    class="my-2 border border-dashed px-3 py-2"
    :class="item.permission.state === 'pending' ? 'border-sky/60' : 'border-hair-strong'"
  >
    <div v-for="q in questions" :key="q.question" class="mb-2 last:mb-0">
      <div class="flex items-baseline gap-2">
        <span :class="item.permission.state === 'pending' ? 'dos-blink text-sky' : 'text-paper-faint'">?</span>
        <span v-if="q.header" class="text-paper-faint text-[12px]">{{ q.header }}</span>
        <span class="text-paper">{{ q.question }}</span>
      </div>
      <div v-if="item.permission.state === 'pending'" class="mt-1.5 flex flex-wrap gap-2 pl-4 text-[13px]">
        <button
          v-for="o in q.options"
          :key="o.label"
          class="border px-2 py-0.5 text-left"
          :class="chosen[q.question]?.includes(o.label) ? 'border-sky bg-sky/12 text-sky' : 'border-hair-strong text-paper-dim hover:border-sky/50'"
          :title="o.description"
          @click="choose(q, o.label)"
        >
          {{ q.multiSelect ? (chosen[q.question]?.includes(o.label) ? "[x]" : "[ ]") : "" }} {{ o.label }}
        </button>
      </div>
      <div v-else class="text-paper-mute mt-1 pl-4 text-[13px]">→ {{ item.permission.answers?.[q.question] ?? STATE_LABEL[item.permission.state] }}</div>
    </div>
    <div v-if="item.permission.state === 'pending' && (questions.length > 1 || questions.some((q) => q.multiSelect))" class="mt-2 flex gap-2 pl-4 text-[13px]">
      <button class="border px-2" :class="ready ? 'border-sky/60 text-sky hover:bg-sky/12' : 'border-hair text-paper-faint'" @click="submitAnswers">
        answer ↵
      </button>
      <button class="border-hair-strong text-paper-dim hover:text-stop border px-2" @click="decide(item, 'deny')">skip esc</button>
    </div>
  </div>

  <div v-else-if="item.kind === 'bang'" class="py-px">
    <button class="group flex w-full min-w-0 items-baseline gap-2 text-left" @click="toggle">
      <span class="shrink-0" :class="item.error ? 'text-stop' : item.out == null ? 'dos-blink text-warn' : 'text-warn'">!</span>
      <span class="text-paper-dim truncate">{{ item.text }}</span>
      <span v-if="item.out != null" class="text-paper-faint tnum ml-auto shrink-0 pl-3 text-[12px]">
        {{ toolMs(item.ms) }} · {{ outLines }} lines {{ open ? "▲" : "▼" }}
      </span>
    </button>
    <pre
      v-if="item.out && open"
      class="border-hair-strong my-1 ml-5 max-h-80 overflow-auto border-l py-0.5 pl-3 text-[13px] leading-[1.25] whitespace-pre-wrap select-text"
      :class="item.error ? 'text-stop/90' : 'text-paper-mute'"
      v-html="outHtml"
    />
  </div>

  <div v-else-if="item.kind === 'err'" class="text-stop py-1 whitespace-pre-wrap select-text">error: {{ item.text }}</div>

  <div
    v-else-if="item.kind === 'perm' && item.permission"
    class="my-2 border border-dashed px-3 py-2"
    :class="item.permission.state === 'pending' ? 'border-warn/60' : 'border-hair-strong'"
  >
    <div class="flex items-baseline gap-2">
      <span class="shrink-0" :class="item.permission.state === 'pending' ? 'dos-blink text-warn' : 'text-paper-faint'">?</span>
      <span class="text-paper shrink-0 whitespace-nowrap">Claude wants to {{ TOOL_VERB[item.text] ?? "use" }}</span>
      <span v-if="item.text !== 'ExitPlanMode'" class="text-paper-mute min-w-0 truncate">{{ TOOL_VERB[item.text] ? "" : item.text }} {{ item.meta }}</span>
    </div>
    <div v-if="item.text === 'ExitPlanMode' && planHtml" class="border-hair-strong text-paper-dim mt-2 border-l pl-3" v-html="planHtml" />
    <div v-if="item.permission.state === 'pending'" class="mt-2 flex gap-2 text-[13px]">
      <button class="border-amber/50 text-amber hover:bg-amber/12 border px-2" @click="decide(item, 'allow')">
        {{ item.text === "ExitPlanMode" ? "approve plan" : "allow" }} ↵
      </button>
      <button v-if="item.text !== 'ExitPlanMode'" class="border-hair-strong text-paper-dim hover:bg-ink-3 border px-2" @click="decide(item, 'always')">
        always ⇥
      </button>
      <button class="border-hair-strong text-paper-dim hover:border-stop/60 hover:text-stop border px-2" @click="decide(item, 'deny')">
        {{ item.text === "ExitPlanMode" ? "keep planning" : "deny" }} esc
      </button>
    </div>
    <div v-else class="text-paper-faint mt-1 text-[12px]">{{ STATE_LABEL[item.permission.state] }}</div>
  </div>

  <div v-else class="py-px">
    <button class="group flex w-full min-w-0 items-baseline gap-2 text-left" :class="item.out == null && !item.diff && 'cursor-default'" @click="toggle">
      <span class="shrink-0" :class="item.error ? 'text-stop' : item.out == null ? 'dos-blink text-amber' : 'text-sky'">■</span>
      <span class="text-paper-mute shrink-0">{{ item.text }}</span>
      <span class="text-paper-faint group-hover:text-paper-mute truncate"><template v-if="item.text === 'Bash'">$ </template>{{ item.meta }}</span>
      <span v-if="item.children?.length && !item.diff" class="text-paper-faint tnum ml-auto shrink-0 pl-3 text-[12px]">
        <template v-if="item.out == null && item.progress">{{ item.progress }} · </template>{{ item.children.length }} steps {{ open ? "▲" : "▼" }}
      </span>
      <span v-if="item.diff" class="tnum ml-auto shrink-0 pl-3 text-[12px]">
        <span class="text-amber">+{{ diffStat.add }}</span> <span class="text-stop">-{{ diffStat.del }}</span>
        <span class="text-paper-faint"> {{ open ? "▲" : "▼" }}</span>
      </span>
      <span v-else-if="item.out != null && !item.children?.length" class="text-paper-faint tnum ml-auto shrink-0 pl-3 text-[12px]">
        <template v-if="item.ms != null">{{ toolMs(item.ms) }} · </template>{{ outLines }} lines {{ open ? "▲" : "▼" }}
      </span>
    </button>
    <div v-if="item.children?.length && open" class="border-hair-strong my-1 ml-5 border-l py-0.5 pl-3 text-[13px] leading-[1.35]">
      <div v-for="(ch, i) in item.children" :key="i" class="flex min-w-0 gap-2">
        <span class="text-paper-faint shrink-0">↳ {{ ch.name }}</span>
        <span class="text-paper-faint/80 truncate">{{ ch.detail }}</span>
      </div>
    </div>
    <pre v-if="item.diff && open" class="border-hair-strong my-1 ml-5 max-h-96 overflow-auto border-l py-0.5 text-[13px] leading-[1.35] select-text"><div
        v-for="(d, i) in diffLines"
        :key="i"
        class="pl-3 whitespace-pre-wrap"
        :class="d.cls"
      >{{ d.text }}</div></pre>
    <pre
      v-else-if="item.out && open"
      class="border-hair-strong my-1 ml-5 max-h-80 overflow-auto border-l py-0.5 pl-3 text-[13px] leading-[1.25] whitespace-pre-wrap select-text"
      :class="item.error ? 'text-stop/90' : 'text-paper-mute'"
      v-html="outHtml"
    />
  </div>
</template>
