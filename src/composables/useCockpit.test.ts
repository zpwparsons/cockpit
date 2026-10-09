import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIEF_RULES } from "@/lib/claude";
import { emit, invokeLog, invokeResponses, resetListeners, resetTauri } from "@/test/setup";

type Store = typeof import("./useCockpit");
let mod: Store;
let s: ReturnType<Store["useCockpit"]>;

const calls = (cmd: string) => invokeLog.filter((i) => i.cmd === cmd);
const flush = () => new Promise((r) => setTimeout(r, 0));
const line = (o: unknown) => JSON.stringify(o);

async function load() {
  vi.resetModules();
  resetTauri();
  resetListeners();
  localStorage.clear();
  mod = await import("./useCockpit");
  s = mod.useCockpit();
  await flush();
}

function pty(event: unknown, tab = s.tab.value.id) {
  emit("pty://event", { tab, event });
}

function readyShell() {
  pty({ kind: "done", code: 0, cwd: "/Users/test/Code" });
}

async function startClaudeChat() {
  s.runCommand(s.tab.value, "claude");
  await flush();
  return s.chat.value!;
}

function claudeLine(payload: unknown) {
  const run = s.runs[s.chat.value!.key];
  emit("claude://line", { run: run.id, line: line(payload) });
}

function claudeDone() {
  const run = s.runs[s.chat.value!.key];
  emit("claude://done", { run: run.id, code: 0, stderr: "" });
}

beforeEach(load);
afterEach(() => vi.useRealTimers());

