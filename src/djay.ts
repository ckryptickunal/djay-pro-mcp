// High-level controller: one object that owns the MIDI bridge, the accessibility bridge,
// the library reader and the app lifecycle, and resolves feature names to MIDI bindings.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AX, DeckReadout, parseDecks } from "./ax.js";
import { Catalog, Feature, deckPath, loadCatalog, readJson, searchFeatures } from "./catalog.js";
import { Library } from "./library/library.js";
import { AddressMap, installMappings } from "./mapping.js";
import { Midi, StateEntry } from "./midi.js";
import { ADDRESS_MAP_FILE, ALL_PORTS, APP_PATH, RECORDINGS_DIR, USER_MAPPINGS_DIR, WINDOWS_TOOL } from "./paths.js";

const run = promisify(execFile);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DjayError extends Error {}

export class Djay {
  readonly catalog: Catalog;
  readonly ax = new AX();
  readonly lib = new Library();
  map?: AddressMap;
  midi?: Midi;

  constructor() {
    this.catalog = loadCatalog();
    this.map = readJson<AddressMap>(ADDRESS_MAP_FILE);
  }

  // ---------- setup & lifecycle ----------

  mappingStatus() {
    const files = ALL_PORTS.map((p) => join(USER_MAPPINGS_DIR, `${p}.djayMidiMapping`));
    const present = files.filter((f) => existsSync(f));
    const upToDate = !!this.map && this.map.appBuild === this.catalog.appBuild && present.length === files.length;
    let installedAt: string | undefined;
    if (present.length) installedAt = statSync(present[0]).mtime.toISOString();
    return {
      installed: present.length === files.length,
      upToDate,
      mapAppVersion: this.map?.appVersion,
      appVersion: this.catalog.appVersion,
      files: present,
      installedAt,
    };
  }

  install() {
    const res = installMappings();
    this.map = res.map;
    this.midi?.setMap(res.map);
    return res;
  }

  async startMidi(): Promise<Midi> {
    if (!this.map) throw new DjayError("MIDI mappings are not installed yet. Call djay_setup first.");
    if (!this.midi) this.midi = new Midi(this.map);
    await this.midi.start();
    // Messages sent before djay attaches to new virtual ports are lost, so wait for its first feedback.
    if (!this.midi.connected && (await this.isRunning())) await this.midi.waitConnected(5000);
    return this.midi;
  }

