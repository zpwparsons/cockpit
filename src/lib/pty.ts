import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./claude";

export type PtyEvent =
  | { kind: "data"; data: string }
  | { kind: "cmd" }
  | { kind: "done"; code: number; cwd: string }
  | { kind: "alt"; on: boolean }
  | { kind: "exit" }
  | { kind: "compStart" }
  | { kind: "compSpan"; len: number }
  | { kind: "compMatch"; value: string; desc: string }
  | { kind: "compEnd" };

const handlers = new Map<string, (e: PtyEvent) => void>();

if (isTauri) listen<{ tab: string; event: PtyEvent }>("pty://event", ({ payload }) => handlers.get(payload.tab)?.(payload.event));

export function open(tab: string, cwd: string, cols: number, rows: number, onEvent: (e: PtyEvent) => void) {
  handlers.set(tab, onEvent);
  if (isTauri) return invoke("pty_open", { tab, cwd, cols, rows });
}

export function write(tab: string, data: string) {
  if (isTauri) invoke("pty_write", { tab, data }).catch(() => {});
}

export function resize(tab: string, cols: number, rows: number) {
  if (isTauri) invoke("pty_resize", { tab, cols, rows });
}

export function close(tab: string) {
  handlers.delete(tab);
  if (isTauri) invoke("pty_close", { tab });
}
