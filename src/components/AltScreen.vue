<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useCockpit } from "@/composables/useCockpit";
import { THEME } from "@/lib/blockterm";

const props = defineProps<{ tabId: string }>();
const { altSinks, drainAlt, writeRaw, setTermSize, tabs } = useCockpit();
const host = useTemplateRef<HTMLElement>("host");

const term = new Terminal({
  fontFamily: '"Departure Mono", ui-monospace, monospace',
  fontSize: 14,
  cursorBlink: true,
  cursorStyle: "block",
  theme: { ...THEME, background: "#0b121f", cursor: "#84cc16", cursorAccent: "#0b121f", selectionBackground: "rgba(132,204,22,0.28)" },
});
const fit = new FitAddon();
term.loadAddon(fit);
let observer: ResizeObserver | undefined;

onMounted(() => {
  term.open(host.value!);
  fit.fit();
  setTermSize(term.cols, term.rows);
  term.write(drainAlt(props.tabId));
  altSinks.set(props.tabId, (data) => term.write(data));
  term.onData((data) => {
    const t = tabs.find((x) => x.id === props.tabId);
    if (t) writeRaw(t, data);
  });
  observer = new ResizeObserver(() => {
    if (!host.value?.clientWidth) return;
    fit.fit();
    setTermSize(term.cols, term.rows);
    term.focus();
  });
  observer.observe(host.value!);
  term.focus();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (altSinks.get(props.tabId)) altSinks.delete(props.tabId);
  term.dispose();
});
</script>

<template>
  <div ref="host" class="bg-ink-0 absolute inset-0 z-20 px-3 py-2" />
</template>