describe("tabs and shells", () => {
  it("starts with one terminal tab in ~/Code and opens its shell", () => {
    expect(s.tabs).toHaveLength(1);
    expect(s.tab.value).toMatchObject({ cwd: "~/Code", mode: "shell" });
    expect(calls("pty_open")[0].args).toMatchObject({ tab: s.tab.value.id, cwd: "~/Code" });
  });

  it("opens, switches and closes tabs", () => {
    const first = s.tab.value;
    s.newTab();
    expect(s.tabs).toHaveLength(2);
    expect(s.tab.value.id).not.toBe(first.id);
    expect(s.tab.value.cwd).toBe(first.cwd);
    s.selectTab(0);
    expect(s.tab.value.id).toBe(first.id);
    s.closeTab(first.id);
    expect(s.tabs).toHaveLength(1);
    expect(calls("pty_close")[0].args.tab).toBe(first.id);
    s.closeTab();
    expect(s.tabs).toHaveLength(1);
    expect(s.tab.value.cwd).toBe("~/Code");
  });

  it("queues a command until the shell is ready, then runs it as a block", async () => {
    s.runCommand(s.tab.value, "cd gradlinc");
    expect(calls("pty_write")).toHaveLength(0);
    expect(s.currentLog.value[0]).toMatchObject({ kind: "user", text: "cd gradlinc", meta: "~/Code" });
    expect(s.shellRuns[s.tab.value.id]).toBeTruthy();

    readyShell();
    await flush();
    expect(calls("pty_write")[0].args.data).toBe("\x1b[200~cd gradlinc\x1b[201~\r");

    pty({ kind: "cmd" });
    pty({ kind: "data", data: "hello\r\n" });
    pty({ kind: "done", code: 0, cwd: "/Users/test/Code/gradlinc" });
    await flush();
    await new Promise((r) => setTimeout(r, 120));
    expect(s.tab.value.cwd).toBe("~/Code/gradlinc");
    expect(s.shellRuns[s.tab.value.id]).toBeUndefined();
    expect(s.currentLog.value.map((l) => l.kind)).toEqual(["user", "out", "stats"]);
    expect(s.currentLog.value[1].html).toContain("hello");
    expect(s.currentLog.value[2]).toMatchObject({ text: expect.stringMatching(/^ok · /), error: false });
    expect(calls("git_info").at(-1)?.args.cwd).toBe("~/Code/gradlinc");
  });

  it("marks failed commands and ignores input while one runs", async () => {
    readyShell();
    s.runCommand(s.tab.value, "false");
    s.runCommand(s.tab.value, "ignored");
    expect(s.currentLog.value.filter((l) => l.kind === "user")).toHaveLength(1);
    pty({ kind: "cmd" });
    pty({ kind: "done", code: 1, cwd: "/Users/test/Code" });
    await flush();
    expect(s.currentLog.value.at(-1)).toMatchObject({ kind: "stats", error: true, text: expect.stringMatching(/^exit 1/) });
  });

  it("clears, interrupts and sends raw input", () => {
    readyShell();
    s.runCommand(s.tab.value, "sleep 9");
    s.interruptTab(s.tab.value);
    expect(calls("pty_write").at(-1)?.args.data).toBe("\x03");
    s.sendInput(s.tab.value, "yes");
    expect(calls("pty_write").at(-1)?.args.data).toBe("yes\r");
    s.clearShell(s.tab.value);
    expect(s.currentLog.value).toEqual([]);
  });

  it("buffers full-screen output until a sink attaches and resizes every tab", () => {
    pty({ kind: "alt", on: true });
    pty({ kind: "data", data: "vim screen" });
    expect(s.altScreen[s.tab.value.id]).toBe(true);
    expect(s.drainAlt(s.tab.value.id)).toBe("vim screen");
    expect(s.drainAlt(s.tab.value.id)).toBe("");
    pty({ kind: "alt", on: false });
    expect(s.altScreen[s.tab.value.id]).toBe(false);

    s.setTermSize(100, 30);
    expect(calls("pty_resize").at(-1)?.args).toMatchObject({ cols: 100, rows: 30 });
  });

  it("closes the tab when the shell exits", () => {
    const id = s.tab.value.id;
    s.newTab();
    pty({ kind: "exit" }, id);
    expect(s.tabs.some((t) => t.id === id)).toBe(false);
  });

  it("resolves zsh completions and times out when the shell is silent", async () => {
    readyShell();
    const p = s.zshComplete(s.tab.value, "git chec");
    expect(calls("pty_write").at(-1)?.args.data).toBe(
      `\x1b[200~__ck_complete ${[...new TextEncoder().encode("git chec")].map((b) => b.toString(16).padStart(2, "0")).join("")}\x1b[201~\r`,
    );
    pty({ kind: "compStart" });
    pty({ kind: "compSpan", len: 4 });
    pty({ kind: "compMatch", value: "checkout", desc: "switch" });
    pty({ kind: "compMatch", value: "checkout", desc: "dup" });
    pty({ kind: "compEnd" });
    expect(await p).toEqual({ span: 4, matches: [{ value: "checkout", desc: "switch" }] });

    vi.useFakeTimers();
    const slow = s.zshComplete(s.tab.value, "x");
    vi.advanceTimersByTime(2100);
    expect(await slow).toBeNull();
    vi.useRealTimers();
    s.newTab();
    expect(await s.zshComplete(s.tab.value, "x")).toBeNull();
  });
});

