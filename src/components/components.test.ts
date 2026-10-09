import { nextTick } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, invokeLog, invokeResponses, resetListeners, resetTauri } from "@/test/setup";
import type { LogLine } from "@/lib/types";

type Store = typeof import("@/composables/useCockpit");
let s: ReturnType<Store["useCockpit"]>;
const flush = () => new Promise((r) => setTimeout(r, 0));
const calls = (cmd: string) => invokeLog.filter((i) => i.cmd === cmd);

async function fresh() {
  vi.resetModules();
  resetTauri();
  resetListeners();
  localStorage.clear();
  document.body.innerHTML = "";
  s = (await import("@/composables/useCockpit")).useCockpit();
  await flush();
}

async function component<T>(path: string): Promise<T> {
  return (await import(path)).default;
}

async function enterClaude() {
  s.runCommand(s.tab.value, "claude");
  await flush();
  return s.chat.value!;
}

function key(w: VueWrapper, selector: string, key: string, extra: Record<string, unknown> = {}) {
  return w.find(selector).trigger("keydown", { key, ...extra });
}

beforeEach(fresh);
afterEach(() => vi.useRealTimers());

describe("Composer", () => {
  async function mountComposer() {
    const Composer = await component<any>("./Composer.vue");
    const w = mount(Composer, { attachTo: document.body });
    await flush();
    return w;
  }

  it("runs shell commands on enter and shows the folder in the status line", async () => {
    const w = await mountComposer();
    expect(w.text()).toContain("~/Code");
    await w.find("textarea").setValue("ls -a");
    expect(w.find(".text-amber").text()).toBe("ls");
    expect(w.find(".text-warn").text()).toBe("-a");
    await key(w, "textarea", "Enter");
    expect(s.currentLog.value[0]).toMatchObject({ kind: "user", text: "ls -a" });
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  it("sends input to a running command instead of starting a new one", async () => {
    const w = await mountComposer();
    emit("pty://event", { tab: s.tab.value.id, event: { kind: "done", code: 0, cwd: "/Users/test/Code" } });
    s.runCommand(s.tab.value, "read x");
    await w.find("textarea").setValue("hello");
    await key(w, "textarea", "Enter");
    expect(calls("pty_write").at(-1)?.args.data).toBe("hello\r");
  });

  it("opens the slash menu in claude mode and runs the chosen command", async () => {
    await enterClaude();
    const w = await mountComposer();
    await w.find("textarea").setValue("/mod");
    await nextTick();
    const items = w.findAll("[id^=opt-]");
    expect(items[0].text()).toContain("/model");
    await key(w, "textarea", "Enter");
    await nextTick();
    expect(w.text()).toContain("Model");
    expect(w.findAll("[id^=opt-]").map((i) => i.text())).toEqual(expect.arrayContaining([expect.stringContaining("Sonnet 5.5")]));
    await key(w, "textarea", "ArrowDown");
    await key(w, "textarea", "ArrowDown");
    await key(w, "textarea", "Enter");
    expect(s.settings.model).toBe("opus");
  });

  it("cycles the permission mode with shift+tab", async () => {
    await enterClaude();
    const w = await mountComposer();
    await key(w, "textarea", "Tab", { shiftKey: true });
    expect(s.settings.mode).toBe("plan");
    expect(w.text()).toContain("plan mode on");
  });

  it("runs ! commands and saves # memories", async () => {
    invokeResponses.run_command = () => ({ output: "x", code: 0 });
    const c = await enterClaude();
    const w = await mountComposer();
    await w.find("textarea").setValue("!ls");
    expect(w.text()).toContain("bash mode");
    await key(w, "textarea", "Enter");
    await flush();
    expect(s.currentLog.value.at(-1)).toMatchObject({ kind: "bang", text: "ls" });

    await w.find("textarea").setValue("#likes tabs");
    expect(w.text()).toContain("# memory");
    await key(w, "textarea", "Enter");
    await nextTick();
    expect(w.text()).toContain("Project memory");
    await key(w, "textarea", "ArrowDown");
    await key(w, "textarea", "Enter");
    await flush();
    expect(calls("append_file")[0].args).toEqual({ path: "~/.claude/CLAUDE.md", text: "- likes tabs" });
    expect(c.key).toBe("#Code");
  });

  it("offers @ file mentions and inserts the chosen path", async () => {
    invokeResponses.list_files = () => ["src/main.ts", "src/App.vue"];
    await enterClaude();
    const w = await mountComposer();
    vi.useFakeTimers();
    const ta = w.find("textarea");
    await ta.setValue("look at @ma");
    (ta.element as HTMLTextAreaElement).setSelectionRange(11, 11);
    await ta.trigger("input");
    await vi.advanceTimersByTimeAsync(100);
    await nextTick();
    expect(w.findAll("[id^=opt-]")[0].text()).toContain("@src/main.ts");
    await key(w, "textarea", "Enter");
    await nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("look at @src/main.ts ");
    vi.useRealTimers();
  });

  it("searches history with ctrl+r in the terminal", async () => {
    invokeResponses.shell_history = () => ["git status", "bun test"];
    const w = await mountComposer();
    await key(w, "textarea", "r", { ctrlKey: true });
    await flush();
    await nextTick();
    expect(w.text()).toContain("History search");
    await w.find("textarea").setValue("bun");
    await nextTick();
    expect(w.findAll("[id^=opt-]").map((i) => i.text())).toEqual(["bun test"]);
    await key(w, "textarea", "Enter");
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("bun test");
  });

  it("completes paths on tab with the zsh fallback", async () => {
    invokeResponses.complete_path = () => ["src/", "scripts/"];
    const w = await mountComposer();
    await w.find("textarea").setValue("cd s");
    await key(w, "textarea", "Tab");
    await flush();
    await nextTick();
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("cd s");
    expect(w.findAll("[id^=opt-]").map((i) => i.text())).toEqual(["src/", "scripts/"]);
  });

  it("answers permission prompts from the keyboard", async () => {
    const c = await enterClaude();
    await s.ask(c, "rm");
    emit("claude://line", {
      run: s.runs[c.key].id,
      line: JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm" } } }),
    });
    const w = await mountComposer();
    expect(w.text()).toContain("permission needed");
    await key(w, "textarea", "Tab");
    await flush();
    expect(s.pendingPermission(c.key)).toBeUndefined();
    expect(JSON.parse(calls("claude_write")[0].args.line as string).response.response.behavior).toBe("allow");
  });

  it("shows the working line while claude runs and stops on escape", async () => {
    const c = await enterClaude();
    const w = await mountComposer();
    await s.ask(c, "go");
    await nextTick();
    expect(w.text()).toContain("esc to stop");
    await key(w, "textarea", "Escape");
    expect(calls("claude_stop")).toHaveLength(1);
  });

  it("opens the rewind picker on a double escape", async () => {
    const c = await enterClaude();
    await s.ask(c, "first");
    emit("claude://done", { run: s.runs[c.key].id, code: 0, stderr: "" });
    c.session = "s1";
    const w = await mountComposer();
    await key(w, "textarea", "Escape");
    await key(w, "textarea", "Escape");
    await nextTick();
    expect(w.text()).toContain("Rewind the conversation");
    expect(w.findAll("[id^=opt-]")[0].text()).toContain("first");
  });
});

describe("LogItem", () => {
  const mountItem = async (item: Partial<LogLine>) =>
    mount(await component<any>("./LogItem.vue"), { props: { item: { id: 1, at: 0, text: "", kind: "text", ...item } } });

  it("renders markdown text and the streaming caret", async () => {
    const w = await mountItem({ kind: "text", text: "**hi**" });
    expect(w.html()).toContain("<strong");
    const streaming = mount(await component<any>("./LogItem.vue"), { props: { item: { id: 1, at: 0, kind: "text", text: "x" }, streaming: true } });
    expect(streaming.classes()).toContain("caret");
  });

  it("toggles tool output and shows diff stats", async () => {
    const w = await mountItem({ kind: "tool", text: "Bash", meta: "ls", out: "a\nb\n", ms: 1500 });
    expect(w.text()).toContain("$ ls");
    expect(w.text()).toContain("1.5s · 2 lines");
    expect(w.find("pre").exists()).toBe(false);
    await w.find("button").trigger("click");
    expect(w.find("pre").text()).toBe("a\nb");

    const diff = await mountItem({ kind: "tool", text: "Edit", meta: "a.ts", diff: [{ old: "x", new: "y\nz" }] });
    expect(diff.text()).toContain("+2");
    expect(diff.text()).toContain("-1");
    await diff.find("button").trigger("click");
    expect(diff.findAll(".diff-add")).toHaveLength(2);
  });

  it("lists sub-agent steps", async () => {
    const w = await mountItem({ kind: "tool", text: "Agent", meta: "look", children: [{ name: "Grep", detail: "x" }], progress: "Searching" });
    expect(w.text()).toContain("Searching · 1 steps");
    await w.find("button").trigger("click");
    expect(w.text()).toContain("↳ Grep");
  });

  it("renders question cards and submits the chosen answer", async () => {
    await enterClaude();
    const item: LogLine = {
      id: 1,
      at: 0,
      kind: "perm",
      text: "AskUserQuestion",
      permission: {
        run: "r",
        state: "pending",
        request: {
          requestId: "q1",
          tool: "AskUserQuestion",
          detail: "",
          suggestions: [],
          input: { questions: [{ question: "Colour?", options: [{ label: "Red" }, { label: "Blue" }] }] },
        },
      },
    };
    s.currentLog.value.push(item);
    const w = await mountItem(item);
    expect(w.text()).toContain("Colour?");
    await w
      .findAll("button")
      .find((b) => b.text().includes("Blue"))!
      .trigger("click");
    await flush();
    expect(item.permission?.state).toBe("allow");
    expect(item.permission?.answers).toEqual({ "Colour?": "Blue" });
    expect(w.text()).toContain("→ Blue");
  });

  it("renders bang lines, errors and clickable paths", async () => {
    const bang = await mountItem({ kind: "bang", text: "ls", out: "a", ms: 10, error: true });
    expect(bang.find(".text-stop").exists()).toBe(true);
    const err = await mountItem({ kind: "err", text: "boom" });
    expect(err.text()).toBe("error: boom");
    const paths = await mountItem({ kind: "sys", meta: "paths", text: "~/Code/CLAUDE.md\nnot a path" });
    expect(paths.find("[data-path]").attributes("data-path")).toBe("~/Code/CLAUDE.md");
  });
});

describe("CommandBlock", () => {
  it("shows the folder, highlighted command, output and status", async () => {
    const CommandBlock = await component<any>("./CommandBlock.vue");
    const w = mount(CommandBlock, {
      props: {
        cmd: { id: 1, at: 0, kind: "user", text: "ls -a", meta: "~/Code" },
        out: { id: 2, at: 0, kind: "out", text: "", html: "<div><span>a.txt</span></div>" },
        stats: { id: 3, at: 0, kind: "stats", text: "exit 1 · 0s", error: true },
      },
    });
    expect(w.text()).toContain("~/Code");
    expect(w.find(".text-amber").text()).toBe("ls");
    expect(w.text()).toContain("a.txt");
    expect(w.classes()).toContain("border-l-stop/70");
    await w
      .findAll("button")
      .find((b) => b.text().includes("copy command"))!
      .trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ls -a");
    await w
      .findAll("button")
      .find((b) => b.text().includes("copy output"))!
      .trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("a.txt");
  });

  it("blinks while running", async () => {
    const CommandBlock = await component<any>("./CommandBlock.vue");
    const w = mount(CommandBlock, { props: { cmd: { id: 1, at: 0, kind: "user", text: "sleep", meta: "~" } } });
    expect(w.find(".dos-blink").exists()).toBe(true);
    expect(w.text()).not.toContain("copy output");
  });
});

describe("UsageCard", () => {
  it("draws usage bars and turns red near the limit", async () => {
    const UsageCard = await component<any>("./UsageCard.vue");
    const w = mount(UsageCard, { props: { usage: { cost: 1.5, fiveHour: { utilization: 0.25, resetsAt: 0 }, sevenDay: { utilization: 0.95, resetsAt: 0 } } } });
    expect(w.text()).toContain("25%");
    expect(w.text()).toContain("95%");
    expect(w.text()).toContain("$1.50");
    const bars = w.findAll(".whitespace-pre");
    expect(bars[0].text()).toBe("█".repeat(9) + "░".repeat(27));
    expect(bars[1].find("span").classes()).toContain("text-stop");
  });

  it("shows loading and failure states", async () => {
    const UsageCard = await component<any>("./UsageCard.vue");
    expect(mount(UsageCard, { props: { usage: { cost: 0 }, loading: true } }).text()).toContain("Checking your plan limits");
    expect(mount(UsageCard, { props: { usage: { cost: 0 } } }).text()).toContain("Couldn't load plan limits");
  });
});

describe("TitleBar", () => {
  it("lists tabs, switches and closes them", async () => {
    const TitleBar = await component<any>("./TitleBar.vue");
    const w = mount(TitleBar);
    s.newTab();
    await enterClaude();
    await nextTick();
    const tabs = w.findAll("header > button.group");
    expect(tabs).toHaveLength(2);
    expect(tabs[1].text()).toContain("✻");
    await tabs[0].trigger("click");
    expect(s.tab.value.id).toBe(s.tabs[0].id);
    await tabs[1].find("svg").trigger("click");
    expect(s.tabs).toHaveLength(1);
  });
});

describe("ResumeScreen", () => {
  it("lists, filters and resumes sessions", async () => {
    invokeResponses.claude_sessions = () => [
      { id: "a", modified: Date.now() - 120000, title: "Fix login", branch: "main", size: 2048 },
      { id: "b", modified: Date.now() - 2 * 86400000, title: "Write docs", branch: "", size: 10 },
    ];
    invokeResponses.claude_transcript = () => [{ kind: "user", text: "resumed" }];
    await enterClaude();
    s.openResume(s.tab.value, "chat");
    const ResumeScreen = await component<any>("./ResumeScreen.vue");
    const w = mount(ResumeScreen, { attachTo: document.body });
    await flush();
    await nextTick();
    expect(w.text()).toContain("Fix login");
    expect(w.text()).toContain("2 minutes ago · main · 2.0KB");
    expect(w.text()).toContain("2 days ago · 10B");
    await w.find("input").setValue("docs");
    await nextTick();
    expect(w.findAll("[id^=session-]")).toHaveLength(1);
    await key(w, "input", "Enter");
    await flush();
    expect(s.chat.value?.session).toBe("b");
    expect(s.resumeScreen[s.tab.value.id]).toBeUndefined();
  });

  it("cancels with escape", async () => {
    await enterClaude();
    s.openResume(s.tab.value, "shell");
    const ResumeScreen = await component<any>("./ResumeScreen.vue");
    const w = mount(ResumeScreen);
    await key(w, "input", "Escape");
    expect(s.tab.value.mode).toBe("shell");
  });
});

describe("Terminal and Transcript", () => {
  it("groups terminal lines into blocks anchored at the bottom", async () => {
    emit("pty://event", { tab: s.tab.value.id, event: { kind: "done", code: 0, cwd: "/Users/test/Code" } });
    s.runCommand(s.tab.value, "ls");
    emit("pty://event", { tab: s.tab.value.id, event: { kind: "cmd" } });
    emit("pty://event", { tab: s.tab.value.id, event: { kind: "done", code: 0, cwd: "/Users/test/Code" } });
    await flush();
    const Terminal = await component<any>("./Terminal.vue");
    const w = mount(Terminal);
    await nextTick();
    expect(w.findAll(".group")).toHaveLength(1);
    expect(w.find(".justify-end").exists()).toBe(true);
  });

  it("groups chat lines into user and agent boxes", async () => {
    const c = await enterClaude();
    await s.ask(c, "hello");
    const run = s.runs[c.key].id;
    emit("claude://line", { run, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reply" }] } }) });
    emit("claude://line", { run, line: JSON.stringify({ type: "result", total_cost_usd: 0.1, duration_ms: 1000, usage: { output_tokens: 3 } }) });
    const Transcript = await component<any>("./Transcript.vue");
    const w = mount(Transcript);
    await nextTick();
    expect(w.find(".tui-box").text()).toContain("hello");
    expect(w.find(".tui-box-agent").text()).toContain("reply");
    expect(w.find(".tui-bottom").text()).toContain("$0.10");
  });

  it("shows the welcome screen for an empty chat", async () => {
    await enterClaude();
    const Transcript = await component<any>("./Transcript.vue");
    const w = mount(Transcript);
    expect(w.text()).toContain("Claude Code");
    expect(w.text()).toContain("~/Code");
  });
});
