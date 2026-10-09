export interface Segment {
  text: string;
  cls: string;
  cursor?: boolean;
}

const PREFIX = new Set(["sudo", "time", "exec", "nohup", "env", "command", "builtin", "noglob"]);
const OPS = /^(\|\||&&|[|;&<>]+)/;

export function highlight(src: string, known: Set<string>): Segment[] {
  const out: Segment[] = [];
  let expectCmd = true;
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ws = rest.match(/^\s+/);
    const op = rest.match(OPS);
    const quoted = rest.match(/^("(?:[^"\\]|\\.)*"?|'[^']*'?)/);
    let text: string;
    let cls = "text-paper";
    if (ws) text = ws[0];
    else if (op) {
      text = op[0];
      cls = "text-paper-mute";
      if (!/^[<>]/.test(text)) expectCmd = true;
    } else if (quoted) {
      text = quoted[0];
      cls = "text-sky";
      expectCmd = false;
    } else {
      text = rest.match(/^[^\s|;&<>"']+/)![0];
      if (expectCmd && /^\w+=/.test(text)) cls = "text-paper-mute";
      else if (expectCmd) {
        cls = known.has(text) || text.includes("/") ? "text-amber" : "text-stop";
        expectCmd = PREFIX.has(text);
      } else if (text.startsWith("-")) cls = "text-warn";
      else if (text.startsWith("$")) cls = "text-sky";
    }
    out.push({ text, cls });
    i += text.length;
  }
  return out;
}

export function withCursor(segments: Segment[], at: number): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  let placed = false;
  for (const s of segments) {
    const end = pos + s.text.length;
    if (!placed && at >= pos && at < end) {
      const k = at - pos;
      if (k) out.push({ text: s.text.slice(0, k), cls: s.cls });
      out.push({ text: s.text[k] === "\n" ? " " : s.text[k], cls: s.cls, cursor: true });
      if (s.text[k] === "\n") out.push({ text: "\n", cls: s.cls });
      if (k + 1 < s.text.length) out.push({ text: s.text.slice(k + 1), cls: s.cls });
      placed = true;
    } else out.push(s);
    pos = end;
  }
  if (!placed) out.push({ text: " ", cls: "", cursor: true });
  return out;
}
