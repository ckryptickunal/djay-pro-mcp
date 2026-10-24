// Generates one .djayMidiMapping per virtual port and an address map the server uses at runtime.
//
// Address plan per port (no two bindings share an address in the same direction):
//   notes   ch0..15 x 0..127   buttons (input + their on/off state echo) and state-only outputs
//   cc 0-31 (+32 LSB)          absolute controls as 14-bit pairs; their value echoes on the MSB
//   cc 64-119 input            relative (rotary-64) controls, which never echo
//   cc 64-119 output           extra value outputs (meters, progress)
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Catalog, Feature, deckPath, loadCatalog, mappingKeyPath } from "./catalog.js";
import {
  ADDRESS_MAP_FILE,
  DATA_DIR,
  GLOBAL_PORT,
  USER_MAPPINGS_DIR,
  isOwnMappingFile,
  deckPort,
} from "./paths.js";
import { writeXmlPlist } from "./plist.js";

export type InputType = "note" | "cc14" | "rel";

export interface InputBinding {
  port: string;
  type: InputType;
  ch: number;
  data: number;
}

export interface FeedbackBinding {
  path: string;
  kind: "bool" | "value";
  role: "state" | "value" | "enabled" | "extra";
  feature?: string;
  deck?: number;
}

export interface AddressMap {
  schema: 1;
  generatedAt: string;
  appVersion: string;
  appBuild: string;
  ports: string[];
  /** key: `${featureId}|${deck or 0}|${param ?? ""}` */
  inputs: Record<string, InputBinding>;
  /** key: `${port}|${"n" | "c"}|${ch}|${data}` */
  feedback: Record<string, FeedbackBinding>;
  counts: Record<string, { notes: number; cc14: number; rel: number; out7: number }>;
}

export const inputKey = (feature: string, deck = 0, param?: number) => `${feature}|${deck}|${param ?? ""}`;
export const feedbackKey = (port: string, msg: "n" | "c", ch: number, data: number) => `${port}|${msg}|${ch}|${data}`;

/** Outputs djay can report that no single feature covers. Paths are generic (turntable.* = per deck). */
const DECK_EXTRA_BOOL = [
  "turntable.isPlaying",
  "turntable.song.loadingSuccess",
  "turntable.isSyncMaster",
  "turntable.deckSlip",
  "turntable.isSlipping",
  "turntable.looping",
  "turntable.preservesPitch",
  "turntable.display.isApproachingEndOfSong",
  "turntable.display.showElapsedTime",
  "turntable.isTouchOnTurntable",
  "turntable.isTraditionalCueSettable",
];
const DECK_EXTRA_VALUE = [
  "turntable.monoMeter",
  "turntable.display.songProgress",
  "turntable.effects.tempo.currentValue",
  "turntable.effects.pitch.currentValue",
];
const GLOBAL_EXTRA_BOOL = ["automix"];
const GLOBAL_EXTRA_VALUE = ["mixer.masterLeftMeter", "mixer.masterRightMeter"];

class PortBuilder {
  notes = 0;
  cc14 = 0;
  rel = 0;
  out7 = 0;
  controls: any[] = [];
  outputs: any[] = [];
  highRes: number[][] = [];
  private lastHeading = "";

  constructor(readonly port: string, readonly map: AddressMap) {}

  note(): { ch: number; data: number } {
    if (this.notes >= 2048) throw new Error(`${this.port}: out of note addresses`);
    const i = this.notes++;
    return { ch: Math.floor(i / 128), data: i % 128 };
  }
  cc14Slot(): { ch: number; data: number } {
    if (this.cc14 >= 512) throw new Error(`${this.port}: out of 14-bit CC addresses`);
    const i = this.cc14++;
    const ch = Math.floor(i / 32);
    const data = i % 32;
    (this.highRes[ch] ??= []).push(data + 32);
    return { ch, data };
  }
  relSlot(): { ch: number; data: number } {
    if (this.rel >= 16 * 56) throw new Error(`${this.port}: out of relative CC addresses`);
    const i = this.rel++;
    return { ch: Math.floor(i / 56), data: 64 + (i % 56) };
  }
  out7Slot(): { ch: number; data: number } {
    if (this.out7 >= 16 * 56) throw new Error(`${this.port}: out of output CC addresses`);
    const i = this.out7++;
    return { ch: Math.floor(i / 56), data: 64 + (i % 56) };
  }

