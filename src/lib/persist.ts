import { watch, type WatchSource } from "vue";

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function persist<T>(key: string, source: WatchSource<T> | object) {
  watch(
    source as WatchSource<T>,
    (v) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {}
    },
    { deep: true },
  );
}
