<script setup lang="ts">
import { defineAsyncComponent, ref } from "vue";
import { useEventListener } from "@vueuse/core";
import TitleBar from "@/components/TitleBar.vue";
import Transcript from "@/components/Transcript.vue";
import Terminal from "@/components/Terminal.vue";
import Composer from "@/components/Composer.vue";
import ResumeScreen from "@/components/ResumeScreen.vue";
import Palette from "@/components/Palette.vue";
import UsageModal from "@/components/UsageModal.vue";
const AltScreen = defineAsyncComponent(() => import("@/components/AltScreen.vue"));
import { useCockpit } from "@/composables/useCockpit";

const { tab, tabs, newTab, closeTab, selectTab, interruptTab, altScreen, clearShell, resumeScreen } = useCockpit();
const shiftTab = (dir: 1 | -1) => selectTab((tabs.indexOf(tab.value) + dir + tabs.length) % tabs.length);
const palette = ref(false);
const composer = ref<InstanceType<typeof Composer>>();

const INTERACTIVE = "button, a, input, textarea, select, [role=menu], [role=dialog], [data-href]";

useEventListener(window, "mouseup", (e: MouseEvent) => {
  if (e.button !== 0 || window.getSelection()?.toString() || altScreen[tab.value.id]) return;
  if ((e.target as HTMLElement).closest(INTERACTIVE) || document.querySelector("[role=dialog]")) return;
  if (!resumeScreen[tab.value.id]) composer.value?.focus();
});
useEventListener(window, "focus", () => !document.querySelector("[role=dialog]") && !altScreen[tab.value.id] && composer.value?.focus());

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  const k = e.key.toLowerCase();
  if (altScreen[tab.value.id] && !e.metaKey) return;
  if (e.ctrlKey && !e.metaKey && k === "c" && !window.getSelection()?.toString()) return (e.preventDefault(), interruptTab(tab.value));
  if (!e.metaKey) return;
  if (k === "k" && tab.value.mode === "shell") return (e.preventDefault(), clearShell(tab.value));
  if (k === "k") return (e.preventDefault(), (palette.value = !palette.value));
  if (k === "l") return (e.preventDefault(), composer.value?.focus());
  if (k === "t") return (e.preventDefault(), newTab(), composer.value?.focus());
  if (k === "w") return (e.preventDefault(), closeTab());
  if (/^[1-9]$/.test(k)) return (e.preventDefault(), selectTab(+k - 1));
  if (e.shiftKey && (e.key === "{" || e.key === "}" || e.code === "BracketLeft" || e.code === "BracketRight"))
    return (e.preventDefault(), shiftTab(e.key === "{" || e.code === "BracketLeft" ? -1 : 1));
});
</script>

<template>
  <div class="relative flex h-full flex-col">
    <TitleBar />
    <main class="relative flex min-h-0 flex-1 flex-col">
      <template v-for="t in tabs" :key="t.id">
        <AltScreen v-if="altScreen[t.id]" v-show="t.id === tab.id && t.mode === 'shell'" :tab-id="t.id" />
      </template>
      <ResumeScreen v-if="tab.mode === 'claude' && resumeScreen[tab.id]" :key="tab.id" />
      <template v-else>
        <Terminal v-if="tab.mode === 'shell'" />
        <Transcript v-else />
        <Composer ref="composer" />
      </template>
    </main>
  </div>
  <Palette v-model:open="palette" />
  <UsageModal />
</template>
