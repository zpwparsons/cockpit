const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const COLORS: Record<number, string> = {
  30: "var(--ink-4)",
  31: "var(--stop)",
  32: "var(--amber)",
  33: "var(--warn)",
  34: "var(--sky)",
  35: "#d48cff",
  36: "#5eead4",
  37: "var(--paper)",
  90: "var(--paper-faint)",
  91: "var(--stop)",
  92: "var(--amber)",
  93: "var(--warn)",
  94: "var(--sky)",
  95: "#d48cff",
  96: "#5eead4",
  97: "var(--paper)",
};

export function ansi(src: string) {
  let color = "";
  let bold = false;
  let out = "";
  for (const part of src.split(/\x1b\[([\d;]*)m/).map((p, i) => [p, i % 2] as const)) {
    const [text, isCode] = part;
    if (!isCode) {
      if (!text) continue;
      const style = [color && `color:${color}`, bold && "color:var(--paper)"].filter(Boolean).join(";");
      out += style ? `<span style="${style}">${esc(text)}</span>` : esc(text);
      continue;
    }
    for (const n of (text || "0").split(";").map(Number)) {
      if (n === 0) ((color = ""), (bold = false));
      else if (n === 1) bold = true;
      else if (n === 22) bold = false;
      else if (n === 39) color = "";
      else if (COLORS[n]) color = COLORS[n];
    }
  }
  return out.replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
}
