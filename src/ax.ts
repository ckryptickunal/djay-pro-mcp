// Client for the Swift accessibility bridge: reads deck readouts, the library browser and menus.
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { AX_BRIDGE } from "./paths.js";

export interface AXNode {
  path: number[];
  role: string;
  title?: string;
  desc?: string;
  value?: string;
  help?: string;
  subrole?: string;
  enabled?: boolean;
  selected?: boolean;
  actions?: string[];
}

export interface DeckReadout {
  deck: number;
  title?: string;
  artist?: string;
  bpm?: number;
  key?: string;
  time?: string;
  timeIsRemaining?: boolean;
  tempoPercent?: number;
  keyLock?: boolean;
  loopLength?: string;
  beatJump?: string;
  sliders: Record<string, string>;
}

export class AX {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    if (!existsSync(AX_BRIDGE)) throw new Error(`accessibility bridge not built (${AX_BRIDGE}). Run: npm run build`);
    const proc = spawn(AX_BRIDGE, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error ?? "accessibility request failed"));
    });
    proc.on("exit", () => {
      for (const [, p] of this.pending) p.reject(new Error("accessibility bridge exited"));
      this.pending.clear();
    });
  }

  request<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`accessibility request '${op}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  stop() {
    this.proc?.stdin.end();
    this.proc?.kill();
  }

  status() {
    return this.request<{ running: boolean; pid: number; trusted: boolean; active: boolean; hidden: boolean; version: string | null }>("status");
  }

  snapshot(rows = false, maxNodes = 4000) {
    return this.request<AXNode[]>("snapshot", { rows, maxNodes });
  }

  press(target: { label?: string; role?: string; nth?: number; exact?: boolean; path?: number[]; action?: string }) {
    return this.request("press", target);
  }

  setValue(target: { label?: string; role?: string; nth?: number; exact?: boolean; path?: number[] }, value: string | number) {
    return this.request("setValue", { ...target, value });
  }

  focus(target: { label?: string; role?: string; path?: number[] }) {
    return this.request("focus", target);
  }

  rows(start = 0, count = 50) {
    return this.request<{ table: string; total: number; columns: string[]; rows: { index: number; cells: string[][]; selected: boolean }[] }>(
      "rows",
      { start, count },
      20000,
    );
  }

  selectRow(index: number) {
    return this.request("selectRow", { index });
  }

  menus() {
    return this.request<{ menu: string; items: { title: string; enabled: boolean; checked?: boolean; submenu?: string[] }[] }[]>("menus");
  }

  menu(path: string[]) {
    return this.request("menu", { path });
  }
}

const pct = (s?: string) => {
  if (!s) return undefined;
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : undefined;
};

/** Extracts per-deck readouts from a snapshot. Labels look like "Title, Deck 1". */
export function parseDecks(nodes: AXNode[]): DeckReadout[] {
  const decks = new Map<number, DeckReadout>();
  for (const n of nodes) {
    const m = n.desc?.match(/^(.*), Deck (\d)$/);
    if (!m) continue;
    const label = m[1];
    const deck = Number(m[2]);
    const d = decks.get(deck) ?? { deck, sliders: {} };
    decks.set(deck, d);
    const v = n.value?.trim();
    switch (label) {
      case "Title":
        if (v && !d.title) d.title = v;
        break;
      case "Artist":
        if (v && !d.artist) d.artist = v;
        break;
      case "Remaining time":
      case "Elapsed time":
        if (v && !d.time) {
          d.time = v;
          d.timeIsRemaining = label === "Remaining time";
        }
        break;
      case "Key":
        if (v && v !== "-" && !d.key) d.key = v.replace(/\s+/g, "");
        break;
      case "Key Lock on-off":
        d.keyLock = v === "Active";
        break;
      case "Loop":
        if (n.title) d.loopLength = n.title;
        break;
      case "Skip Forward":
        if (v) d.beatJump = v;
        break;
      default:
        if (n.role === "AXSlider" && v) {
          if (label === "Tempo") d.tempoPercent = pct(v);
          if (!(label in d.sliders)) d.sliders[label] = v;
        } else if (n.role === "AXButton" && /^\d+(\.\d+)?$/.test(label) && d.bpm === undefined) {
          d.bpm = parseFloat(label);
        }
    }
  }
  return [...decks.values()].sort((a, b) => a.deck - b.deck);
}

export function findNode(nodes: AXNode[], test: (n: AXNode) => boolean): AXNode | undefined {
  return nodes.find(test);
}
