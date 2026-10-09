<script setup lang="ts">
import { computed } from "vue";
import type { RateWindow } from "@/lib/types";

const props = defineProps<{ usage: { cost: number; fiveHour?: RateWindow; sevenDay?: RateWindow }; loading?: boolean }>();

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();

function resets(at: number, withDay: boolean) {
  const d = new Date(at * 1000);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return withDay ? `${day} at ${time(d)}` : time(d);
}

const rows = computed(() =>
  [
    { label: "Current session", sub: "5-hour window", w: props.usage.fiveHour, day: false },
    { label: "Current week", sub: "all models", w: props.usage.sevenDay, day: true },
  ].filter((r) => r.w),
);

const pct = (u: number) => Math.min(100, Math.round(u * 100));
const CELLS = 36;
const bar = (u: number) => {
  const n = Math.round(Math.min(1, u) * CELLS);
  return { used: "█".repeat(n), free: "░".repeat(CELLS - n) };
};
</script>

<template>
  <div>
    <div class="flex items-baseline justify-between">
      <span class="hud-label">Plan usage</span>
      <span class="text-paper-faint flex items-center gap-2 text-[12px]"><span v-if="loading && rows.length" class="live-dot" />{{ tz }}</span>
    </div>

    <div v-if="!rows.length" class="text-paper-mute mt-4 flex items-center gap-2 text-[13px]">
      <span v-if="loading" class="live-dot" />
      {{ loading ? "Checking your plan limits…" : "Couldn't load plan limits." }}
    </div>

    <div v-for="r in rows" :key="r.label" class="mt-4">
      <div class="flex items-baseline gap-2">
        <span class="text-paper text-[13px]">{{ r.label }}</span>
        <span class="text-paper-faint text-[13px]">{{ r.sub }}</span>
        <span class="tnum ml-auto text-[13px]" :class="pct(r.w!.utilization) >= 90 ? 'text-stop' : 'text-paper'"> {{ pct(r.w!.utilization) }}% </span>
      </div>
      <div class="mt-1 text-[14px] leading-none tracking-[-0.02em] whitespace-pre">
        <span :class="pct(r.w!.utilization) >= 90 ? 'text-stop' : 'text-amber'">{{ bar(r.w!.utilization).used }}</span
        ><span class="text-hair-strong">{{ bar(r.w!.utilization).free }}</span>
      </div>
      <div class="text-paper-faint mt-1.5 text-[12px]">Resets {{ resets(r.w!.resetsAt, r.day) }}</div>
    </div>

    <div class="border-hair mt-4 flex items-baseline justify-between border-t pt-3">
      <span class="text-paper-mute text-[13px]">This chat's session</span>
      <span class="text-paper tnum text-[13px]">${{ usage.cost.toFixed(2) }}</span>
    </div>
  </div>
</template>
