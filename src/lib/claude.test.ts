import { beforeEach, describe, expect, it } from "vitest";
import { Parser, respond, send, sendMore, stop, transcript, type ClaudeEvent } from "./claude";
import { emit, invokeLog, invokeResponses, resetTauri } from "@/test/setup";

const line = (o: unknown) => JSON.stringify(o);

describe("Parser", () => {
  let p: Parser;
  beforeEach(() => (p = new Parser()));

  it("ignores junk and events from sub-agents' own text", () => {
    expect(p.parse("not json")).toEqual([]);
    expect(p.parse(line({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "sub" }] } }))).toEqual([]);
  });

  it("reports sub-agent tool use under its parent", () => {
    const [e] = p.parse(
      line({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
    );
    expect(e).toEqual({ kind: "sub", parent: "t1", name: "Bash", detail: "ls" });
  });

  it("parses the init event and drops terminal-only commands", () => {
    const [e] = p.parse(
      line({
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "claude-opus-5-5",
        claude_code_version: "2.1",
        slash_commands: ["model", "doctor", "zero-quote"],
        terminal_slash_commands: ["doctor"],
      }),
    );
    expect(e).toEqual({ kind: "session", id: "s1", model: "claude-opus-5-5", version: "2.1", commands: ["model", "zero-quote"] });
  });

  it("parses thinking and task progress", () => {
    expect(p.parse(line({ type: "system", subtype: "thinking_tokens", estimated_tokens: 42 }))).toEqual([{ kind: "thinking", tokens: 42 }]);
    expect(p.parse(line({ type: "system", subtype: "task_progress", tool_use_id: "t1", description: "Running tests" }))).toEqual([
      { kind: "subProgress", parent: "t1", text: "Running tests" },
    ]);
    expect(p.parse(line({ type: "system", subtype: "hook_started" }))).toEqual([]);
  });

  it("tracks tokens across messages in one turn", () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 };
    expect(p.parse(line({ type: "stream_event", event: { type: "message_start", message: { usage } } }))).toEqual([{ kind: "tokens", output: 0, context: 60 }]);
    expect(p.parse(line({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 5 } } }))).toEqual([
      { kind: "tokens", output: 5, context: 60 },
    ]);
    expect(p.parse(line({ type: "stream_event", event: { type: "message_start", message: {} } }))).toEqual([{ kind: "tokens", output: 5, context: 60 }]);
    expect(p.parse(line({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 7 } } }))).toEqual([
      { kind: "tokens", output: 12, context: 60 },
    ]);
  });

  it("streams text deltas", () => {
    expect(p.parse(line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } }))).toEqual([
      { kind: "delta", text: "he" },
    ]);
    expect(p.parse(line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta" } } }))).toEqual([]);
  });

  it("parses assistant text and tools with diffs", () => {
    const events = p.parse(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "  hi " },
            { type: "text", text: " " },
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/Users/test/a.ts", old_string: "a", new_string: "b" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(events[0]).toEqual({ kind: "text", text: "hi" });
    expect(events[1]).toMatchObject({ kind: "tool", id: "t1", name: "Edit", detail: "~/a.ts", diff: [{ old: "a", new: "b" }] });
    expect(events[2]).toMatchObject({ kind: "tool", id: "t2", name: "Bash", detail: "ls", diff: undefined });
    expect(events).toHaveLength(3);
  });

  it("parses tool results and caps their size", () => {
    const big = "x".repeat(60_000);
    const [e] = p.parse(
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: big }], is_error: true }] } }),
    );
    expect(e).toMatchObject({ kind: "toolResult", id: "t1", isError: true });
    expect((e as { output: string }).output).toHaveLength(50_000);
    expect(p.parse(line({ type: "user", message: { content: "plain" } }))).toEqual([]);
  });

  it("parses permission requests, rate limits and results", () => {
    const [perm] = p.parse(
      line({
        type: "control_request",
        request_id: "r1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm x" }, permission_suggestions: [1] },
      }),
    );
    expect(perm).toEqual({ kind: "permission", request: { requestId: "r1", tool: "Bash", input: { command: "rm x" }, detail: "rm x", suggestions: [1] } });
    expect(p.parse(line({ type: "control_request", request: { subtype: "other" } }))).toEqual([]);

    const [rate] = p.parse(line({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1 } } } }));
    expect(rate).toEqual({ kind: "rate", fiveHour: { utilization: 0.2, resetsAt: 1 }, sevenDay: undefined });

    const events = p.parse(line({ type: "result", total_cost_usd: 0.5, duration_ms: 1200, usage: { output_tokens: 9 }, is_error: true, result: "boom" }));
    expect(events).toEqual([
      { kind: "result", cost: 0.5, ms: 1200, output: 9 },
      { kind: "error", text: "boom" },
    ]);
  });
});