  heading(title: string) {
    if (title !== this.lastHeading) {
      this.controls.push({ headingTitle: title });
      this.lastHeading = title;
    }
  }

  addFeature(f: Feature, deck: number | undefined) {
    const keyPath = mappingKeyPath(f, deck);
    const abs = (p?: string) => (p ? (deck ? deckPath(p, deck) : p) : undefined);
    const d = deck ?? 0;
    this.heading(`${f.category === "turntable" ? `Deck ${deck}` : f.category} · ${f.section}`);

    if (f.kind === "control") {
      const a = this.cc14Slot();
      const c: any = { keyPath, midiChannel: a.ch, midiData: a.data, midiMessageType: 3, suppressAutoSelect: true };
      if (f.value) {
        c.output = { controlType: "control" };
        this.map.feedback[feedbackKey(this.port, "c", a.ch, a.data)] = {
          path: abs(f.value)!, kind: "value", role: "value", feature: f.id, deck,
        };
      }
      this.controls.push(c);
      this.map.inputs[inputKey(f.id, d)] = { port: this.port, type: "cc14", ch: a.ch, data: a.data };
      if (f.state) this.addOutput(abs(f.state)!, "bool", "state", f.id, deck);
      return;
    }

    if (f.kind === "rotary") {
      const a = this.relSlot();
      this.controls.push({
        keyPath, midiChannel: a.ch, midiData: a.data, midiMessageType: 3, controlType: "rotary-64", suppressAutoSelect: true,
      });
      this.map.inputs[inputKey(f.id, d)] = { port: this.port, type: "rel", ch: a.ch, data: a.data };
      return;
    }

    if (f.param) {
      for (let p = f.param.min; p <= f.param.max; p++) {
        const a = this.note();
        this.controls.push({
          keyPath, midiChannel: a.ch, midiData: a.data, midiMessageType: 1, actionParameter: p, suppressAutoSelect: true,
        });
        this.map.inputs[inputKey(f.id, d, p)] = { port: this.port, type: "note", ch: a.ch, data: a.data };
      }
      return;
    }

    const a = this.note();
    const c: any = { keyPath, midiChannel: a.ch, midiData: a.data, midiMessageType: 1, suppressAutoSelect: true };
    if (f.state) {
      c.output = {};
      this.map.feedback[feedbackKey(this.port, "n", a.ch, a.data)] = {
        path: abs(f.state)!, kind: "bool", role: "state", feature: f.id, deck,
      };
    }
    this.controls.push(c);
    this.map.inputs[inputKey(f.id, d)] = { port: this.port, type: "note", ch: a.ch, data: a.data };
  }

  private outputPaths = new Set<string>();

  addOutput(path: string, kind: "bool" | "value", role: FeedbackBinding["role"], feature?: string, deck?: number) {
    if (this.outputPaths.has(path)) return;
    this.outputPaths.add(path);
    if (kind === "bool") {
      const a = this.note();
      this.outputs.push({ keyPath: path, midiChannel: a.ch, midiData: a.data, midiMessageType: 1 });
      this.map.feedback[feedbackKey(this.port, "n", a.ch, a.data)] = { path, kind, role, feature, deck };
    } else {
      const a = this.out7Slot();
      this.outputs.push({ keyPath: path, controlType: "control", midiChannel: a.ch, midiData: a.data, midiMessageType: 3 });
      this.map.feedback[feedbackKey(this.port, "c", a.ch, a.data)] = { path, kind, role, feature, deck };
    }
  }

