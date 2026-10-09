export interface Repo {
  id: string;
  name: string;
  path: string;
}

export interface Chat {
  key: string;
  repo: string;
  title: string;
  session?: string;
  cost?: number;
  context?: number;
  todos?: Todo[];
  bang?: string;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export type LogKind = "user" | "text" | "tool" | "err" | "stats" | "sys" | "perm" | "out" | "bang";

export interface LogLine {
  id: number;
  kind: LogKind;
  text: string;
  meta?: string;
  at: number;
  toolId?: string;
  out?: string;
  ms?: number;
  error?: boolean;
  images?: string[];
  html?: string;
  children?: { name: string; detail: string }[];
  progress?: string;
  diff?: Diff[];
  permission?: {
    run: string;
    request: import("./claude").PermissionRequest;
    state: "pending" | "allow" | "always" | "deny" | "expired";
    answers?: Record<string, string>;
  };
}

export interface Diff {
  old: string;
  new: string;
}

export interface RateWindow {
  utilization: number;
  resetsAt: number;
}

export interface Rate {
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  at: number;
}
