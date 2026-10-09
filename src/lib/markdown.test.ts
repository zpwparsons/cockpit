import { describe, expect, it } from "vitest";
import { md } from "./markdown";

describe("md", () => {
  it("escapes html and keeps plain lines", () => {
    expect(md('a <b> & "c"')).toBe("<div>a &lt;b&gt; &amp; &quot;c&quot;</div>");
  });

  it("renders inline code, bold, italic and links", () => {
    const html = md("use `x` **bold** *it* [doc](https://x.io/a) https://y.io/b");
    expect(html).toContain('<code class="md-code">x</code>');
    expect(html).toContain('<strong class="text-paper">bold</strong>');
    expect(html).toContain("<em>it</em>");
    expect(html).toContain('<a class="md-a" data-href="https://x.io/a">doc</a>');
    expect(html).toContain('<a class="md-a" data-href="https://y.io/b">https://y.io/b</a>');
  });

  it("does not format markdown inside inline code", () => {
    expect(md("`**not bold**`")).toContain('<code class="md-code">**not bold**</code>');
  });

  it("renders headings, lists, quotes and rules", () => {
    const html = md("# Title\n- a\n  - b\n1. one\n> quoted\n---");
    expect(html).toContain('<div class="md-h">Title</div>');
    expect(html).toContain('padding-left:14px"><span class="md-b">-</span>a');
    expect(html).toContain('padding-left:26px"><span class="md-b">-</span>b');
    expect(html).toContain('<span class="md-n">1.</span>one');
    expect(html).toContain('<div class="md-quote">quoted</div>');
    expect(html).toContain('<div class="md-hr"></div>');
  });

  it("renders tables", () => {
    const html = md("| a | b |\n|---|---|\n| 1 | **2** |");
    expect(html).toContain("<th>a</th><th>b</th>");
    expect(html).toContain('<td>1</td><td><strong class="text-paper">2</strong></td>');
  });

  it("renders fenced code verbatim and escaped", () => {
    const html = md('before\n```ts\nconst a = "<b>";\n```\nafter');
    expect(html).toBe('<div>before</div><pre class="md-pre">const a = &quot;&lt;b&gt;&quot;;</pre><div>after</div>');
  });

  it("keeps blank lines as spacing", () => {
    expect(md("a\n\nb")).toBe('<div>a</div><div class="h-2"></div><div>b</div>');
  });
});