  async isRunning(): Promise<boolean> {
    try {
      execFileSync("/usr/bin/pgrep", ["-x", "djay Pro"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Launches djay without stealing focus and waits for its window. */
  async launch(foreground = false): Promise<void> {
    if (!(await this.isRunning())) {
      await run("/usr/bin/open", foreground ? ["-a", APP_PATH] : ["-g", "-a", APP_PATH]);
    } else if (foreground) {
      await run("/usr/bin/open", ["-a", APP_PATH]);
    }
    for (let i = 0; i < 60; i++) {
      try {
        const nodes = await this.ax.snapshot(false, 50);
        if (nodes.length > 5) return;
      } catch {
        /* not ready */
      }
      await sleep(500);
    }
    throw new DjayError("djay Pro did not finish launching within 30 s");
  }

  async quit(): Promise<void> {
    if (!(await this.isRunning())) return;
    await run("/usr/bin/osascript", ["-e", 'tell application "djay Pro" to quit']);
    for (let i = 0; i < 40; i++) {
      if (!(await this.isRunning())) return;
      await sleep(500);
    }
    throw new DjayError("djay Pro did not quit (a dialog may be open)");
  }

  async anyDeckPlaying(): Promise<number[]> {
    const playing: number[] = [];
    for (let d = 1; d <= 4; d++) {
      const e = this.midi?.get(`turntable${d}.isPlaying`);
      if (e && e.value > 0) playing.push(d);
    }
    return playing;
  }

  // ---------- feature resolution ----------

  feature(name: string): Feature {
    const c = this.catalog;
    const exact = c.byId.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    const bySuffix = c.features.filter((f) => f.id.toLowerCase().endsWith(`.${lower}`));
    if (bySuffix.length === 1) return bySuffix[0];
    const byTitle = c.features.filter((f) => f.title.toLowerCase() === lower);
    if (byTitle.length === 1) return byTitle[0];
    const pool = bySuffix.length ? bySuffix : byTitle.length ? byTitle : searchFeatures(c, { query: name, limit: 8 }).items;
    const hint = pool.slice(0, 8).map((f) => `${f.id} (${f.title})`).join("; ");
    throw new DjayError(`Unknown or ambiguous feature '${name}'.${hint ? ` Did you mean: ${hint}` : " Use djay_features to search."}`);
  }

  private needDeck(f: Feature, deck?: number): number {
    if (!f.perDeck) return 0;
    if (!deck || deck < 1 || deck > 4) throw new DjayError(`'${f.id}' is a per-deck feature: pass deck 1-4.`);
    return deck;
  }

  private binding(f: Feature, deck: number, param?: number) {
    if (!this.midi) throw new DjayError("MIDI bridge is not running");
    if (f.param && param === undefined) throw new DjayError(`'${f.id}' needs a param between ${f.param.min} and ${f.param.max}.`);
    if (f.param && (param! < f.param.min || param! > f.param.max)) throw new DjayError(`param must be ${f.param.min}..${f.param.max}`);
    const b = this.midi.binding(f.id, deck, f.param ? param : undefined);
    if (!b) throw new DjayError(`No MIDI binding for '${f.id}'. Re-run djay_setup (mappings may be from an older djay version).`);
    return b;
  }

  statePath(f: Feature, deck: number): string | undefined {
    return f.state ? (deck ? deckPath(f.state, deck) : f.state) : undefined;
  }
  valuePath(f: Feature, deck: number): string | undefined {
    return f.value ? (deck ? deckPath(f.value, deck) : f.value) : undefined;
  }

  read(f: Feature, deck = 0) {
    const d = this.needDeck(f, deck);
    const s = this.statePath(f, d);
    const v = this.valuePath(f, d);
    const en = f.enabled ? (d ? deckPath(f.enabled, d) : f.enabled) : undefined;
    const st = s ? this.midi?.get(s) : undefined;
    const val = v ? this.midi?.get(v) : undefined;
    const ena = en ? this.midi?.get(en) : undefined;
    return {
      feature: f.id,
      title: f.title,
      deck: d || undefined,
      kind: f.kind,
      state: st ? st.value > 0 : undefined,
      value: val ? round(val.value) : undefined,
      enabled: ena ? ena.value > 0 : undefined,
    };
  }

  // ---------- generic control ----------

  /**
   * Presses a button feature. mode: tap (press+release), press, release, on/off (toggles only
   * press when the reported state differs), or hold for holdMs.
   */
  async trigger(
    name: string,
    opts: { deck?: number; param?: number; mode?: "tap" | "press" | "release" | "on" | "off" | "hold"; holdMs?: number; statePath?: string } = {},
  ) {
    await this.startMidi();
    const f = this.feature(name);
    if (f.kind === "control" || f.kind === "rotary") throw new DjayError(`'${f.id}' is a continuous control; use djay_set.`);
    const deck = this.needDeck(f, opts.deck);
    const b = this.binding(f, deck, opts.param);
    const mode = opts.mode ?? "tap";
    // statePath overrides the feature's own state (e.g. a button's LED state is not always the true state).
    const sp = opts.statePath ?? this.statePath(f, deck);
    const before = sp ? this.midi!.get(sp) : undefined;

    const report = (extra: Record<string, unknown>) => {
      const r: Record<string, unknown> = { ...this.read(f, deck), ...extra };
      if (opts.statePath) {
        const e = this.midi!.get(opts.statePath);
        r.state = e ? e.value > 0 : undefined;
      }
      return r;
    };

    if (mode === "on" || mode === "off") {
      const want = mode === "on";
      if (before && before.value > 0 === want) return report({ changed: false });
      await this.midi!.tap(b);
    } else if (mode === "press") this.midi!.note(b, true);
    else if (mode === "release") this.midi!.note(b, false);
    else if (mode === "hold") {
      this.midi!.note(b, true);
      await sleep(Math.max(30, opts.holdMs ?? 500));
      this.midi!.note(b, false);
    } else await this.midi!.tap(b);

    if (mode === "on" || mode === "off") {
      const want = mode === "on";
      const after = sp ? await this.midi!.waitFor(sp, (e) => e.value > 0 === want, 800) : undefined;
      const r = report({ changed: true });
      if (sp && !after) {
        return {
          ...r,
          warning: `djay did not switch '${f.title}' ${mode}. The feature may be unavailable right now (no track loaded, not supported for this track or source, or locked behind a djay subscription).`,
        };
      }
      return r;
    }
    if (sp) await this.midi!.waitFor(sp, (e) => !before || e.at > before.at, 400);
    else await sleep(30);
    return report({ changed: true });
  }

  /** Play or pause using djay's real playing flag (the play button LED can be lit while paused). */
  async setPlaying(deck: number, playing: boolean) {
    await this.startMidi();
    const path = `turntable${deck}.isPlaying`;
    if (!this.midi!.get(path)) await this.midi!.waitFor(path, () => true, 1500);
    if (!this.midi!.get(path)) {
      throw new DjayError(`djay has not reported whether deck ${deck} is playing, so play/pause was not sent (a blind toggle could start playback). Check djay_status.`);
    }
    return this.trigger("turntable.playPause", { deck, mode: playing ? "on" : "off", statePath: `turntable${deck}.isPlaying` });
  }

  /** Sets a continuous control to value 0..1 (0.5 is centre for EQ, filter, tempo, pan). */
  async set(name: string, value: number, deck?: number) {
    await this.startMidi();
    const f = this.feature(name);
    const d = this.needDeck(f, deck);
    if (f.kind === "rotary") throw new DjayError(`'${f.id}' is a relative encoder; use djay_set with 'steps'.`);
    if (f.kind !== "control") throw new DjayError(`'${f.id}' is a button; use djay_trigger.`);
    const b = this.binding(f, d);
    this.midi!.setControl(b, value);
    const vp = this.valuePath(f, d);
    if (vp) await this.midi!.waitFor(vp, (e) => Math.abs(e.value - value) < 0.02, 300);
    return this.read(f, d);
  }

  async turn(name: string, steps: number, deck?: number) {
    await this.startMidi();
    const f = this.feature(name);
    const d = this.needDeck(f, deck);
    if (f.kind !== "rotary") throw new DjayError(`'${f.id}' is not a relative encoder.`);
    await this.midi!.turn(this.binding(f, d), steps);
    return { feature: f.id, deck: d || undefined, steps };
  }

  /** Smoothly moves a control from its current (or given) value to `to` over durationMs. */
  async ramp(name: string, to: number, durationMs: number, opts: { deck?: number; from?: number; curve?: "linear" | "ease" ; signal?: AbortSignal } = {}) {
    await this.startMidi();
    const f = this.feature(name);
    const d = this.needDeck(f, opts.deck);
    const b = this.binding(f, d);
    const vp = this.valuePath(f, d);
    const from = opts.from ?? (vp ? this.midi!.get(vp)?.value : undefined) ?? to;
    const steps = Math.max(1, Math.round(durationMs / 25));
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      if (opts.signal?.aborted) break;
      let x = i / steps;
      if (opts.curve === "ease") x = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
      this.midi!.setControl(b, from + (to - from) * x);
      const due = t0 + (durationMs * i) / steps;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
    return this.read(f, d);
  }

  stateEntries(filter?: { deck?: number; prefix?: string; role?: string }): StateEntry[] {
    const all = [...(this.midi?.state.values() ?? [])];
    return all.filter(
      (e) =>
        (!filter?.deck || e.deck === filter.deck) &&
        (!filter?.prefix || e.path.startsWith(filter.prefix)) &&
        (!filter?.role || e.role === filter.role),
    );
  }

  // ---------- deck & mixer state ----------

  async readouts(): Promise<DeckReadout[]> {
    try {
      return parseDecks(await this.ax.snapshot(false, 6000));
    } catch {
      return [];
    }
  }

  async deck(n: number) {
    await this.startMidi().catch(() => undefined);
    const ro = (await this.readouts()).find((r) => r.deck === n);
    const g = (p: string) => this.midi?.get(`turntable${n}.${p}`);
    const bool = (p: string) => (g(p) ? g(p)!.value > 0 : undefined);
    const val = (p: string) => (g(p) ? round(g(p)!.value) : undefined);
    const lv = this.midi?.get(`mixer.volumeEffectChannel${n}.currentValue`);
    return {
      deck: n,
      loaded: bool("song.loadingSuccess") ?? !!ro?.title,
      title: ro?.title,
      artist: ro?.artist,
      bpm: ro?.bpm,
      key: ro?.key,
      time: ro?.time,
      timeIsRemaining: ro?.timeIsRemaining,
      progress: val("display.songProgress"),
      playing: bool("isPlaying"),
      synced: bool("syncButtonState"),
      syncMaster: bool("isSyncMaster"),
      keyLock: ro?.keyLock ?? bool("preservesPitch"),
      looping: bool("looping"),
      slip: bool("deckSlip"),
      nearEnd: bool("display.isApproachingEndOfSong"),
      tempoPercent: ro?.tempoPercent,
      level: val("monoMeter"),
      lineVolume: lv ? round(lv.value) : undefined,
      eq: {
        high: val("highEQEffect.currentValue"),
        mid: val("midEQEffect.currentValue"),
        low: val("lowEQEffect.currentValue"),
      },
      filter: val("effects.filter.currentValue"),
      gain: val("effects.gain.currentValue"),
      loopLength: ro?.loopLength,
      beatJump: ro?.beatJump,
      readouts: ro?.sliders,
    };
  }

  mixer() {
    const g = (p: string) => this.midi?.get(p);
    const v = (p: string) => (g(p) ? round(g(p)!.value) : undefined);
    return {
      crossfader: v("mixer.masterCrossfade"),
      master: v("mixer.masterVolume"),
      masterMeter: { left: v("mixer.masterLeftMeter"), right: v("mixer.masterRightMeter") },
      lineVolume: [1, 2, 3, 4].map((n) => v(`mixer.volumeEffectChannel${n}.currentValue`)),
      automix: g("automix") ? g("automix")!.value > 0 : undefined,
      recording: g("recording") ? g("recording")!.value > 0 : undefined,
    };
  }

  // ---------- misc ----------

  recordings(limit = 20) {
    if (!existsSync(RECORDINGS_DIR)) return [];
    return readdirSync(RECORDINGS_DIR)
      .filter((f) => /\.(m4a|wav|aiff?|mp3|caf)$/i.test(f))
      .map((f) => {
        const s = statSync(join(RECORDINGS_DIR, f));
        return { file: join(RECORDINGS_DIR, f), bytes: s.size, modified: s.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, limit);
  }

  async mainWindowId(): Promise<number | undefined> {
    const { stdout } = await run(WINDOWS_TOOL, ["djay Pro"]);
    const wins = JSON.parse(stdout) as { id: number; name: string; onscreen: boolean; w: number; h: number }[];
    const main = wins.find((w) => w.name === "djay Pro") ?? wins.filter((w) => w.onscreen).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    return main?.id;
  }

  shutdown() {
    this.midi?.stop();
    this.ax.stop();
  }
}

export const round = (x: number, p = 3) => Math.round(x * 10 ** p) / 10 ** p;
