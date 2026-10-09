<script setup lang="ts">
import { Plus, X } from "@lucide/vue";
import { useCockpit, type Tab } from "@/composables/useCockpit";

const { tabs, activeId, newTab, closeTab, tabBusy } = useCockpit();

const dir = (t: Tab) => (t.cwd === "~" ? "~" : (t.cwd.split("/").filter(Boolean).pop() ?? t.cwd));
const ticket = (t: Tab) => (t.chat && !t.chat.startsWith("#") ? t.chat : "");
</script>

<template>
  <header data-tauri-drag-region class="border-hair-strong relative z-10 flex h-11 shrink-0 items-center gap-1 border-b pr-3 pl-[88px]">
    <button
      v-for="t in tabs"
      :key="t.id"
      class="group relative flex h-7 max-w-56 min-w-0 items-center gap-2 border px-2.5 text-[13px] transition-colors"
      :class="t.id === activeId ? 'border-hair-strong bg-ink-2 text-paper' : 'text-paper-faint hover:bg-ink-2/60 hover:text-paper-mute border-transparent'"
      :title="t.cwd"
      @click="activeId = t.id"
    >
      <span class="shrink-0" :class="t.mode === 'claude' ? 'text-amber' : 'text-paper-faint'">{{ t.mode === "claude" ? "✻" : "$" }}</span>
      <span class="truncate">{{ dir(t) }}</span>
      <span v-if="ticket(t)" class="text-amber truncate">{{ ticket(t) }}</span>
      <span v-if="tabBusy(t)" class="dos-blink text-amber shrink-0">●</span>
      <X class="text-paper-faint hover:text-stop size-3 shrink-0 opacity-0 group-hover:opacity-100" @click.stop="closeTab(t.id)" />
    </button>
    <button class="text-paper-faint hover:text-paper grid size-6 place-items-center transition-colors" title="New tab (⌘T)" @click="newTab()">
      <Plus class="size-3.5" />
    </button>
    <div data-tauri-drag-region class="h-full flex-1" />
  </header>
</template>
