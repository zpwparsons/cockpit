<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Gauge, MessageSquare, Plus, Ticket } from "@lucide/vue";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { useCockpit } from "@/composables/useCockpit";

const open = defineModel<boolean>("open", { required: true });
const { chats, repos, isProjectChat, selectChat, addTicket, showUsage, runs, pendingPermission } = useCockpit();

const query = ref("");
const newKey = computed(() => query.value.toUpperCase().match(/([A-Z][A-Z0-9]+-\d+)/)?.[1]);
watch(open, (o) => o || (query.value = ""));

const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;

function run(fn: () => unknown) {
  open.value = false;
  fn();
}
</script>

<template>
  <CommandDialog v-model:open="open">
    <CommandInput placeholder="Jump to a chat, paste a Jira key, or run an action…" @input="query = ($event.target as HTMLInputElement).value" />
    <CommandList class="max-h-[360px]">
      <CommandEmpty class="text-paper-faint py-8 text-center text-[12px]">Nothing found.</CommandEmpty>
      <CommandGroup v-if="newKey && !chats.some((c) => c.key === newKey)" heading="Jira">
        <CommandItem :value="query" @select="run(() => addTicket(query))">
          <Plus />
          Add <span class="text-amber text-[12px]">{{ newKey }}</span>
          <span class="hidden">{{ query }}</span>
        </CommandItem>
      </CommandGroup>
      <CommandGroup heading="Chats">
        <CommandItem v-for="c in chats" :key="c.key" :value="`${c.key} ${c.title} ${repoName(c.repo)}`" @select="run(() => selectChat(c.key))">
          <component :is="isProjectChat(c) ? MessageSquare : Ticket" />
          <span class="text-[12px]" :class="isProjectChat(c) ? 'text-paper' : 'text-amber'">{{ isProjectChat(c) ? c.title : c.key }}</span>
          <span class="text-paper-faint truncate">{{ isProjectChat(c) ? "project chat" : repoName(c.repo) }}</span>
          <span v-if="pendingPermission(c.key)" class="dos-blink text-warn ml-auto">needs you</span>
          <span v-else-if="runs[c.key]" class="dos-blink text-amber ml-auto">working</span>
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Actions">
        <CommandItem value="Plan usage limits" @select="run(showUsage)"><Gauge /> Plan usage</CommandItem>
      </CommandGroup>
    </CommandList>
  </CommandDialog>
</template>
