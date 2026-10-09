<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue";
import { useCockpit } from "@/composables/useCockpit";
import { useAutoScroll } from "@/composables/useAutoScroll";
import CommandBlock from "./CommandBlock.vue";
import type { LogLine } from "@/lib/types";

const { tab, currentLog, altScreen, setTermSize } = useCockpit();
const pane = useTemplateRef<HTMLElement>("pane");
let observer: ResizeObserver | undefined;

function measure() {
  const el = pane.value;
  if (!el) return;
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;font:14px 'Departure Mono';white-space:pre";
  el.appendChild(probe);
  const cell = probe.getBoundingClientRect().width / 100;
  probe.remove();
  setTermSize(Math.max(20, Math.floor((el.clientWidth - 48) / cell)), Math.max(8, Math.floor(el.clientHeight / 19.6)));
}

onMounted(() => {
  (document.fonts?.ready ?? Promise.resolve()).then(measure);
  observer = new ResizeObserver(measure);
  observer.observe(pane.value!);
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => altScreen[tab.value.id],
  (on) => !on && measure(),
);
const { onScroll } = useAutoScroll(
  () => [currentLog.value.length, currentLog.value.at(-1)?.text.length, currentLog.value.at(-1)?.html?.length],
  () => tab.value.id,
);

const blocks = computed(() => {
  const out: { id: number; cmd: LogLine; out?: LogLine; stats?: LogLine }[] = [];
  for (const l of currentLog.value) {
    if (l.kind === "user") out.push({ id: l.id, cmd: l });
    else if (out.length && l.kind === "out") out[out.length - 1].out = l;
    else if (out.length && l.kind === "stats") out[out.length - 1].stats = l;
  }
  return out;
});
</script>

<template>
  <div ref="pane" class="relative min-h-0 flex-1">
    <div ref="scroller" class="h-full overflow-x-hidden overflow-y-auto pt-2 text-[14px] leading-[1.4]" @scroll.passive="onScroll">
      <div class="flex min-h-full flex-col justify-end">
        <CommandBlock v-for="b in blocks" :key="b.id" :cmd="b.cmd" :out="b.out" :stats="b.stats" />
      </div>
    </div>
  </div>
</template>
