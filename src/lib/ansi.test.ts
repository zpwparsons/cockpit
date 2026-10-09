import { describe, expect, it } from "vitest";
import { ansi } from "./ansi";

describe("ansi", () => {
  it("escapes html when there are no codes", () => {
    expect(ansi("<b> & c")).toBe("&lt;b&gt; &amp; c");
  });

  it("colours standard and bright foregrounds", () => {
    expect(ansi("\x1b[32mok\x1b[0m done")).toBe('<span style="color:var(--amber)">ok</span> done');
    expect(ansi("\x1b[91mred\x1b[39m")).toBe('<span style="color:var(--stop)">red</span>');
  });

  it("handles combined codes and bold", () => {
    expect(ansi("\x1b[1;34mx\x1b[22my")).toBe('<span style="color:var(--sky);color:var(--paper)">x</span><span style="color:var(--sky)">y</span>');
    expect(ansi("\x1b[mplain")).toBe("plain");
  });

  it("strips cursor and erase sequences", () => {
    expect(ansi("a\x1b[2K\x1b[1Ab\x1b[?25l")).toBe("ab");
  });

  it("ignores unknown colour codes", () => {
    expect(ansi("\x1b[48;5;200mx")).toBe("x");
  });
});
