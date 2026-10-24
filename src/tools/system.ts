// Status, setup, app lifecycle, library browsing/loading, menus, raw UI access and screenshots.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AXNode } from "../ax.js";
import { Djay, DjayError, round, sleep } from "../djay.js";
import { buildMappings } from "../mapping.js";
import { ALL_PORTS, APP_PATH, USER_MAPPINGS_DIR } from "../paths.js";
import { toXmlPlist } from "../plist.js";
import { deckSchema, ok, safe } from "./util.js";

const run = promisify(execFile);

interface Row {
  index: number;
  title?: string;
  artist?: string;
  bpm?: string;
  key?: string;
  source?: string;
  selected?: boolean;
  [k: string]: unknown;
}

function parseRows(res: { columns: string[]; rows: { index: number; cells: string[][]; selected: boolean }[] }): Row[] {
  return res.rows.map((r) => {
    const row: Row = { index: r.index };
    if (r.selected) row.selected = true;
    r.cells.forEach((cell, i) => {
      const text = cell.filter((c) => !c.startsWith("[")).join(" ").trim();
      const icon = cell.find((c) => c.startsWith("[icon origin "));
      if (icon) row.source = icon.replace("[icon origin ", "").replace("]", "");
      const col = (res.columns[i] || "").toLowerCase();
      if (!text) return;
      if (col) row[col] = text;
      else if (res.columns.length === 1) row.title = text;
    });
    return row;
  });
}

const norm = (s = "") =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function score(row: Row, title?: string, artist?: string, query?: string): number {
  const rt = norm(row.title);
  const ra = norm(row.artist);
  let s = 0;
  if (title) {
    const t = norm(title);
    s += rt === t ? 6 : rt.startsWith(t) || t.startsWith(rt) ? 4 : rt.includes(t) ? 3 : 0;
  }
  if (artist) {
    const a = norm(artist);
    s += ra.includes(a) || a.includes(ra) ? 3 : a.split(" ").some((w) => w.length > 2 && ra.includes(w)) ? 1 : 0;
  }
  if (query && !title) {
    const q = new Set(norm(query).split(" ").filter(Boolean));
    const tw = rt.split(" ").filter(Boolean);
    const aw = ra.split(" ").filter((w) => w.length > 1);
    const covered = [...q].filter((w) => `${rt} ${ra}`.includes(w)).length / Math.max(1, q.size);
    s += covered * 3;
    if (tw.length && tw.every((w) => q.has(w))) s += 3; // the whole title was asked for
    if (aw.some((w) => q.has(w))) s += 2; // the artist was named
    if (rt === norm(query)) s += 2;
  }
  // Covers, karaoke and tributes only when asked for.
  const asked = norm(`${query ?? ""} ${title ?? ""}`);
  for (const w of ["karaoke", "tribute", "cover", "instrumental", "8 bit", "lullaby"]) {
    if (`${rt} ${ra}`.includes(w) && !asked.includes(w)) s -= 3;
  }
  return s;
}

