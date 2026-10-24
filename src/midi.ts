// Talks to the Swift MIDI bridge: sends control messages to djay and decodes djay's feedback.
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { AddressMap, FeedbackBinding, InputBinding, feedbackKey, inputKey } from "./mapping.js";
import { MIDI_BRIDGE } from "./paths.js";

export interface StateEntry {
  path: string;
  value: number; // 0..1 for values, 0/1 for booleans
  raw: number; // 0..127 as received
  kind: "bool" | "value";
  role: FeedbackBinding["role"];
  feature?: string;
  deck?: number;
  at: number; // ms timestamp
}

type Waiter = { path: string; test: (e: StateEntry) => boolean; resolve: (e: StateEntry | undefined) => void; timer: NodeJS.Timeout };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Midi {
  private proc?: ChildProcessWithoutNullStreams;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  readonly state = new Map<string, StateEntry>();
  private waiters: Waiter[] = [];
  lastFeedbackAt = 0;
  startedAt = 0;
  lastError?: string;
  private stopping = false;

  constructor(private map: AddressMap) {}

  get running() {
    return this.ready && !!this.proc && this.proc.exitCode === null;
  }

  setMap(map: AddressMap) {
    this.map = map;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!existsSync(MIDI_BRIDGE)) throw new Error(`MIDI bridge not built (${MIDI_BRIDGE}). Run: npm run build`);
    this.stopping = false;
    this.ready = false;
    this.startedAt = Date.now();
    const proc = spawn(MIDI_BRIDGE, this.map.ports, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on("line", (line) => (this.lastError = line));
    proc.on("exit", (code) => {
      this.ready = false;
      if (!this.stopping) {
        this.lastError = `bridge exited (${code}); restarting`;
        setTimeout(() => this.start().catch((e) => (this.lastError = String(e))), 1000);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("MIDI bridge did not start")), 5000);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  stop() {
    this.stopping = true;
    this.proc?.stdin.end();
    this.proc?.kill();
    this.ready = false;
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ev === "ready") {
      this.ready = true;
      this.readyWaiters.splice(0).forEach((f) => f());
    } else if (msg.ev === "midi") {
      this.decode(msg.port, msg.bytes as number[]);
    } else if (msg.ev === "error") {
      this.lastError = msg.message;
    }
  }

  private decode(port: string, bytes: number[]) {
    let i = 0;
    while (i < bytes.length) {
      const st = bytes[i];
      const kind = st & 0xf0;
      const ch = st & 0x0f;
      const len = kind === 0xc0 || kind === 0xd0 ? 2 : st >= 0xf0 ? 1 : 3;
      if (kind === 0x90 || kind === 0x80 || kind === 0xb0) {
        const d1 = bytes[i + 1];
        const d2 = kind === 0x80 ? 0 : bytes[i + 2];
        const b = this.map.feedback[feedbackKey(port, kind === 0xb0 ? "c" : "n", ch, d1)];
        if (b) this.ingest(b, d2);
      }
      i += len;
    }
  }

  private ingest(b: FeedbackBinding, raw: number) {
    const now = Date.now();
    this.lastFeedbackAt = now;
    const e: StateEntry = {
      path: b.path,
      raw,
      // 7-bit feedback: 0 -> 0, 64 -> 0.5 (centre detent), 127 -> 1.
      value: b.kind === "bool" ? (raw > 0 ? 1 : 0) : raw <= 64 ? raw / 128 : 0.5 + (raw - 64) / 126,
      kind: b.kind,
      role: b.role,
      feature: b.feature,
      deck: b.deck,
      at: now,
    };
    this.state.set(b.path, e);
    this.waiters = this.waiters.filter((w) => {
      if (w.path === b.path && w.test(e)) {
        clearTimeout(w.timer);
        w.resolve(e);
        return false;
      }
      return true;
    });
  }

  /** Resolves when the path reports a value passing `test` (or immediately if it already does). */
  waitFor(path: string, test: (e: StateEntry) => boolean, timeoutMs = 3000): Promise<StateEntry | undefined> {
    const cur = this.state.get(path);
    if (cur && test(cur)) return Promise.resolve(cur);
    return new Promise((resolve) => {
      const w: Waiter = {
        path,
        test,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(undefined);
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  /** djay sends a burst of state when it connects to the ports; that tells us it is listening. */
  get connected(): boolean {
    return this.lastFeedbackAt >= this.startedAt && this.lastFeedbackAt > 0;
  }

  async waitConnected(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (!this.connected && Date.now() < end) await sleep(100);
    return this.connected;
  }

  binding(feature: string, deck = 0, param?: number): InputBinding | undefined {
    return this.map.inputs[inputKey(feature, deck, param)];
  }

  sendRaw(port: string, bytes: number[]) {
    if (!this.running) throw new Error("MIDI bridge is not running");
    this.proc!.stdin.write(JSON.stringify({ op: "send", port, bytes }) + "\n");
  }

  /** Button press/release. velocity 127 = down, 0 = up. */
  note(b: InputBinding, down: boolean) {
    this.sendRaw(b.port, [0x90 | b.ch, b.data, down ? 127 : 0]);
  }

  async tap(b: InputBinding, holdMs = 25) {
    this.note(b, true);
    await sleep(holdMs);
    this.note(b, false);
  }

  /** Absolute control, value 0..1, sent as a 14-bit MSB/LSB pair. */
  setControl(b: InputBinding, value: number) {
    const v = Math.round(Math.min(1, Math.max(0, value)) * 16383);
    this.sendRaw(b.port, [0xb0 | b.ch, b.data, v >> 7, 0xb0 | b.ch, b.data + 32, v & 0x7f]);
  }

  /** Relative (rotary-64) control: positive steps turn right / down the list, negative left / up. */
  async turn(b: InputBinding, steps: number) {
    let left = Math.round(steps);
    while (left !== 0) {
      const chunk = Math.max(-63, Math.min(63, left));
      this.sendRaw(b.port, [0xb0 | b.ch, b.data, 64 + chunk]);
      left -= chunk;
      if (left !== 0) await sleep(15);
    }
  }

  get(path: string): StateEntry | undefined {
    return this.state.get(path);
  }
}
