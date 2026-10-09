import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Diff, RateWindow } from "./types";

let homeDir = "";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

if (isTauri)
  import("@tauri-apps/api/path")
    .then(({ homeDir: get }) => get())
    .then((h) => (homeDir = h.replace(/\/$/, "")))
    .catch(() => {});

export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  detail: string;
  suggestions: unknown[];
}

export type ClaudeEvent =
  | { kind: "session"; id: string; model: string; version: string; commands: string[] }
  | { kind: "delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; detail: string; diff?: Diff[]; input: Record<string, unknown> }
  | { kind: "sub"; parent: string; name: string; detail: string }
  | { kind: "subProgress"; parent: string; text: string }
  | { kind: "thinking"; tokens: number }
  | { kind: "toolResult"; id: string; output: string; isError: boolean }
  | { kind: "tokens"; output: number; context: number }
  | { kind: "result"; cost: number; ms: number; output: number }
  | { kind: "rate"; fiveHour?: RateWindow; sevenDay?: RateWindow }
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "error"; text: string };

interface Handlers {
  onEvent: (e: ClaudeEvent) => void;
  onDone: () => void;
}

export class Parser {
  turnOutput = 0;
  msgOutput = 0;
  context = 0;

  parse(line: string): ClaudeEvent[] {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    if (msg.parent_tool_use_id) {
      if (msg.type !== "assistant") return [];
      return (msg.message?.content ?? [])
        .filter((b: any) => b.type === "tool_use")
        .map((b: any): ClaudeEvent => ({ kind: "sub", parent: msg.parent_tool_use_id, name: b.name, detail: toolDetail(b.input) }));
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "thinking_tokens") return [{ kind: "thinking", tokens: msg.estimated_tokens ?? 0 }];
        if (msg.subtype === "task_progress" && msg.tool_use_id) return [{ kind: "subProgress", parent: msg.tool_use_id, text: msg.description ?? "" }];
        if (msg.subtype !== "init") return [];
        return [
          {
            kind: "session",
            id: msg.session_id,
            model: msg.model,
            version: msg.claude_code_version ?? "",
            commands: (msg.slash_commands ?? []).filter((c: string) => !(msg.terminal_slash_commands ?? []).includes(c)),
          },
        ];
      case "stream_event": {
        const ev = msg.event;
        if (ev.type === "message_start") {
          this.turnOutput += this.msgOutput;
          this.msgOutput = 0;
          this.context = contextOf(ev.message?.usage) || this.context;
          return [{ kind: "tokens", output: this.turnOutput, context: this.context }];
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") return [{ kind: "delta", text: ev.delta.text }];
        if (ev.type === "message_delta" && ev.usage) {
          this.msgOutput = ev.usage.output_tokens ?? this.msgOutput;
          return [{ kind: "tokens", output: this.turnOutput + this.msgOutput, context: this.context }];
        }
        return [];
      }
      case "assistant":
        return (msg.message?.content ?? []).flatMap((b: any): ClaudeEvent[] => {
          if (b.type === "text" && b.text?.trim()) return [{ kind: "text", text: b.text.trim() }];
          if (b.type === "tool_use")
            return [{ kind: "tool", id: b.id, name: b.name, detail: toolDetail(b.input), diff: toolDiff(b.name, b.input), input: b.input ?? {} }];
          return [];
        });
      case "user":
        return (Array.isArray(msg.message?.content) ? msg.message.content : [])
          .filter((b: any) => b.type === "tool_result")
          .map((b: any): ClaudeEvent => ({ kind: "toolResult", id: b.tool_use_id, output: resultText(b.content), isError: !!b.is_error }));
      case "rate_limit_event": {
        const w = msg.rate_limit_info?.unifiedWindows ?? {};
        return [{ kind: "rate", fiveHour: w.five_hour, sevenDay: w.seven_day }];
      }
      case "control_request": {
        const r = msg.request ?? {};
        if (r.subtype !== "can_use_tool") return [];
        return [
          {
            kind: "permission",
            request: {
              requestId: msg.request_id,
              tool: r.tool_name,
              input: r.input ?? {},
              detail: toolDetail(r.input),
              suggestions: r.permission_suggestions ?? [],
            },
          },
        ];
      }
      case "result": {
        const out: ClaudeEvent[] = [{ kind: "result", cost: msg.total_cost_usd ?? 0, ms: msg.duration_ms ?? 0, output: msg.usage?.output_tokens ?? 0 }];
        if (msg.is_error) out.push({ kind: "error", text: String(msg.result ?? "Claude returned an error") });
        return out;
      }
    }
    return [];
  }
}

const runs = new Map<string, Handlers & { parser: Parser; turns: number }>();