export function registerSystem(server: McpServer, dj: Djay) {
  // ---------------- status & setup ----------------
  server.registerTool(
    "djay_status",
    {
      title: "djay MCP status",
      description:
        "Health check: is djay Pro installed and running, version, accessibility permission, whether the generated MIDI mappings are installed and current, whether the MIDI bridge is live and receiving djay's feedback, and a short summary of what each deck is playing. Call this first.",
      inputSchema: { library_stats: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ library_stats }) => {
      const running = await dj.isRunning();
      let ax: unknown;
      try {
        ax = await dj.ax.status();
      } catch (e) {
        ax = { error: String(e) };
      }
      let midiError: string | undefined;
      await dj.startMidi().catch((e) => (midiError = String(e?.message ?? e)));
      const decks = running ? (await dj.readouts()).map((r) => ({ deck: r.deck, title: r.title, artist: r.artist, bpm: r.bpm, key: r.key, time: r.time, tempo: r.tempoPercent })) : [];
      const mappings = dj.mappingStatus();
      const fb = dj.midi?.lastFeedbackAt;
      const hints: string[] = [];
      if (!existsSync(APP_PATH)) hints.push(`djay Pro not found at ${APP_PATH}`);
      if (!mappings.installed) hints.push("Run djay_setup to install the MIDI mappings (needs a djay restart).");
      else if (!mappings.upToDate) hints.push("djay was updated since the mappings were generated: run djay_setup with restart_djay.");
      if (running && mappings.installed && !fb) hints.push("No feedback from djay yet. If djay was already open when the mappings were installed, restart it (djay_setup restart_djay: true).");
      if (!running) hints.push("djay Pro is not running: djay_app action launch.");
      return ok({
        app: { path: APP_PATH, version: dj.catalog.appVersion, build: dj.catalog.appBuild, running, accessibility: ax },
        features: dj.catalog.features.length,
        mappings,
        midi: {
          running: dj.midi?.running ?? false,
          ports: ALL_PORTS,
          lastFeedbackAt: fb ? new Date(fb).toISOString() : null,
          stateEntries: dj.midi?.state.size ?? 0,
          error: midiError ?? dj.midi?.lastError,
        },
        decks,
        library: library_stats ? dj.lib.stats() : undefined,
        hints,
      });
    }),
  );

  server.registerTool(
    "djay_setup",
    {
      title: "Install / refresh djay MIDI mappings",
      description:
        "Generates mapping files for the five virtual MIDI ports (Global djay MCP, One..Four djay MCP) from the installed djay version and writes them to ~/Music/djay/MIDI Mappings. djay only reads mappings at launch, so pass restart_djay: true to quit and relaunch it (refuses while a deck is playing unless force). Launches djay if it is closed.",
      inputSchema: {
        restart_djay: z.boolean().default(false),
        force: z.boolean().default(false).describe("Restart even if a deck is playing"),
        launch_if_closed: z.boolean().default(true),
      },
    },
    safe(async ({ restart_djay, force, launch_if_closed }) => {
      const { plists } = buildMappings();
      const changed = Object.entries(plists).some(([port, pl]) => {
        const f = join(USER_MAPPINGS_DIR, `${port}.djayMidiMapping`);
        if (!existsSync(f)) return true;
        const strip = (s: string) => s.replace(/<key>uuid<\/key>\s*<string>[^<]*<\/string>/, "");
        return strip(readFileSync(f, "utf8")) !== strip(toXmlPlist(pl));
      });
      const res = dj.install();
      await dj.startMidi();
      const running = await dj.isRunning();
      let restarted = false;
      if (running && (changed || restart_djay) && restart_djay) {
        const playing = await dj.anyDeckPlaying();
        if (playing.length && !force) throw new DjayError(`Deck(s) ${playing.join(", ")} are playing. Stop them or pass force: true.`);
        await dj.quit();
        await sleep(800);
        await dj.launch(false);
        restarted = true;
      } else if (!running && launch_if_closed) {
        await dj.launch(false);
      }
      const t0 = Date.now();
      let feedback = false;
      if (await dj.isRunning()) {
        for (let i = 0; i < 40 && !feedback; i++) {
          await sleep(250);
          feedback = (dj.midi?.lastFeedbackAt ?? 0) > t0 - 60_000 && (dj.midi?.state.size ?? 0) > 0;
        }
      }
      return ok({
        mappingsWritten: res.files,
        removedStale: res.removed,
        changed,
        restarted,
        feedbackFromDjay: feedback,
        counts: res.map.counts,
        note:
          running && changed && !restarted
            ? "Mappings changed while djay was open: call djay_setup again with restart_djay: true so djay loads them."
            : feedback
              ? "djay is connected and reporting state."
              : "Mappings are in place; djay has not reported state yet.",
      });
    }),
  );

  server.registerTool(
    "djay_app",
    {
      title: "Launch / quit djay",
      description: "launch (in the background unless foreground), show (bring to front), hide, quit (refuses while playing unless force), restart.",
      inputSchema: { action: z.enum(["launch", "show", "hide", "quit", "restart"]), foreground: z.boolean().default(false), force: z.boolean().default(false) },
    },
    safe(async ({ action, foreground, force }) => {
      if (action === "launch") await dj.launch(foreground);
      else if (action === "show") await dj.launch(true);
      else if (action === "hide") await dj.ax.menu(["djay Pro", "Hide djay Pro"]);
      else {
        const playing = await dj.anyDeckPlaying();
        if (playing.length && !force) throw new DjayError(`Deck(s) ${playing.join(", ")} are playing. Pass force: true to ${action} anyway.`);
        await dj.quit();
        if (action === "restart") {
          await sleep(800);
          await dj.launch(foreground);
        }
      }
      return ok({ action, running: await dj.isRunning() });
    }),
  );

  // ---------------- library ----------------
  server.registerTool(
    "djay_library",
    {
      title: "Music library",
      description:
        "Browse and search music. From djay's library database (works offline, all sources): search (query, bpm_min/max, key e.g. '8A' or 'Am', compatible_with a Camelot key for harmonic mixing, source spotify|apple-music|file|tidal|soundcloud|beatport, sort), track (by id), queue (Automix queue), history (DJ sessions; pass session_id for its tracklist with decks and times), stats. " +
        "From djay's live browser UI: browse (rows of the visible track list), sources (My Collection / Apple Music / Spotify ...), playlists (sidebar), open (select a source or playlist by name), find (type into djay's search box and return results), select_row.",
      inputSchema: {
        action: z.enum(["search", "track", "queue", "history", "stats", "browse", "sources", "playlists", "open", "find", "select_row"]),
        query: z.string().optional(),
        bpm_min: z.number().optional(),
        bpm_max: z.number().optional(),
        key: z.string().optional(),
        compatible_with: z.string().optional(),
        source: z.enum(["spotify", "apple-music", "file", "tidal", "soundcloud", "beatport"]).optional(),
        sort: z.enum(["relevance", "bpm", "playCount", "title"]).optional(),
        id: z.string().optional(),
        session_id: z.string().optional(),
        name: z.string().optional().describe("For open: source or playlist name"),
        row: z.number().int().min(0).optional(),
        results: z.boolean().default(false).describe("select_row: pick from the search results panel instead of the track list"),
        start: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(25),
      },
      annotations: { readOnlyHint: false },
    },
    safe(async (a) => {
      switch (a.action) {
        case "search":
          return ok(dj.lib.search({ query: a.query, bpmMin: a.bpm_min, bpmMax: a.bpm_max, key: a.key, compatibleWith: a.compatible_with, source: a.source, sort: a.sort, limit: a.limit }));
        case "track": {
          if (!a.id) throw new DjayError("pass id");
          return ok(dj.lib.track(a.id) ?? { error: "not found" });
        }
        case "queue":
          return ok({ queue: dj.lib.queue() });
        case "history":
          return ok({ sessions: dj.lib.historySessions(a.session_id ? 1 : a.limit, !!a.session_id, a.session_id) });
        case "stats":
          return ok(dj.lib.stats());
        case "browse": {
          const r = await dj.ax.rows(a.start, a.limit);
          return ok({ list: r.table, total: r.total, rows: parseRows(r) });
        }
        case "sources":
        case "playlists": {
          const r = await dj.ax.request("rows", { table: a.action === "sources" ? "Library" : "Your Library", start: a.start, count: a.limit });
          return ok({ total: r.total, items: parseRows(r).map((x) => ({ index: x.index, name: x.title, selected: x.selected })) });
        }
        case "open": {
          if (!a.name) throw new DjayError("pass name");
          for (const table of ["Library", "Your Library"]) {
            const r = await dj.ax.request("rows", { table, start: 0, count: 500 }).catch(() => undefined);
            if (!r) continue;
            const hit = parseRows(r).find((x) => norm(x.title) === norm(a.name)) ?? parseRows(r).find((x) => norm(x.title).includes(norm(a.name)));
            if (hit) {
              await dj.ax.request("selectRow", { table, index: hit.index });
              await sleep(800);
              const list = await dj.ax.rows(0, a.limit);
              return ok({ opened: hit.title, from: table === "Library" ? "sources" : "playlists", total: list.total, rows: parseRows(list) });
            }
          }
          throw new DjayError(`no source or playlist named '${a.name}'`);
        }
        case "find": {
          if (!a.query) throw new DjayError("pass query");
          const found = await findInDjay(dj, a.query, a.limit);
          return ok({ query: a.query, matched: found.matched, results: found.rows.length, rows: found.rows, hint: "Load one with djay_load (query/title) or djay_library select_row with row = index and results: true." });
        }
        case "select_row": {
          if (a.row === undefined) throw new DjayError("pass row");
          if (a.results) {
            const ts: any[] = await dj.ax.request("tables");
            const t = ts.find((x) => x.role === "AXTable" && !x.title);
            if (!t) throw new DjayError("no search results panel is open");
            await dj.ax.request("selectRow", { tablePath: t.path, index: a.row });
          } else await dj.ax.selectRow(a.row);
          return ok({ selected: a.row });
        }
      }
    }),
  );

  server.registerTool(
    "djay_load",
    {
      title: "Load a track onto a deck",
      description:
        "Load a track onto deck 1-4. Give query (free text), or title (+ artist), or track_id (from djay_library search), or row (index in the visible list), or file (absolute path to a local audio file). " +
        "Text searches use djay's own search box in the current source (switch with djay_library action open), pick the best match and load it, then wait until the deck reports the track. Returns the deck state.",
      inputSchema: {
        deck: deckSchema,
        query: z.string().optional(),
        title: z.string().optional(),
        artist: z.string().optional(),
        track_id: z.string().optional(),
        row: z.number().int().min(0).optional(),
        file: z.string().optional(),
        play: z.boolean().default(false).describe("Start playback after loading (djay may auto-play on load; false pauses it)"),
        timeout_s: z.number().min(1).max(120).default(30),
      },
    },
    safe(async (a) => {
      await dj.startMidi();
      const before = await dj.deck(a.deck);
      let chosen: Row | undefined;
      if (a.file) {
        if (!existsSync(a.file)) throw new DjayError(`file not found: ${a.file}`);
        await dj.trigger(`application.turntable${a.deck}Selected`);
        await run("/usr/bin/open", ["-g", "-a", APP_PATH, a.file]);
      } else {
        let title = a.title;
        let artist = a.artist;
        let query = a.query;
        if (a.track_id) {
          const tr = dj.lib.track(a.track_id);
          if (!tr) throw new DjayError(`unknown track_id ${a.track_id}`);
          title = tr.title;
          artist = tr.artist;
        }
        if (query || title) {
          const q = query ?? [title, artist].filter(Boolean).join(" ");
          const found = await findInDjay(dj, q, 40);
          const songs = found.rows.filter((r) => r.source || /song|track/i.test(r.section ?? ""));
          if (!songs.length || !found.tablePath) throw new DjayError(`djay's search found no tracks for '${q}' in the current source`);
          const ranked = songs.map((r, i) => ({ r, s: score(r, title, artist, query) - i * 0.01 })).sort((x, y) => y.s - x.s);
          chosen = ranked[0].r;
          const titleOk = !title || norm(chosen.title).includes(norm(title)) || norm(title).includes(norm(chosen.title));
          if (!found.matched || !titleOk || ranked[0].s < 2) {
            throw new DjayError(
              `No result clearly matches '${q}' (best: '${chosen.title}' by ${chosen.artist ?? "?"}). Nothing was loaded. Try djay_library find to see the results, or switch source with djay_library open.`,
            );
          }
          await dj.ax.request("selectRow", { tablePath: found.tablePath, index: chosen.index });
        } else if (a.row !== undefined) {
          await dj.ax.selectRow(a.row);
          chosen = parseRows(await dj.ax.rows(a.row, 1))[0];
        } else throw new DjayError("pass query, title, track_id, row or file");
        await sleep(150);
        await dj.trigger(`musicLibrary.load${a.deck}`);
      }
      // Wait for the deck to show the new title, then for the audio itself (time / load flag).
      const deadline = Date.now() + a.timeout_s * 1000;
      let now = before;
      let titleSeen = false;
      while (Date.now() < deadline) {
        await sleep(400);
        now = await dj.deck(a.deck);
        const changed = !!now.title && now.title !== before.title;
        const matches = chosen?.title ? norm(now.title).includes(norm(chosen.title).slice(0, 20)) : changed;
        if (now.title && (matches || changed)) titleSeen = true;
        const audioReady = (now.time && now.time !== "-00:00" && now.time !== "00:00") || dj.midi?.get(`turntable${a.deck}.song.loadingSuccess`)?.value === 1;
        if (titleSeen && audioReady) break;
      }
      const loaded = titleSeen && !!now.title;
      if (loaded) {
        // Make playback state deterministic regardless of djay's auto-play setting.
        await dj.setPlaying(a.deck, a.play);
        now = await dj.deck(a.deck);
      }
      return ok({ loaded, picked: chosen, deck: now }, loaded ? undefined : "Track did not appear on the deck in time (streaming tracks can take longer; check djay_deck).");
    }),
  );

  // ---------------- menus, raw UI, screenshot ----------------
  server.registerTool(
    "djay_menu",
    {
      title: "djay menu bar",
      description:
        "List djay's menu bar (omit path) or click a menu item by path, e.g. ['Deck 1','BPM','Double'], ['Mixer','Main Out Effect','AUReverb2'], ['Library','Analyze'], ['View','Show Sampler']. Covers everything djay exposes in menus, including settings windows.",
      inputSchema: { path: z.array(z.string()).min(1).max(4).optional() },
    },
    safe(async ({ path }) => {
      if (!path) return ok(await dj.ax.menus());
      await dj.ax.menu(path);
      return ok({ clicked: path });
    }),
  );

  server.registerTool(
    "djay_ui",
    {
      title: "djay UI elements (accessibility)",
      description:
        "Universal fallback for anything visible in djay's window. find: list UI elements matching text (label/value) and/or role (AXButton, AXSlider, AXStaticText, AXTextField...). press: click an element by exact label (e.g. 'Sync, Deck 1') or path. set: set a text field or slider value. Labels come from find.",
      inputSchema: {
        action: z.enum(["find", "press", "set"]),
        text: z.string().optional().describe("find: substring of label or value"),
        role: z.string().optional(),
        label: z.string().optional(),
        nth: z.number().int().min(0).default(0),
        path: z.array(z.number().int()).optional(),
        value: z.union([z.string(), z.number()]).optional(),
        limit: z.number().int().min(1).max(1000).default(80),
      },
    },
    safe(async (a) => {
      if (a.action === "find") {
        const nodes = await dj.ax.snapshot(false, 8000);
        const q = a.text?.toLowerCase();
        const hits = nodes
          .filter((n: AXNode) => (!a.role || n.role === a.role) && (!q || [n.desc, n.title, n.value, n.help].some((x) => x?.toLowerCase().includes(q))))
          .filter((n) => n.desc || n.title || n.value)
          .slice(0, a.limit);
        return ok({ count: hits.length, elements: hits });
      }
      const target = a.path ? { path: a.path } : { label: a.label, role: a.role, nth: a.nth };
      if (!a.path && !a.label) throw new DjayError("pass label or path");
      if (a.action === "press") await dj.ax.press(target);
      else {
        if (a.value === undefined) throw new DjayError("pass value");
        await dj.ax.setValue(target, a.value);
      }
      return ok({ done: a.action, target });
    }),
  );

  server.registerTool(
    "djay_screenshot",
    {
      title: "Screenshot djay",
      description: "Capture djay's main window (even if it is behind other windows) so you can see waveforms, loaded FX, pads and the library. Returns a PNG image.",
      inputSchema: { max_width: z.number().int().min(400).max(3600).default(1400) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ max_width }) => {
      const id = await dj.mainWindowId();
      if (!id) throw new DjayError("djay window not found (is djay running?)");
      const dir = mkdtempSync(join(tmpdir(), "djay-shot-"));
      const file = join(dir, "djay.png");
      try {
        await run("/usr/sbin/screencapture", ["-x", "-o", "-l", String(id), file]);
        await run("/usr/bin/sips", ["-Z", String(max_width), file]);
        const data = readFileSync(file).toString("base64");
        return { content: [{ type: "image" as const, data, mimeType: "image/png" }, { type: "text" as const, text: `djay window ${id}` }] };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
}

interface SearchHit extends Row {
  section?: string;
  album?: string;
  duration?: string;
}

/**
 * Types into djay's library search box. djay shows results in a separate panel
 * (an untitled table beside the browser) grouped into sections such as "Songs".
 */
async function findInDjay(dj: Djay, query: string, limit: number): Promise<{ tablePath?: number[]; rows: SearchHit[]; matched: boolean }> {
  const nodes = await dj.ax.snapshot(false, 8000);
  const fields = nodes.filter((n) => n.subrole === "AXSearchField" || (n.role === "AXTextField" && /search/i.test(n.desc ?? "")));
  // When the results panel is open it has its own search box (later in the tree); typing into the
  // main box then does not re-run the search, so prefer the last search field.
  const usable = fields.filter((n) => !/playlists/i.test(n.desc ?? ""));
  const field = usable[usable.length - 1];
  if (!field) throw new DjayError("djay's library search box is not visible (show the library: djay_view toggle library)");
  const tablesBefore: { role: string; title: string; rows: number; path: number[] }[] = await dj.ax.request("tables");
  const resultTable = (ts: typeof tablesBefore) => ts.find((t) => t.role === "AXTable" && !t.title);
  const prev = resultTable(tablesBefore);
  const sigOf = async (path: number[]) => {
    const r = await dj.ax.request("rows", { tablePath: path, start: 0, count: 4 }).catch(() => undefined);
    return r ? JSON.stringify(r.rows.map((x: any) => x.cells)) + r.total : "";
  };
  const prevSig = prev ? await sigOf(prev.path) : "";
  const sameQuery = (field.value ?? "") === query;
  await dj.ax.setValue({ path: field.path }, query);
  await dj.ax.press({ path: field.path, action: "AXConfirm" }).catch(() => undefined);

  // Accept results once they match the query and have settled (Spotify answers asynchronously),
  // or, failing that, once they have stayed the same for a while.
  const words = norm(query).split(" ").filter((w) => w.length >= 3);
  const relevant = async (path: number[]) => {
    if (!words.length) return true;
    const r = await dj.ax.request("rows", { tablePath: path, start: 0, count: 8 }).catch(() => undefined);
    if (!r) return false;
    return r.rows.some((row: any) => {
      const hay = norm(row.cells.flat().join(" "));
      return words.filter((w) => hay.includes(w)).length >= Math.ceil(words.length * 0.75);
    });
  };
  let table: (typeof tablesBefore)[number] | undefined;
  let matched = false;
  let lastSig = "";
  let stable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await sleep(300);
    const ts: typeof tablesBefore = await dj.ax.request("tables").catch(() => []);
    const cand = resultTable(ts);
    if (!cand || cand.rows < 2) continue;
    const sig = await sigOf(cand.path);
    stable = sig === lastSig ? stable + 1 : 0;
    lastSig = sig;
    const fresh = sig !== prevSig || sameQuery;
    if (fresh && stable >= 1 && (await relevant(cand.path))) {
      table = cand;
      matched = true;
      break;
    }
    if (Date.now() - t0 > 12000 && stable >= 3) {
      table = cand;
      break;
    }
  }
  if (!table) return { rows: [], matched: false };
  const res = await dj.ax.request("rows", { tablePath: table.path, start: 0, count: Math.min(200, limit + 12) });
  const rows: SearchHit[] = [];
  let section = "";
  for (const r of res.rows as { index: number; cells: string[][]; selected: boolean }[]) {
    const all = r.cells.flat();
    const texts = all.filter((c) => !c.startsWith("["));
    const icon = all.find((c) => c.startsWith("[icon origin "));
    if (!icon && texts.length === 1) {
      section = texts[0];
      continue;
    }
    const hit: SearchHit = { index: r.index, section };
    if (icon) hit.source = icon.replace("[icon origin ", "").replace("]", "");
    const rest: string[] = [];
    for (const t of texts) {
      if (/^\d+(\.\d+)? BPM$/.test(t)) hit.bpm = t.replace(" BPM", "");
      else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) hit.duration = t;
      else if (/^\d{1,2}[AB]$/.test(t)) hit.key = t;
      else rest.push(t);
    }
    hit.title = rest[0];
    if (rest.length >= 3) {
      hit.album = rest[1];
      hit.artist = rest[2];
    } else if (rest.length === 2) hit.artist = rest[1];
    if (r.selected) hit.selected = true;
    rows.push(hit);
    if (rows.length >= limit) break;
  }
  return { tablePath: table.path, rows, matched };
}

export { round };
