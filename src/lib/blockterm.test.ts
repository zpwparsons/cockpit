import { describe, expect, it } from "vitest";
import { BlockTerm } from "./blockterm";

const render = (data: string, cols = 40, rows = 24, scrollback?: number) =>
  new Promise<string>((resolve) => {
    const b = new BlockTerm(cols, rows);
    b.write(data, () => {
      const html = b.html(scrollback);
      b.dispose();
      resolve(html);
    });
  });

describe("BlockTerm", () => {
  it("handles carriage-return redraws and trims trailing blank rows", async () => {
    expect(await render("10%\r100%\r\n\r\n\r\n")).toBe("<div><span>100%</span></div>");
  });

  it("maps xterm's default palette to the app's colours", async () => {
    const html = await render("\x1b[32mok\x1b[0m");
    expect(html).toContain("color: #84cc16");
    expect(html).not.toContain("#4e9a06");
  });

  it("keeps the normal buffer after a full-screen app exits", async () => {
    const html = await render("before\r\n\x1b[?1049hFULL\x1b[?1049lafter\r\n");
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).not.toContain("FULL");
  });

  it("supports cursor-up redraws across rows", async () => {
    expect(await render("a\r\nb\r\n\x1b[2Ac\r\n")).toBe("<div><span>c</span></div><div><span>b</span></div>");
  });

  it("limits output to the requested scrollback while live", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\r\n") + "\r\n";
    const live = await render(lines, 40, 5, 3);
    expect(live).not.toContain("l0<");
    expect(live).toContain("l29");
    const full = await render(lines, 40, 5);
    expect(full).toContain(">l0<");
  });

  it("returns an empty string for no output", async () => {
    expect(await render("")).toBe("");
  });
});
