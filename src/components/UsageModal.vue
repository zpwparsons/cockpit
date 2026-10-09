<script setup lang="ts">
import { computed } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import UsageCard from "./UsageCard.vue";
import { useCockpit } from "@/composables/useCockpit";

const { usageOpen, rate, rateLoading, chat } = useCockpit();

const usage = computed(() => ({
  cost: chat.value?.cost ?? 0,
  fiveHour: rate.value?.fiveHour,
  sevenDay: rate.value?.sevenDay,
}));
</script>

<template>
  <Dialog v-model:open="usageOpen">
    <DialogContent :show-close-button="false" class="border-hair-strong bg-ink-2 max-w-[440px]! gap-0 px-6 py-5 shadow-2xl shadow-black/60">
      <DialogTitle class="sr-only">Plan usage</DialogTitle>
      <DialogDescription class="sr-only">Claude plan limits and session cost</DialogDescription>
      <UsageCard :usage="usage" :loading="rateLoading" />
      <div class="text-paper-faint mt-4 text-right text-[12px]">esc to close</div>
    </DialogContent>
  </Dialog>
</template>