if (isTauri) {
  listen<{ run: string; line: string }>("claude://line", ({ payload }) => {
    const h = runs.get(payload.run);
    if (!h) return;
    for (const e of h.parser.parse(payload.line)) {
      h.onEvent(e);
      if (e.kind === "result" && --h.turns <= 0) invoke("claude_close", { run: payload.run });
    }
  });
  listen<{ run: string; code: number | null; stderr: string }>("claude://done", ({ payload }) => {
    const h = runs.get(payload.run);
    if (!h) return;
    if (payload.code && payload.code !== 0 && payload.stderr.trim()) h.onEvent({ kind: "error", text: payload.stderr.trim().split("\n").slice(-3).join("\n") });
    runs.delete(payload.run);
    h.onDone();
  });
}

const home = (s: string) => (homeDir ? s.replaceAll(homeDir, "~") : s);

function toolDetail(input: Record<string, unknown> = {}) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.url ?? input.skill ?? input.description ?? "";
  return home(String(v));
}

function toolDiff(name: string, input: any = {}): Diff[] | undefined {
  if (name === "Edit") return [{ old: input.old_string ?? "", new: input.new_string ?? "" }];
  if (name === "MultiEdit") return (input.edits ?? []).map((e: any) => ({ old: e.old_string ?? "", new: e.new_string ?? "" }));
  if (name === "Write") return [{ old: "", new: input.content ?? "" }];
}

const MAX_TOOL_OUTPUT = 50_000;

function resultText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "";
  return text.slice(0, MAX_TOOL_OUTPUT);
}

const contextOf = (u: any) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

export type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface SendOptions {
  session?: string;
  model?: string;
  effort?: string;
  mode?: string;
}

export async function send(run: string, cwd: string, content: Block[], opts: SendOptions, h: Handlers) {
  runs.set(run, { ...h, parser: new Parser(), turns: 1 });
  const args: string[] = [];
  if (opts.session) args.push("--resume", opts.session);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.mode) args.push("--permission-mode", opts.mode);
  const message = JSON.stringify({ type: "user", message: { role: "user", content } });
  try {
    await invoke("claude_send", { run, cwd, args, message });
  } catch (e) {
    runs.delete(run);
    h.onEvent({ kind: "error", text: String(e) });
    h.onDone();
  }
}

export async function sendMore(run: string, content: Block[]) {
  const h = runs.get(run);
  if (!h) throw new Error("run is not active");
  h.turns++;
  try {
    await invoke("claude_write", { run, line: JSON.stringify({ type: "user", message: { role: "user", content } }) });
  } catch (e) {
    h.turns--;
    throw e;
  }
}

export type Decision = "allow" | "always" | "deny";

export function respond(run: string, req: PermissionRequest, decision: Decision, extra: Record<string, unknown> = {}) {
  const response =
    decision === "deny"
      ? { behavior: "deny", message: "The user declined this action." }
      : { behavior: "allow", updatedInput: req.input, ...(decision === "always" ? { updatedPermissions: req.suggestions } : {}), ...extra };
  const line = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: req.requestId, response } });
  return invoke("claude_write", { run, line });
}

export function setMode(run: string, mode: string) {
  const line = JSON.stringify({ type: "control_request", request_id: `mode-${Date.now()}`, request: { subtype: "set_permission_mode", mode } });
  return invoke("claude_write", { run, line });
}

export function oneshot(cwd: string, prompt: string) {
  return invoke<string>("claude_oneshot", { cwd, prompt });
}

export function stop(run: string) {
  if (isTauri) invoke("claude_stop", { run });
}

export async function probeRate(cwd: string) {
  const line = await invoke<string>("claude_probe", { cwd, rate: true });
  const ev = new Parser().parse(line)[0];
  return ev?.kind === "rate" ? ev : null;
}

export async function probe(cwd: string) {
  const line = await invoke<string>("claude_probe", { cwd, rate: false });
  const ev = new Parser().parse(line)[0];
  return ev?.kind === "session" ? ev : null;
}

export interface SessionInfo {
  id: string;
  modified: number;
  title: string;
  branch: string;
  size: number;
}

export function sessions(cwd: string) {
  return invoke<SessionInfo[]>("claude_sessions", { cwd });
}

export type TranscriptItem =
  | { kind: "user" | "text"; text: string }
  | { kind: "tool"; id: string; name: string; detail: string; diff?: Diff[] }
  | { kind: "toolResult"; id: string; output: string; isError: boolean };

export const BRIEF_RULES = "Keep answers short. Don't commit; I commit myself.\n\n";

export function transcript(cwd: string, id: string) {
  return invoke<TranscriptItem[]>("claude_transcript", { cwd, id });
}
