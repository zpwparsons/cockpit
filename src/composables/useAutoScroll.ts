import { nextTick, useTemplateRef, watch, type WatchSource } from "vue";

export function useAutoScroll(content: WatchSource, reset: WatchSource) {
  const scroller = useTemplateRef<HTMLElement>("scroller");
  let pinned = true;

  function onScroll() {
    const el = scroller.value;
    if (el) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function bottom(force = false) {
    if (!force && !pinned) return;
    nextTick(() => {
      const el = scroller.value;
      if (el) el.scrollTop = el.scrollHeight;
      pinned = true;
    });
  }

  watch(content, () => bottom());
  watch(reset, () => bottom(true), { immediate: true });

  return { onScroll };
}