  toPlist() {
    const highResControls: number[][] = [];
    for (let ch = 0; ch < this.highRes.length; ch++) highResControls.push(this.highRes[ch] ?? []);
    const hash = createHash("md5").update(this.port).digest("hex");
    const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`.toUpperCase();
    return {
      endpointName: [this.port],
      editor: "djay-pro-mcp",
      schemeVersion: 1,
      version: 1,
      uuid,
      userInfo: { highResControls },
      controls: this.controls,
      outputs: this.outputs,
    };
  }
}

export function buildMappings(cat: Catalog = loadCatalog()): { map: AddressMap; plists: Record<string, any> } {
  const map: AddressMap = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    appVersion: cat.appVersion,
    appBuild: cat.appBuild,
    ports: [GLOBAL_PORT, deckPort(1), deckPort(2), deckPort(3), deckPort(4)],
    inputs: {},
    feedback: {},
    counts: {},
  };
  const builders: PortBuilder[] = [];

  const global = new PortBuilder(GLOBAL_PORT, map);
  for (const f of cat.features) if (!f.perDeck) global.addFeature(f, undefined);
  for (const p of GLOBAL_EXTRA_BOOL) global.addOutput(p, "bool", "extra");
  for (const p of GLOBAL_EXTRA_VALUE) global.addOutput(p, "value", "extra");
  for (const f of cat.features) if (!f.perDeck && f.enabled) global.addOutput(f.enabled, "bool", "enabled");
  builders.push(global);

  for (let deck = 1; deck <= 4; deck++) {
    const b = new PortBuilder(deckPort(deck), map);
    for (const f of cat.features) if (f.perDeck) b.addFeature(f, deck);
    for (const p of DECK_EXTRA_BOOL) b.addOutput(deckPath(p, deck), "bool", "extra", undefined, deck);
    for (const p of DECK_EXTRA_VALUE) b.addOutput(deckPath(p, deck), "value", "extra", undefined, deck);
    for (const f of cat.features) if (f.perDeck && f.enabled) b.addOutput(deckPath(f.enabled, deck), "bool", "enabled", undefined, deck);
    builders.push(b);
  }

  const plists: Record<string, any> = {};
  for (const b of builders) {
    plists[b.port] = b.toPlist();
    map.counts[b.port] = { notes: b.notes, cc14: b.cc14, rel: b.rel, out7: b.out7 };
  }
  return { map, plists };
}

/** Writes the mapping files into djay's user mapping folder and the address map into ./data. */
export function installMappings(): { files: string[]; removed: string[]; map: AddressMap } {
  const { map, plists } = buildMappings();
  mkdirSync(USER_MAPPINGS_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const wanted = new Set(Object.keys(plists).map((p) => `${p}.djayMidiMapping`));
  const removed: string[] = [];
  for (const name of readdirSync(USER_MAPPINGS_DIR)) {
    if (isOwnMappingFile(name) && !wanted.has(name)) {
      rmSync(join(USER_MAPPINGS_DIR, name));
      removed.push(name);
    }
  }
  const files: string[] = [];
  for (const [port, plist] of Object.entries(plists)) {
    const file = join(USER_MAPPINGS_DIR, `${port}.djayMidiMapping`);
    writeXmlPlist(file, plist);
    files.push(file);
  }
  writeFileSync(ADDRESS_MAP_FILE, JSON.stringify(map));
  return { files, removed, map };
}

export function removeMappings(): string[] {
  const removed: string[] = [];
  try {
    for (const name of readdirSync(USER_MAPPINGS_DIR)) {
      if (isOwnMappingFile(name)) {
        rmSync(join(USER_MAPPINGS_DIR, name));
        removed.push(name);
      }
    }
  } catch {
    /* folder missing */
  }
  return removed;
}
