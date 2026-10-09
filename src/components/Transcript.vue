<script setup lang="ts">
import { computed } from "vue";
import { untilde, useCockpit } from "@/composables/useCockpit";
import { useAutoScroll } from "@/composables/useAutoScroll";
import LogItem from "./LogItem.vue";
import type { LogLine } from "@/lib/types";

const { chat, repo, currentLog, busy, info } = useCockpit();
const { onScroll } = useAutoScroll(
  () => [currentLog.value.length, currentLog.value.at(-1)?.text.length],
  () => chat.value?.key,
);

function onClick(e: MouseEvent) {
  const file = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
  if (file) {
    e.preventDefault();
    import("@tauri-apps/plugin-opener").then(({ openPath }) => openPath(untilde(file.dataset.path!))).catch(() => {});
    return;
  }
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-href]");
  if (!a) return;
  e.preventDefault();
  import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(a.dataset.href!)).catch(() => window.open(a.dataset.href, "_blank"));
}

const lastLogin = new Date()
  .toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  .replace(/,/g, "");

type Turn = { id: number; user?: LogLine; lines: LogLine[]; stats?: LogLine; done?: boolean };

const turns = computed(() => {
  const out: Turn[] = [];
  for (const l of currentLog.value) {
    const last = out.at(-1);
    if (l.kind === "user") out.push({ id: l.id, user: l, lines: [], done: true });
    else if (l.kind === "stats") {
      if (last && !last.user && !last.done) Object.assign(last, { stats: l, done: true });
      else out.push({ id: l.id, lines: [], stats: l, done: true });
    } else if (last && !last.user && !last.done) last.lines.push(l);
    else out.push({ id: l.id, lines: [l] });
  }
  return out;
});

const last = computed(() => currentLog.value.at(-1));
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const HINTS = [
  ["/resume", "pick up a past session"],
  ["/model", "switch model"],
  ["/usage", "plan limits"],
  ["⌘K", "jump to a chat or add a Jira key"],
  ["^C", "back to the terminal"],
];
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <div v-if="!currentLog.length" class="absolute inset-0 grid place-items-center px-5 text-[13px] leading-[1.45]">
      <div>
        <div class="text-paper">
          Claude Code <span class="text-paper-faint">{{ info.version }}</span>
        </div>
        <div class="text-paper-mute mt-4">
          &nbsp;* Project:&nbsp;&nbsp;<span class="text-sky">{{ repo?.path }}</span>
        </div>
        <div v-for="[k, v] in HINTS" :key="k" class="text-paper-mute">
          &nbsp;* <span class="text-amber inline-block w-20">{{ k }}</span
          >{{ v }}
        </div>
        <div class="text-paper-faint mt-4">Last login: {{ lastLogin }} on ttys001</div>
      </div>
    </div>

    <div v-else ref="scroller" class="h-full overflow-x-hidden overflow-y-auto px-5 pt-4 pb-6" @scroll.passive="onScroll" @click="onClick">
      <div v-for="turn in turns" :key="turn.id" class="text-[14px] leading-[1.35]">
        <div v-if="turn.user" class="flex justify-end pt-6 pb-2">
          <div class="tui-box text-paper relative max-w-[70%] min-w-48 px-4 pt-3.5 pb-3 [overflow-wrap:anywhere] whitespace-pre-wrap select-text">
            <span class="tui-title text-paper-faint tnum right-3">┤ {{ clock(turn.user.at) }} ├</span>
            <div v-if="turn.user.images?.length" class="mb-2 flex flex-wrap gap-2">
              <img v-for="(src, i) in turn.user.images" :key="i" :src="src" class="border-hair-strong block h-24 w-auto border" />
            </div>
            {{ turn.user.text }}
          </div>
        </div>

        <div v-else class="pt-6 pb-2">
          <div class="tui-box-agent relative w-fit max-w-[85%] min-w-48 px-4 pt-3.5 pb-3.5 [overflow-wrap:anywhere]">
            <span class="tui-title text-paper-faint tnum left-3">┤ {{ clock((turn.lines[0] ?? turn.stats)!.at) }} ├</span>
            <span v-if="turn.stats" class="tui-title tui-bottom tnum right-3" :class="turn.stats.error ? 'text-stop' : 'text-paper-faint'"
              >┤ {{ turn.stats.text }} ├</span
            >

            <LogItem v-for="item in turn.lines" :key="item.id" :item="item" :streaming="busy && item === last" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
