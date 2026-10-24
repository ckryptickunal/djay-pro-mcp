// Builds the list of every djay feature that can be driven over MIDI, straight from
// the installed app's own resource files, so it follows app updates automatically:
//   MidiMappingMenu.plist     categories, sections and button-vs-continuous split
//   MidiModelMetadata.plist   behaviour type plus the model paths djay reports back
//   MidiModelKeyPath.strings  human-readable titles
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_PATH, APP_RESOURCES } from "./paths.js";
import { readPlist } from "./plist.js";

export type Kind = "action" | "toggle" | "hold" | "trigger" | "control" | "rotary";

export interface Feature {
  /** Generic key path, e.g. "turntable.playPause", "mixer.crossfade". Deck features start with "turntable.". */
  id: string;
  title: string;
  category: string;
  section: string;
  kind: Kind;
  /** true when the feature exists once per deck (turntable.*). */
  perDeck: boolean;
  /** Model path that reports on/off state (generic form for deck features). */
  state?: string;
  /** Model path that reports the continuous value. */
  value?: string;
  /** Model path that says whether the feature is currently usable. */
  enabled?: string;
  /** Model path holding a text label (sample names, etc.). */
  label?: string;
  /** For features that take a numeric argument (FX index, semitones, view mode). */
  param?: { min: number; max: number };
}

export interface Catalog {
  appVersion: string;
  appBuild: string;
  features: Feature[];
  byId: Map<string, Feature>;
}

const CATEGORY_ORDER = ["turntable", "mixer", "application", "musicLibrary", "sampler", "looper", "microphone"];
const SKIP_IDS = new Set(["application", "mixer", "musicLibrary", "turntable", "sampler", "looper", "microphone", "customProcessor"]);

// djay allows up to 121 FX per slot; favourites lists are short.
const PARAM_LIMITS: Record<string, { min: number; max: number }> = {
  "turntable.fx1SelectFavorite": { min: 0, max: 31 },
  "turntable.fx2SelectFavorite": { min: 0, max: 31 },
  "turntable.fx3SelectFavorite": { min: 0, max: 31 },
};

function humanize(id: string): string {
  const last = id.split(".").slice(1).join(" ") || id;
  return last
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

export function appVersion(): { version: string; build: string } {
  const info = readPlist<Record<string, string>>(join(APP_PATH, "Contents", "Info.plist"));
  return { version: info.CFBundleShortVersionString, build: info.CFBundleVersion };
}

function kindFor(id: string, metaType: string | undefined, isControl: boolean): Kind {
  if (isControl || metaType === "control") {
    return /(Rotary|Move)$/.test(id) ? "rotary" : "control";
  }
  switch (metaType) {
    case "button-toggle":
      return "toggle";
    case "button-hold":
      return "hold";
    case "button-trigger":
      return "trigger";
    default:
      return "action";
  }
}

let cached: Catalog | undefined;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  if (!existsSync(APP_RESOURCES)) throw new Error(`djay Pro not found at ${APP_PATH}`);
  const { version, build } = appVersion();
  const menu = readPlist<Record<string, Record<string, string[]>>>(join(APP_RESOURCES, "MidiMappingMenu.plist"));
  const meta = readPlist<Record<string, any>>(join(APP_RESOURCES, "MidiModelMetadata.plist"));
  const titles = readPlist<Record<string, string>>(join(APP_RESOURCES, "MidiModelKeyPath.strings"));

  const features: Feature[] = [];
  const byId = new Map<string, Feature>();

  const add = (id: string, category: string, section: string, isControl: boolean) => {
    if (byId.has(id) || SKIP_IDS.has(id)) return;
    const m = meta[id] ?? {};
    const f: Feature = {
      id,
      title: titles[id] ?? humanize(id),
      category,
      section,
      kind: kindFor(id, m.type, isControl),
      perDeck: category === "turntable",
    };
    if (m.modelState) f.state = m.modelState;
    if (m.modelValue) f.value = m.modelValue;
    if (m.modelEnabled) f.enabled = m.modelEnabled;
    if (m.modelDescription) f.label = m.modelDescription;
    if (m.hasActionParameter) {
      f.param = PARAM_LIMITS[id] ?? { min: m.actionParameterMinValue ?? 0, max: m.actionParameterMaxValue ?? 0 };
    }
    features.push(f);
    byId.set(id, f);
  };

  // 1. Curated menu (buttons, then continuous controls) with its section headings.
  for (const io of ["button", "control"] as const) {
    for (const category of CATEGORY_ORDER) {
      let section = "General";
      for (const entry of menu[io]?.[category] ?? []) {
        if (entry === "-") continue;
        if (entry.startsWith("#")) {
          section = entry.replace(/^#\s*/, "");
          continue;
        }
        add(`${category}.${entry}`, category, section, io === "control");
      }
    }
  }

  // 2. Metadata entries the menu leaves out, then any titled key path left.
  const rest = [...new Set([...Object.keys(meta), ...Object.keys(titles)])].sort();
  for (const id of rest) {
    const category = id.split(".")[0];
    if (!CATEGORY_ORDER.includes(category)) continue;
    add(id, category, "Other", false);
  }

  features.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  cached = { appVersion: version, appBuild: build, features, byId };
  return cached;
}

/** Turns a generic model path into the absolute path for a deck ("turntable.x" -> "turntable2.x"). */
export function deckPath(path: string, deck: number): string {
  return path.replace(/^turntable\./, `turntable${deck}.`);
}

/** The key path written into the mapping file for a feature on a deck. */
export function mappingKeyPath(f: Feature, deck?: number): string {
  return f.perDeck && deck ? deckPath(f.id, deck) : f.id;
}

export function searchFeatures(
  cat: Catalog,
  opts: { query?: string; category?: string; section?: string; kind?: string; limit?: number; offset?: number },
): { total: number; items: Feature[] } {
  const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = cat.features.filter((f) => {
    if (opts.category && f.category !== opts.category && !(opts.category === "deck" && f.perDeck)) return false;
    if (opts.section && f.section.toLowerCase() !== opts.section.toLowerCase()) return false;
    if (opts.kind && f.kind !== opts.kind) return false;
    if (!words.length) return true;
    const hay = `${f.id} ${f.title} ${f.section}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const offset = opts.offset ?? 0;
  return { total: hits.length, items: hits.slice(offset, offset + (opts.limit ?? 100)) };
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