describe("entering claude", () => {
  it("switches the tab into a fresh chat for the folder", async () => {
    const c = await startClaudeChat();
    expect(s.tab.value.mode).toBe("claude");
    expect(c.key).toBe("#Code");
    expect(s.repos[0]).toMatchObject({ id: "Code", path: "~/Code" });
    expect(s.currentLog.value).toEqual([]);
    expect(calls("claude_probe")).toHaveLength(1);
  });

  it("honours cli flags and ignores unsupported ones", async () => {
    s.runCommand(s.tab.value, "claude --model opus --effort high --permission-mode plan --verbose fix the bug");
    await flush();
    expect(s.settings).toMatchObject({ model: "opus", effort: "high", mode: "plan" });
    expect(s.currentLog.value.find((l) => l.kind === "sys")?.text).toContain("--verbose");
    expect(s.currentLog.value.find((l) => l.kind === "user")?.text).toBe("fix the bug");
    expect(calls("claude_send")).toHaveLength(1);
  });

  it("starts in the defaultMode from claude settings", async () => {
    s.settings.mode = "plan";
    invokeResponses.read_settings = () => [
      ["~/.claude/settings.json", { permissions: { defaultMode: "acceptEdits" } }],
      ["~/Code/.claude/settings.local.json", { permissions: { defaultMode: "auto" } }],
    ];
    await startClaudeChat();
    expect(s.settings.mode).toBe("auto");
    invokeResponses.read_settings = () => [["~/.claude/settings.json", { permissions: { defaultMode: "bogus" } }]];
    s.interruptTab(s.tab.value);
    await startClaudeChat();
    expect(s.settings.mode).toBe("manual");
  });

  it("opens the resume screen for --resume and continues the latest for -c", async () => {
    s.runCommand(s.tab.value, "claude --resume");
    await flush();
    expect(s.resumeScreen[s.tab.value.id]).toBe("shell");
    s.closeResume(s.tab.value);
    expect(s.tab.value.mode).toBe("shell");

    invokeResponses.claude_sessions = () => [{ id: "abc", modified: 1, title: "t", branch: "", size: 1 }];
    invokeResponses.claude_transcript = () => [
      { kind: "user", text: "earlier" },
      { kind: "tool", id: "t1", name: "Bash", detail: "ls" },
      { kind: "toolResult", id: "t1", output: "a", isError: false },
      { kind: "text", text: "done" },
    ];
    s.runCommand(s.tab.value, "claude -c");
    await flush();
    await flush();
    expect(s.chat.value?.session).toBe("abc");
    expect(s.currentLog.value.map((l) => l.kind)).toEqual(["user", "tool", "text", "sys"]);
    expect(s.currentLog.value[1]).toMatchObject({ toolId: "t1", out: "a" });
  });

  it("reports a bad resume id without wiping the chat", async () => {
    const c = await startClaudeChat();
    await s.ask(c, "hello");
    claudeDone();
    invokeResponses.claude_transcript = () => {
      throw new Error("missing");
    };
    await s.resume(c, "nope");
    expect(c.session).toBeUndefined();
    expect(s.currentLog.value.map((l) => l.kind)).toEqual(["user", "err"]);
  });

  it("returns to the terminal with ctrl-c, exit or /exit", async () => {
    const c = await startClaudeChat();
    s.interruptTab(s.tab.value);
    expect(s.tab.value.mode).toBe("shell");
    s.runCommand(s.tab.value, "claude");
    await flush();
    await s.ask(c, "exit");
    expect(s.tab.value.mode).toBe("shell");
  });
});

