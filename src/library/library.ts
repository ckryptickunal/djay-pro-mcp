// Read-only access to djay's media library (a YapDatabase / SQLite file of FastCoder records).
// Opened read-only; SQLite's WAL mode lets us read while djay keeps writing.
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { LIBRARY_DB } from "../paths.js";
import { decodeFastCoder } from "./fastcoder.js";

const MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR = ["Am", "Bbm", "Bm", "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m"];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

/** djay key index: root = floor(i/2) semitones above C; even = major, odd = its relative minor. */
export function keyFromIndex(i: number | undefined): { camelot: string; name: string } | undefined {
  if (i === undefined || i === null || i < 0 || i > 23) return undefined;
  const root = Math.floor(i / 2);
  const minor = i % 2 === 1;
  return { camelot: `${CAMELOT_MAJOR[root]}${minor ? "A" : "B"}`, name: minor ? MINOR[root] : MAJOR[root] };
}

/** Camelot keys that mix harmonically with the given one (same, +-1, relative major/minor). */
export function compatibleKeys(camelot: string): string[] {
  const m = camelot.toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!m) return [];
  const n = Number(m[1]);
  const l = m[2];
  const wrap = (x: number) => ((x + 11) % 12) + 1;
  return [`${n}${l}`, `${wrap(n + 1)}${l}`, `${wrap(n - 1)}${l}`, `${n}${l === "A" ? "B" : "A"}`];
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  bpm?: number;
  key?: string;
  keyName?: string;
  isrc?: string;
  playCount?: number;
  colorIndex?: number;
  sources: string[];
  file?: string;
}

export interface HistoryItem {
  title: string;
  artist: string;
  deck?: number;
  startTime?: string;
  source?: string;
  trackId?: string;
}

export interface HistorySession {
  id: string;
  device?: string;
  start?: string;
  end?: string;
  itemCount: number;
  items?: HistoryItem[];
}

type Rec = Record<string, any>;

export class Library {
  private db?: DatabaseSync;
  private stamp = "";
  private tracksCache: Track[] = [];
  private byId = new Map<string, Track>();

  constructor(private path = LIBRARY_DB) {}

  available(): boolean {
    return existsSync(this.path);
  }

  private open(): DatabaseSync {
    if (!this.db) {
      if (!this.available()) throw new Error(`djay library not found at ${this.path}`);
      this.db = new DatabaseSync(this.path, { readOnly: true });
    }
    return this.db;
  }

  private rows(collection: string): { key: string; data: Uint8Array }[] {
    return this.open()
      .prepare("SELECT key, data FROM database2 WHERE collection = ?")
      .all(collection) as { key: string; data: Uint8Array }[];
  }

  private decodeAll(collection: string): Map<string, Rec> {
    const out = new Map<string, Rec>();
    for (const r of this.rows(collection)) {
      try {
        out.set(r.key, decodeFastCoder(r.data).root);
      } catch {
        /* skip undecodable records */
      }
    }
    return out;
  }

  private currentStamp(): string {
    const parts = [this.path, `${this.path}-wal`].map((p) => {
      try {
        const s = statSync(p);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return "-";
      }
    });
    return parts.join("|");
  }

  /** All tracks djay knows (analysed, located or with user data), merged by track id. */
  tracks(): Track[] {
    const stamp = this.currentStamp();
    if (stamp === this.stamp && this.tracksCache.length) return this.tracksCache;
    const byId = new Map<string, Track>();
    const get = (id: string, t?: Rec): Track => {
      let tr = byId.get(id);
      if (!tr) {
        tr = { id, title: t?.title ?? "", artist: t?.artist ?? "", sources: [] };
        byId.set(id, tr);
      }
      if (t) {
        if (!tr.title && t.title) tr.title = t.title;
        if (!tr.artist && t.artist) tr.artist = t.artist;
        if (!tr.duration && t.duration) tr.duration = Math.round(t.duration);
        if (!tr.isrc && t.isrc) tr.isrc = t.isrc;
      }
      return tr;
    };
    const firstTitle = (r: Rec) => (Array.isArray(r.titleIDs) ? r.titleIDs[0] : r.titleID);

    for (const [id, r] of this.decodeAll("mediaItemTitleIDs")) get(id, firstTitle(r) ?? r);
    for (const [id, r] of this.decodeAll("mediaItemAnalyzedData")) {
      const tr = get(id, firstTitle(r));
      const bpm = r.manualBPM ?? r.bpm;
      if (bpm) tr.bpm = Math.round(bpm * 100) / 100;
      const k = keyFromIndex(r.manualKeySignatureIndex ?? r.keySignatureIndex);
      if (k) {
        tr.key = k.camelot;
        tr.keyName = k.name;
      }
    }
    for (const coll of ["globalMediaItemLocations", "localMediaItemLocations"]) {
      for (const [id, r] of this.decodeAll(coll)) {
        const tr = get(id, firstTitle(r));
        for (const u of r.sourceURIs ?? []) {
          if (typeof u !== "string") continue;
          if (u.startsWith("file://")) {
            try {
              tr.file ??= fileURLToPath(u);
            } catch {
              /* ignore */
            }
          } else if (!tr.sources.includes(u)) tr.sources.push(u);
        }
      }
    }
    for (const [id, r] of this.decodeAll("mediaItemUserData")) {
      const tr = get(id, firstTitle(r));
      if (r.playCount) tr.playCount = r.playCount;
      if (r.colorIndex !== undefined) tr.colorIndex = r.colorIndex;
      if (r.manualBPM) tr.bpm = r.manualBPM;
    }
    this.tracksCache = [...byId.values()].filter((t) => t.title);
    this.byId = new Map(this.tracksCache.map((t) => [t.id, t]));
    this.stamp = stamp;
    return this.tracksCache;
  }

