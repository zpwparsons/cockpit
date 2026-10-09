import { vi } from "vitest";

export type Listener = (event: { payload: unknown }) => void;
export const listeners = new Map<string, Listener[]>();
export const invokeLog: { cmd: string; args: Record<string, unknown> }[] = [];
export const invokeResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

export function resetListeners() {
  listeners.clear();
}

export function emit(name: string, payload: unknown) {
  for (const l of listeners.get(name) ?? []) l({ payload });
}

export function resetTauri() {
  invokeLog.length = 0;
  for (const k of Object.keys(invokeResponses)) delete invokeResponses[k];
}

(window as any).__TAURI_INTERNALS__ = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    invokeLog.push({ cmd, args });
    const handler = invokeResponses[cmd];
    if (handler) return handler(args);
    const defaults: Record<string, unknown> = {
      logs_load_all: {},
      shell_commands: ["ls", "git", "cd", "echo"],
      shell_history: [],
      complete_path: [],
      list_files: [],
      git_info: null,
      read_settings: [],
      claude_probe: "",
      claude_sessions: [],
      claude_transcript: [],
      run_command: { output: "", code: 0 },
    };
    return defaults[cmd];
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/test/" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
if (!("ResizeObserver" in window))
  (window as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
