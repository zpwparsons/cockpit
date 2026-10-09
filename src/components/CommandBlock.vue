<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import { useCockpit } from "@/composables/useCockpit";
import { highlight } from "@/lib/highlight";
import type { LogLine } from "@/lib/types";

const props = defineProps<{ cmd: LogLine; out?: LogLine; stats?: LogLine }>();
const { knownCommands } = useCockpit();

const cwd = computed(() => (props.cmd.meta ?? "").split("\u0000")[0]);
const segments = computed(() => highlight(props.cmd.text, knownCommands.value));
const output = useTemplateRef<HTMLElement>("output");
const copied = ref("");

async function copy(what: "command" | "output") {
  const text = what === "command" ? props.cmd.text : (output.value?.innerText ?? props.out?.text ?? "").trimEnd();
  await navigator.clipboard.writeText(text).catch(() => {});
  copied.value = what;
  setTimeout(() => (copied.value = ""), 1200);
}
</script>

<template>
  <div
    class="group border-b-hair first:border-t-hair border-b border-l-2 px-5 py-2.5 first:border-t last:border-b-0"
    :class="stats?.error ? 'border-l-stop/70' : 'border-l-transparent'"
  >
    <div class="flex items-baseline gap-3 text-[12px]">
      <span class="text-sky">{{ cwd }}</span>
      <span class="ml-auto flex gap-3 opacity-0 transition-opacity group-hover:opacity-100">
        <button class="text-paper-faint hover:text-amber" @click="copy('command')">{{ copied === "command" ? "copied" : "copy command" }}</button>
        <button v-if="out?.html || out?.text" class="text-paper-faint hover:text-amber" @click="copy('output')">
          {{ copied === "output" ? "copied" : "copy output" }}
        </button>
      </span>
      <span v-if="stats" class="tnum" :class="stats.error ? 'text-stop' : 'text-paper-faint'">{{ stats.text }}</span>
      <span v-else class="dos-blink text-amber">●</span>
    </div>
    <div class="whitespace-pre-wrap select-text">
      <span v-for="(s, i) in segments" :key="i" :class="s.cls">{{ s.text }}</span>
    </div>
    <pre v-if="out?.html" ref="output" class="term-out text-paper-dim mt-1 text-[14px] leading-[1.4] whitespace-pre select-text" v-html="out.html" />
    <pre v-else-if="out?.text" class="text-stop mt-1 text-[14px] leading-[1.4] whitespace-pre-wrap select-text">{{ out.text }}</pre>
  </div>
</template>
