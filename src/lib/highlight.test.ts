import { describe, expect, it } from "vitest";
import { highlight, withCursor } from "./highlight";

const known = new Set(["git", "ls", "sudo", "cd"]);
const classes = (src: string) => highlight(src, known).map((s) => `${s.text}:${s.cls}`);

describe("highlight", () => {
  it("marks known commands, flags, args and strings", () => {
    expect(classes('git commit -m "hi there" $HOME')).toEqual([
      "git:text-amber",
      " :text-paper",
      "commit:text-paper",
      " :text-paper",
      "-m:text-warn",
      " :text-paper",
      '"hi there":text-sky',
      " :text-paper",
      "$HOME:text-sky",
    ]);
  });

  it("marks unknown commands red and paths amber", () => {
    expect(classes("nope")).toEqual(["nope:text-stop"]);
    expect(classes("./run.sh")).toEqual(["./run.sh:text-amber"]);
  });

  it("re-checks the command after pipes and chains", () => {
    expect(classes("ls | nope && git")).toEqual([
      "ls:text-amber",
      " :text-paper",
      "|:text-paper-mute",
      " :text-paper",
      "nope:text-stop",
      " :text-paper",
      "&&:text-paper-mute",
      " :text-paper",
      "git:text-amber",
    ]);
  });

  it("treats redirect targets as arguments", () => {
    expect(classes("ls > out")).toEqual(["ls:text-amber", " :text-paper", ">:text-paper-mute", " :text-paper", "out:text-paper"]);
  });

  it("handles env assignments and sudo prefixes", () => {
    expect(classes("FOO=1 git")).toEqual(["FOO=1:text-paper-mute", " :text-paper", "git:text-amber"]);
    expect(classes("sudo nope")).toEqual(["sudo:text-amber", " :text-paper", "nope:text-stop"]);
  });

  it("tolerates an unterminated quote", () => {
    expect(classes("echo 'open")).toEqual(["echo:text-stop", " :text-paper", "'open:text-sky"]);
  });

  it("returns nothing for an empty line", () => {
    expect(highlight("", known)).toEqual([]);
  });
});

describe("withCursor", () => {
  const segs = highlight("ls -a", known);

  it("splits the segment under the cursor", () => {
    expect(withCursor(segs, 1)).toEqual([
      { text: "l", cls: "text-amber" },
      { text: "s", cls: "text-amber", cursor: true },
      { text: " ", cls: "text-paper" },
      { text: "-a", cls: "text-warn" },
    ]);
  });

  it("adds a trailing cursor at the end of the line", () => {
    const out = withCursor(segs, 5);
    expect(out.at(-1)).toEqual({ text: " ", cls: "", cursor: true });
  });

  it("renders a newline under the cursor as a visible block", () => {
    const out = withCursor([{ text: "a\nb", cls: "x" }], 1);
    expect(out).toEqual([
      { text: "a", cls: "x" },
      { text: " ", cls: "x", cursor: true },
      { text: "\n", cls: "x" },
      { text: "b", cls: "x" },
    ]);
  });
});