  track(id: string): Track | undefined {
    this.tracks();
    return this.byId.get(id);
  }

  search(opts: {
    query?: string;
    bpmMin?: number;
    bpmMax?: number;
    key?: string;
    compatibleWith?: string;
    source?: "spotify" | "apple-music" | "file" | "tidal" | "soundcloud" | "beatport";
    sort?: "relevance" | "bpm" | "playCount" | "title";
    limit?: number;
  }): { total: number; tracks: Track[] } {
    const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const keys = opts.compatibleWith ? new Set(compatibleKeys(opts.compatibleWith)) : undefined;
    let hits = this.tracks().filter((t) => {
      if (words.length) {
        const hay = `${t.title} ${t.artist}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      if (opts.bpmMin !== undefined && !(t.bpm && t.bpm >= opts.bpmMin)) return false;
      if (opts.bpmMax !== undefined && !(t.bpm && t.bpm <= opts.bpmMax)) return false;
      if (opts.key && t.key?.toUpperCase() !== opts.key.toUpperCase() && t.keyName?.toLowerCase() !== opts.key.toLowerCase()) return false;
      if (keys && !(t.key && keys.has(t.key))) return false;
      if (opts.source === "file" && !t.file) return false;
      if (opts.source && opts.source !== "file" && !t.sources.some((s) => s.startsWith(opts.source!))) return false;
      return true;
    });
    const sort = opts.sort ?? "relevance";
    if (sort === "bpm") hits.sort((a, b) => (a.bpm ?? 0) - (b.bpm ?? 0));
    else if (sort === "playCount") hits.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));
    else if (sort === "title") hits.sort((a, b) => a.title.localeCompare(b.title));
    else if (words.length) {
      const q = words.join(" ");
      const score = (t: Track) => (t.title.toLowerCase() === q ? 3 : t.title.toLowerCase().startsWith(q) ? 2 : 1) + (t.playCount ?? 0) / 1000;
      hits.sort((a, b) => score(b) - score(a));
    }
    return { total: hits.length, tracks: hits.slice(0, opts.limit ?? 25) };
  }

  historySessions(limit = 10, withItems = false, sessionId?: string): HistorySession[] {
    const sessions = this.decodeAll("historySessions");
    const items = withItems || sessionId ? this.decodeAll("historySessionItems") : undefined;
    let list = [...sessions.values()].sort((a, b) => String(b.startDate?.$date ?? "").localeCompare(String(a.startDate?.$date ?? "")));
    if (sessionId) list = list.filter((s) => s.uuid === sessionId);
    return list.slice(0, limit).map((s) => {
      const out: HistorySession = {
        id: s.uuid,
        device: s.deviceName,
        start: s.startDate?.$date,
        end: s.endDate?.$date,
        itemCount: (s.itemUUIDs ?? []).length,
      };
      if (items) {
        out.items = (s.itemUUIDs ?? [])
          .map((id: string) => items.get(id))
          .filter(Boolean)
          .map((it: Rec) => ({
            title: it.titleID?.title ?? "",
            artist: it.titleID?.artist ?? "",
            deck: it.deckNumber,
            startTime: it.startTime?.$date,
            source: it.originSourceID,
            trackId: it.titleID?.uuid,
          }));
      }
      return out;
    });
  }

  queue(): { position: number; title: string; artist: string; trackId?: string; isrc?: string; source?: string }[] {
    const queues = this.decodeAll("queues");
    const items = this.decodeAll("queueItems");
    const q = queues.get("queue-default") ?? [...queues.values()][0];
    if (!q) return [];
    return (q.itemUUIDs ?? [])
      .map((id: string) => items.get(id))
      .filter(Boolean)
      .map((it: Rec, i: number) => ({
        position: i + 1,
        title: it.titleID?.title ?? "",
        artist: it.titleID?.artist ?? "",
        trackId: it.titleID?.uuid,
        isrc: it.titleID?.isrc,
        source: it.originSourceID,
      }));
  }

  playlists(): { id: string; name: string; type?: number; children: string[]; trackCount?: number }[] {
    return [...this.decodeAll("mediaItemPlaylists").values()].map((p) => ({
      id: p.uuid,
      name: p.name,
      type: p.type,
      children: p.childUUIDs ?? [],
      trackCount: Array.isArray(p.itemUUIDs) ? p.itemUUIDs.length : undefined,
    }));
  }

  stats() {
    const t = this.tracks();
    return {
      tracks: t.length,
      analysed: t.filter((x) => x.bpm).length,
      localFiles: t.filter((x) => x.file).length,
      streaming: t.filter((x) => x.sources.length).length,
      historySessions: this.rows("historySessions").length,
      queueLength: this.queue().length,
    };
  }
}