describe("talking to claude", () => {
  it("sends the brief on the first message only and streams the reply", async () => {
    const c = await startClaudeChat();
    await s.ask(c, "hi");
    const first = JSON.parse(calls("claude_send")[0].args.message as string);
    expect(first.message.content[0].text).toBe(`${BRIEF_RULES}hi`);
    expect(s.busy.value).toBe(true);

    claudeLine({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-5-5",
      claude_code_version: "2",
      slash_commands: ["model", "zero-quote"],
      terminal_slash_commands: [],
    });
    expect(c.session).toBe("s1");
    expect(s.info.commands.Code).toEqual(["model", "zero-quote"]);

    claudeLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
    claudeLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
    expect(s.currentLog.value.at(-1)).toMatchObject({ kind: "text", text: "Hello" });
    claudeLine({ type: "assistant", message: { content: [{ type: "text", text: "Hello!" }] } });
    expect(s.currentLog.value.filter((l) => l.kind === "text")).toHaveLength(1);
    expect(s.currentLog.value.at(-1)?.text).toBe("Hello!");

    claudeLine({ type: "result", total_cost_usd: 0.4, duration_ms: 1500, usage: { output_tokens: 8 } });
    expect(c.cost).toBe(0.4);
    expect(s.currentLog.value.at(-1)).toMatchObject({ kind: "stats", text: "2s · ↓ 8 tokens · $0.40" });
    claudeDone();
    expect(s.busy.value).toBe(false);

    await s.ask(c, "again");
    const second = JSON.parse(calls("claude_send")[1].args.message as string);
    expect(second.message.content[0].text).toBe("again");
    expect(calls("claude_send")[1].args.args).toEqual(["--resume", "s1", "--permission-mode", "manual"]);
    claudeLine({ type: "result", total_cost_usd: 0.7 });
    expect(s.currentLog.value.at(-1)?.text).toContain("$0.30");
    expect(c.cost).toBe(0.7);
  });

  it("records tools, their results, sub-agents, todos and thinking", async () => {
    const c = await startClaudeChat();
    await s.ask(c, "go");
    claudeLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "look" } }] } });
    claudeLine({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "x" } }] } });
    claudeLine({ type: "system", subtype: "task_progress", tool_use_id: "t1", description: "Searching" });
    claudeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "found", is_error: false }] } });
    const tool = s.currentLog.value.find((l) => l.kind === "tool")!;
    expect(tool).toMatchObject({ text: "Agent", meta: "look", out: "found", children: [{ name: "Grep", detail: "x" }], progress: "Searching" });
    expect(tool.ms).toBeGreaterThanOrEqual(0);

    claudeLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] } }] },
    });
    expect(c.todos).toEqual([{ content: "a", status: "pending" }]);

    claudeLine({ type: "system", subtype: "thinking_tokens", estimated_tokens: 99 });
    expect(s.live.value.thinking).toBe(99);
    claudeLine({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 5 } } } });
    expect(c.context).toBe(10);
  });

  it("surfaces permission prompts and answers them", async () => {
    const c = await startClaudeChat();
    await s.ask(c, "rm");
    claudeLine({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm x" }, permission_suggestions: [] },
    });
    const prompt = s.pendingPermission(c.key)!;
    expect(prompt).toMatchObject({ kind: "perm", text: "Bash", meta: "rm x" });

    await s.decide(prompt, "allow");
    expect(prompt.permission?.state).toBe("allow");
    expect(JSON.parse(calls("claude_write")[0].args.line as string).response.request_id).toBe("r1");
    expect(s.pendingPermission(c.key)).toBeUndefined();

    claudeLine({
      type: "control_request",
      request_id: "r2",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Colour?", options: [] }] } },
    });
    const q = s.pendingPermission(c.key)!;
    await s.decide(q, "allow", { "Colour?": "Blue" });
    const sent = JSON.parse(calls("claude_write")[1].args.line as string).response.response;
    expect(sent.updatedInput.answers).toEqual({ "Colour?": "Blue" });
    expect(q.permission?.answers).toEqual({ "Colour?": "Blue" });

    claudeLine({ type: "control_request", request_id: "r3", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "do it" } } });
    s.settings.mode = "plan";
    await s.decide(s.pendingPermission(c.key)!, "allow");
    expect(s.settings.mode).toBe("acceptEdits");

    claudeLine({ type: "control_request", request_id: "r4", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
    claudeDone();
    expect(s.currentLog.value.at(-1)?.permission?.state).toBe("expired");
  });

  it("switches the permission mode of a running turn", async () => {
    const c = await startClaudeChat();
    s.cycleMode();
    expect(calls("claude_write")).toHaveLength(0);
    await s.ask(c, "go");
    s.cycleMode();
    const sent = JSON.parse(calls("claude_write")[0].args.line as string);
    expect(sent).toMatchObject({ type: "control_request", request: { subtype: "set_permission_mode", mode: "plan" } });
  });

  it("steers a running turn, falls back to the queue, and drains it", async () => {
    const c = await startClaudeChat();
    await s.ask(c, "first");
    await s.ask(c, "second");
    expect(calls("claude_write")).toHaveLength(1);
    expect(s.currentLog.value.filter((l) => l.kind === "user")).toHaveLength(2);

    invokeResponses.claude_write = () => {
      throw new Error("closed");
    };
    await s.ask(c, "third");
    expect(s.queue[c.key]).toEqual([{ text: "third", images: [] }]);

    delete invokeResponses.claude_write;
    claudeLine({ type: "result", total_cost_usd: 0 });
    claudeLine({ type: "result", total_cost_usd: 0 });
    claudeDone();
    await flush();
    expect(calls("claude_send")).toHaveLength(2);
    expect(s.queue[c.key]).toEqual([]);

    s.cancel(c);
    expect(calls("claude_stop")).toHaveLength(1);
  });

  it("asks for a next-prompt suggestion after a reply", async () => {
    invokeResponses.claude_oneshot = () => "thanks, now run the tests";
    const c = await startClaudeChat();
    await s.ask(c, "fix it");
    claudeLine({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] } });
    claudeLine({ type: "result", total_cost_usd: 0 });
    claudeDone();
    await flush();
    expect(s.suggestions[c.key]).toBe("thanks, now run the tests");
    await s.ask(c, "/clear");
    expect(s.suggestions[c.key]).toBeUndefined();
  });

  it("handles built-in slash commands locally", async () => {
    const c = await startClaudeChat();
    await s.ask(c, "/model sonnet");
    expect(s.settings.model).toBe("sonnet");
    await s.ask(c, "/effort max");
    expect(s.settings.effort).toBe("max");
    await s.ask(c, "/usage");
    expect(s.usageOpen.value).toBe(true);
    expect(calls("claude_probe").some((i) => i.args.rate)).toBe(true);
    await s.ask(c, "/help");
    expect(s.currentLog.value.at(-1)?.text).toContain("⇧tab");
    await s.ask(c, "/rewind");
    expect(s.rewindRequest.value?.key).toBe(c.key);
    expect(calls("claude_send")).toHaveLength(0);

    s.cycleMode();
    expect(s.settings.mode).toBe("acceptEdits");
    s.cycleMode();
    s.cycleMode();
    s.cycleMode();
    expect(s.settings.mode).toBe("manual");
  });

  it("runs ! commands and passes their output along with the next prompt", async () => {
    invokeResponses.run_command = () => ({ output: "a.txt", code: 0 });
    const c = await startClaudeChat();
    await s.runBang(c, "ls");
    expect(s.currentLog.value.at(-1)).toMatchObject({ kind: "bang", text: "ls", out: "a.txt", error: false });
    await s.ask(c, "what is there?");
    const sent = JSON.parse(calls("claude_send")[0].args.message as string).message.content[0].text;
    expect(sent).toMatch(/^<bash-input>ls<\/bash-input>\n<bash-stdout>a.txt<\/bash-stdout>\n/);
    expect(c.bang).toBeUndefined();
  });

  it("saves memories and shows settings with clickable paths", async () => {
    invokeResponses.read_settings = () => [
      ["~/.claude/settings.json", { permissions: { allow: ["Bash(git *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "lint" }] }] } }],
    ];
    const c = await startClaudeChat();
    await s.saveMemory(c, "# prefers tabs", "project");
    expect(calls("append_file")[0].args).toEqual({ path: "~/Code/CLAUDE.md", text: "- prefers tabs" });
    await s.ask(c, "/permissions");
    await flush();
    expect(s.currentLog.value.at(-1)).toMatchObject({ kind: "sys", meta: "paths", text: expect.stringContaining("allow  Bash(git *)") });
    await s.ask(c, "/hooks");
    await flush();
    expect(s.currentLog.value.at(-1)?.text).toContain("PreToolUse (Bash)  lint");
    await s.ask(c, "/memory");
    expect(s.currentLog.value.at(-1)?.text).toContain("~/Code/CLAUDE.md");
  });

  it("rewinds by forking the session and reloading it", async () => {
    invokeResponses.session_rewind = () => "forked";
    invokeResponses.claude_transcript = () => [{ kind: "user", text: "one" }];
    const c = await startClaudeChat();
    c.session = "orig";
    await s.rewind(c, 1);
    expect(calls("session_rewind")[0].args).toEqual({ cwd: "~/Code", id: "orig", keepUsers: 1 });
    expect(c.session).toBe("forked");
    expect(s.currentLog.value[0]).toMatchObject({ kind: "user", text: "one" });
  });

  it("runs a custom status line command after each reply", async () => {
    invokeResponses.read_settings = () => [["~/.claude/settings.json", { statusLine: { command: "echo hi" } }]];
    invokeResponses.run_command = () => ({ output: "hi there\nsecond", code: 0 });
    const c = await startClaudeChat();
    await s.ask(c, "x");
    claudeLine({ type: "result", total_cost_usd: 0 });
    claudeDone();
    await flush();
    await flush();
    expect(s.statusLines[c.key]).toBe("hi there");
    expect(calls("run_command").at(-1)?.args.cmd).toBe("echo hi");
  });
});

describe("tickets and persistence", () => {
  it("adds jira tickets as their own chats in the current folder", async () => {
    await startClaudeChat();
    expect(s.addTicket("https://x.atlassian.net/browse/fsp-3216")).toBe("FSP-3216");
    expect(s.chat.value).toMatchObject({ key: "FSP-3216", repo: "Code" });
    expect(s.isProjectChat(s.chat.value!)).toBe(false);
    expect(s.addTicket("nothing here")).toBeNull();
    s.selectChat("#Code");
    expect(s.chat.value?.key).toBe("#Code");
    expect(s.tabBusy(s.tab.value)).toBe(false);
  });

  it("persists chat logs to disk, skipping terminal output, and loads them back", async () => {
    vi.useFakeTimers();
    s.runCommand(s.tab.value, "claude");
    await vi.advanceTimersByTimeAsync(1);
    const c = s.chat.value!;
    await s.ask(c, "remember me");
    s.newTab();
    s.runCommand(s.tab.value, "x");
    await vi.advanceTimersByTimeAsync(1100);
    const saves = calls("log_save");
    expect(saves.map((i) => i.args.key)).toEqual(["#Code"]);
    expect(JSON.parse(saves[0].args.json as string)[0].text).toBe("remember me");
    vi.useRealTimers();

    localStorage.setItem("cockpit.repos.v1", JSON.stringify([{ id: "Code", name: "Code", path: "~/Code" }]));
    localStorage.setItem("cockpit.chats.v1", JSON.stringify([{ key: "#Code", repo: "Code", title: "Code" }]));
    vi.resetModules();
    resetTauri();
    resetListeners();
    invokeResponses.logs_load_all = () => ({ "#Code": [{ id: 1, kind: "user", text: "from disk", at: 1 }] });
    mod = await import("./useCockpit");
    s = mod.useCockpit();
    await flush();
    s.selectChat("#Code");
    expect(s.currentLog.value[0].text).toBe("from disk");
  });

  it("migrates legacy localStorage logs once", async () => {
    localStorage.setItem(
      "cockpit.logs.v1",
      JSON.stringify({ "#Code": [{ id: 1, kind: "user", text: "old", at: 1 }], "sh:x": [{ id: 2, kind: "user", text: "skip", at: 1 }] }),
    );
    localStorage.setItem("cockpit.repos.v1", JSON.stringify([{ id: "Code", name: "Code", path: "~/Code" }]));
    vi.resetModules();
    resetTauri();
    resetListeners();
    mod = await import("./useCockpit");
    s = mod.useCockpit();
    await flush();
    expect(localStorage.getItem("cockpit.logs.v1")).toBeNull();
    s.selectChat("#Code");
    expect(s.currentLog.value[0].text).toBe("old");
    await nextTick();
  });
});
