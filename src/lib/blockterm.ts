import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

const THEME = {
  foreground: "#c1cddb",
  background: "#0b121f",
  black: "#222e44",
  red: "#f2545b",
  green: "#84cc16",
  yellow: "#fbbf24",
  blue: "#38bdf8",
  magenta: "#d48cff",
  cyan: "#5eead4",
  white: "#eef3f7",
  brightBlack: "#5b6c82",
  brightRed: "#f2545b",
  brightGreen: "#bef264",
  brightYellow: "#fbbf24",
  brightBlue: "#38bdf8",
  brightMagenta: "#d48cff",
  brightCyan: "#5eead4",
  brightWhite: "#ffffff",
};

const XTERM_DEFAULTS: Record<string, string> = {
  "#2e3436": THEME.black,
  "#cc0000": THEME.red,
  "#4e9a06": THEME.green,
  "#c4a000": THEME.yellow,
  "#3465a4": THEME.blue,
  "#75507b": THEME.magenta,
  "#06989a": THEME.cyan,
  "#d3d7cf": THEME.white,
  "#555753": THEME.brightBlack,
  "#ef2929": THEME.brightRed,
  "#8ae234": THEME.brightGreen,
  "#fce94f": THEME.brightYellow,
  "#729fcf": THEME.brightBlue,
  "#ad7fa8": THEME.brightMagenta,
  "#34e2e2": THEME.brightCyan,
  "#eeeeec": THEME.brightWhite,
};

export class BlockTerm {
  private term: Terminal;
  private serializer = new SerializeAddon();

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true, theme: THEME });
    this.term.loadAddon(this.serializer);
  }

  write(data: string, done?: () => void) {
    this.term.write(data, done);
  }

  html(scrollback?: number) {
    const raw = this.serializer.serializeAsHTML({ includeGlobalBackground: false, scrollback });
    const body = raw.slice(raw.indexOf("<pre>") + 5, raw.lastIndexOf("</pre>"));
    const rows = body.replace(/^<div[^>]*>|<\/div>$/g, "").split(/(?=<div><span)/);
    while (rows.length && /^<div>(<span[^>]*>\s*<\/span>)*<\/div>$/.test(rows[rows.length - 1].trim())) rows.pop();
    return rows
      .join("")
      .replace(/\s+(?=<\/span><\/div>)/g, "")
      .replace(/#[0-9a-f]{6}/gi, (c) => XTERM_DEFAULTS[c.toLowerCase()] ?? c);
  }

  dispose() {
    this.term.dispose();
  }
}

export { THEME };