describe("send / respond / stop", () => {
  beforeEach(resetTauri);

  it("spawns claude with the right flags and closes stdin only after every turn", async () => {
    const seen: ClaudeEvent[] = [];
    let done = 0;
    await send(
      "run1",
      "~/p",
      [{ type: "text", text: "hi" }],
      { session: "s1", model: "opus", effort: "high", mode: "plan" },
      { onEvent: (e) => seen.push(e), onDone: () => done++ },
    );
    expect(invokeLog[0]).toEqual({
      cmd: "claude_send",
      args: {
        run: "run1",
        cwd: "~/p",
        args: ["--resume", "s1", "--model", "opus", "--effort", "high", "--permission-mode", "plan"],
        message: line({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      },
    });

    await sendMore("run1", [{ type: "text", text: "more" }]);
    expect(invokeLog[1].cmd).toBe("claude_write");

    emit("claude://line", { run: "run1", line: line({ type: "result", total_cost_usd: 0 }) });
    expect(invokeLog.some((i) => i.cmd === "claude_close")).toBe(false);
    emit("claude://line", { run: "run1", line: line({ type: "result", total_cost_usd: 0 }) });
    expect(invokeLog.some((i) => i.cmd === "claude_close")).toBe(true);
    expect(seen.filter((e) => e.kind === "result")).toHaveLength(2);

    emit("claude://done", { run: "run1", code: 1, stderr: "a\nb\nc\nd" });
    expect(seen.at(-1)).toEqual({ kind: "error", text: "b\nc\nd" });
    expect(done).toBe(1);
    await expect(sendMore("run1", [])).rejects.toThrow("not active");
  });

  it("reports a spawn failure as an error event", async () => {
    invokeResponses.claude_send = () => {
      throw new Error("no claude");
    };
    const seen: ClaudeEvent[] = [];
    let done = 0;
    await send("run2", "~", [], {}, { onEvent: (e) => seen.push(e), onDone: () => done++ });
    expect(seen).toEqual([{ kind: "error", text: "Error: no claude" }]);
    expect(done).toBe(1);
  });

  it("formats permission responses", async () => {
    const req = { requestId: "r1", tool: "Bash", input: { command: "x" }, detail: "x", suggestions: ["rule"] };
    await respond("run", req, "always");
    await respond("run", req, "deny");
    const [always, deny] = invokeLog.map((i) => JSON.parse(i.args.line as string).response);
    expect(always).toEqual({
      subtype: "success",
      request_id: "r1",
      response: { behavior: "allow", updatedInput: { command: "x" }, updatedPermissions: ["rule"] },
    });
    expect(deny.response).toEqual({ behavior: "deny", message: "The user declined this action." });
    stop("run");
    expect(invokeLog.at(-1)).toEqual({ cmd: "claude_stop", args: { run: "run" } });
  });

  it("fetches transcripts through the backend", async () => {
    invokeResponses.claude_transcript = () => [{ kind: "user", text: "hi" }];
    expect(await transcript("~/p", "id")).toEqual([{ kind: "user", text: "hi" }]);
  });
});
