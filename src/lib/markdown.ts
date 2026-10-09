const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string) {
  const codes: string[] = [];
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code class="md-code">${c}</code>`) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="md-a" data-href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a class="md-a" data-href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-paper">$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function table(lines: string[]) {
  const [head, , ...body] = lines;
  const th = cells(head)
    .map((c) => `<th>${inline(c)}</th>`)
    .join("");
  const tr = body
    .map(
      (r) =>
        `<tr>${cells(r)
          .map((c) => `<td>${inline(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function block(text: string) {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? "")) {
      const rows = [line];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(lines[++i]);
      out.push(table(rows));
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)/);
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    const li = line.match(/^(\s*)[-*]\s+(.*)/);
    const quote = line.match(/^>\s?(.*)/);
    if (h) out.push(`<div class="md-h">${inline(h[1])}</div>`);
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) out.push('<div class="md-hr"></div>');
    else if (ol) out.push(`<div class="md-li" style="padding-left:${ol[1].length * 6 + 22}px"><span class="md-n">${ol[2]}.</span>${inline(ol[3])}</div>`);
    else if (li) out.push(`<div class="md-li" style="padding-left:${li[1].length * 6 + 14}px"><span class="md-b">-</span>${inline(li[2])}</div>`);
    else if (quote) out.push(`<div class="md-quote">${inline(quote[1])}</div>`);
    else out.push(line.trim() ? `<div>${inline(line)}</div>` : '<div class="h-2"></div>');
  }
  return out.join("");
}

export function md(src: string) {
  const parts = src.split(/```[\w-]*\n?/);
  return parts
    .map((p, i) => (i % 2 ? `<pre class="md-pre">${esc(p.replace(/\n$/, ""))}</pre>` : block(i < parts.length - 1 ? p.replace(/\n$/, "") : p)))
    .join("");
}
