<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { useCockpit } from "@/composables/useCockpit";
import type { SessionInfo } from "@/lib/claude";

const { tab, chat, repo, listSessions, resume, closeResume } = useCockpit();
const search = useTemplateRef<HTMLInputElement>("search");
const sessions = ref<SessionInfo[] | null>(null);
const query = ref("");
const cursor = ref(0);

const shown = computed(() => {
  const q = query.value.toLowerCase();
  return (sessions.value ?? []).filter((s) => !q || s.title.toLowerCase().includes(q) || s.branch.toLowerCase().includes(q));
});
watch(query, () => (cursor.value = 0));

const ago = (ms: number) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? "" : "s"} ago`;
  const w = Math.round(d / 7);
  return `${w} week${w === 1 ? "" : "s"} ago`;
};
const size = (b: number) => (b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`);

async function pick(s: SessionInfo) {
  if (!chat.value) return;
  closeResume(tab.value);
  tab.value.mode = "claude";
  await resume(chat.value, s.id);
}

function onKey(e: KeyboardEvent) {
  const n = shown.value.length;
  if (e.key === "Escape") return (e.preventDefault(), closeResume(tab.value));
  if (!n) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cursor.value = (cursor.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    nextTick(() => document.getElementById(`session-${cursor.value}`)?.scrollIntoView({ block: "nearest" }));
  } else if (e.key === "Enter") {
    e.preventDefault();
    pick(shown.value[cursor.value]);
  }
}

onMounted(async () => {
  search.value?.focus();
  if (chat.value) sessions.value = await listSessions(chat.value);
});

defineExpose({ focus: () => search.value?.focus() });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col px-5 pt-4 pb-3 text-[14px] leading-[1.4]">
    <div class="text-amber">Resume session</div>
    <label class="border-hair-strong focus-within:border-paper-faint mt-3 flex items-center gap-2 border px-3 py-2">
      <span class="text-paper-faint">⌕</span>
      <input
        ref="search"
        v-model="query"
        placeholder="Search…"
        spellcheck="false"
        class="text-paper placeholder:text-paper-faint w-full bg-transparent focus:outline-none"
        @keydown="onKey"
      />
    </label>
    <div class="text-paper-mute mt-4 pl-6">{{ repo?.name }}</div>

    <div class="mt-3 min-h-0 flex-1 overflow-y-auto">
      <div v-if="sessions === null" class="text-paper-mute flex items-center gap-2 pl-6"><span class="live-dot" /> Looking for sessions…</div>
      <div v-else-if="!shown.length" class="text-paper-mute pl-6">{{ query ? "No matching sessions." : "No previous sessions in this folder." }}</div>
      <button v-for="(s, i) in shown" :id="`session-${i}`" :key="s.id" class="flex w-full gap-3 py-2 text-left" @mousemove="cursor = i" @click="pick(s)">
        <span class="text-amber w-3 shrink-0">{{ i === cursor ? "›" : "" }}</span>
        <span class="min-w-0">
          <span class="block truncate" :class="i === cursor ? 'text-amber' : 'text-paper'">{{ s.title }}</span>
          <span class="text-paper-faint block truncate text-[13px]">
            {{ ago(s.modified) }}<template v-if="s.branch"> · {{ s.branch }}</template> · {{ size(s.size) }}
          </span>
        </span>
      </button>
    </div>

    <div class="text-paper-faint mt-3 text-[13px]">↑↓ to choose · ↵ to resume · type to search · esc to cancel</div>
  </div>
</template>
