// Generic access to every djay feature in the catalog (≈1,270 features x 4 decks).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchFeatures } from "../catalog.js";
import { Djay, DjayError, round, sleep } from "../djay.js";
import { deckSchema, ok, safe } from "./util.js";

export function registerGeneric(server: McpServer, dj: Djay) {
  server.registerTool(
    "djay_features",
    {
      title: "Search djay features",
      description:
        "Search the full catalog of controllable djay Pro features (every MIDI-mappable function in the installed app: transport, cue points, loops, FX, Neural Mix, mixer, sampler, looper, library, view, recording, microphone...). " +
        "Returns ids to use with djay_trigger / djay_set / djay_get. kind: action|toggle|hold|trigger (buttons), control (absolute 0..1), rotary (relative steps). perDeck features need deck 1-4. " +
        "Categories: turntable (per deck), mixer, application, musicLibrary, sampler, looper, microphone.",
      inputSchema: {
        query: z.string().optional().describe("Words to match in id, title or section, e.g. 'loop 4 beat', 'neural mix vocals', 'reverb'"),
        category: z.enum(["turntable", "deck", "mixer", "application", "musicLibrary", "sampler", "looper", "microphone"]).optional(),
        section: z.string().optional().describe("Exact section name, e.g. 'Cue Points', 'Looping', 'Effects'"),
        kind: z.enum(["action", "toggle", "hold", "trigger", "control", "rotary"]).optional(),
        limit: z.number().int().min(1).max(500).default(60),
        offset: z.number().int().min(0).default(0),
        sections_only: z.boolean().default(false).describe("Only list categories and their sections with counts"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      if (a.sections_only) {
        const tree: Record<string, Record<string, number>> = {};
        for (const f of dj.catalog.features) {
          (tree[f.category] ??= {})[f.section] = ((tree[f.category] ??= {})[f.section] ?? 0) + 1;
        }
        return ok({ appVersion: dj.catalog.appVersion, totalFeatures: dj.catalog.features.length, categories: tree });
      }
      const r = searchFeatures(dj.catalog, a);
      return ok({
        total: r.total,
        showing: `${a.offset}-${a.offset + r.items.length}`,
        features: r.items.map((f) => ({
          id: f.id,
          title: f.title,
          section: f.section,
          kind: f.kind,
          perDeck: f.perDeck || undefined,
          param: f.param,
          reportsState: !!f.state || undefined,
          reportsValue: !!f.value || undefined,
        })),
      });
    }),
  );

  server.registerTool(
    "djay_trigger",
    {
      title: "Press a djay button feature",
      description:
        "Press any button-type djay feature by id (from djay_features), e.g. turntable.playPause, turntable.bpmSync, turntable.autoLoop4BeatInterval, mixer.transitionActiveToInactive, application.automix. " +
        "mode: tap (default), press/release (manual hold), hold (press for hold_ms), on/off (toggles: only presses if the reported state differs). Returns the reported state afterwards when djay reports one.",
      inputSchema: {
        feature: z.string().describe("Feature id, e.g. 'turntable.playPause' (short names like 'playPause' work when unambiguous)"),
        deck: deckSchema.optional().describe("Required for per-deck (turntable.*) features"),
        param: z.number().int().optional().describe("Argument for parameterised features (FX index, semitones, view mode index)"),
        mode: z.enum(["tap", "press", "release", "hold", "on", "off"]).default("tap"),
        hold_ms: z.number().int().min(30).max(30000).optional(),
      },
    },
    safe(async (a) => ok(await dj.trigger(a.feature, { deck: a.deck, param: a.param, mode: a.mode, holdMs: a.hold_ms }))),
  );

  server.registerTool(
    "djay_set",
    {
      title: "Set a djay continuous control",
      description:
        "Set any continuous djay control by id: absolute controls take value 0..1 (0.5 = centre/neutral for EQ, filter, tempo, pan, gain; crossfader 0 = left, 1 = right), with optional ramp_ms for a smooth move. " +
        "Relative encoders (kind 'rotary', e.g. musicLibrary.libraryRotary, turntable.jogSeekMove, turntable.fx1SelectRotary) take steps (+ = right/down). 14-bit precision.",
      inputSchema: {
        feature: z.string(),
        deck: deckSchema.optional(),
        value: z.number().min(0).max(1).optional(),
        steps: z.number().int().min(-1000).max(1000).optional(),
        ramp_ms: z.number().int().min(0).max(600000).optional().describe("Move smoothly to value over this many ms"),
        curve: z.enum(["linear", "ease"]).default("linear"),
      },
    },
    safe(async (a) => {
      if (a.steps !== undefined) return ok(await dj.turn(a.feature, a.steps, a.deck));
      if (a.value === undefined) throw new DjayError("pass value (0..1) or steps");
      if (a.ramp_ms) return ok(await dj.ramp(a.feature, a.value, a.ramp_ms, { deck: a.deck, curve: a.curve }));
      return ok(await dj.set(a.feature, a.value, a.deck));
    }),
  );

  server.registerTool(
    "djay_get",
    {
      title: "Read djay feedback state",
      description:
        "Read what djay reports back over MIDI. With feature (+deck): its on/off state, current value (0..1) and whether it is enabled. " +
        "Without feature: dump live state entries, filtered by deck, path_prefix (e.g. 'turntable1.unmixer', 'mixer.') or role (state|value|enabled|extra).",
      inputSchema: {
        feature: z.string().optional(),
        deck: deckSchema.optional(),
        path_prefix: z.string().optional(),
        role: z.enum(["state", "value", "enabled", "extra"]).optional(),
        only_active: z.boolean().default(false).describe("Only entries that are on / non-zero"),
        limit: z.number().int().min(1).max(3000).default(300),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      await dj.startMidi();
      if (a.feature) return ok(dj.read(dj.feature(a.feature), a.deck));
      const entries = dj
        .stateEntries({ deck: a.deck, prefix: a.path_prefix, role: a.role })
        .filter((e) => !a.only_active || e.value > 0)
        .sort((x, y) => x.path.localeCompare(y.path))
        .slice(0, a.limit)
        .map((e) => ({ path: e.path, value: e.kind === "bool" ? e.value > 0 : round(e.value), feature: e.feature, role: e.role }));
      return ok({ count: entries.length, lastFeedbackAt: dj.midi?.lastFeedbackAt ? new Date(dj.midi.lastFeedbackAt).toISOString() : null, entries });
    }),
  );

  const step = z.object({
    wait_ms: z.number().int().min(0).max(600000).default(0).describe("Delay before this step"),
    action: z.enum(["trigger", "set", "ramp", "turn"]),
    feature: z.string(),
    deck: deckSchema.optional(),
    param: z.number().int().optional(),
    mode: z.enum(["tap", "press", "release", "hold", "on", "off"]).optional(),
    hold_ms: z.number().int().optional(),
    value: z.number().min(0).max(1).optional(),
    steps: z.number().int().optional(),
    duration_ms: z.number().int().min(0).max(600000).optional(),
  });

  server.registerTool(
    "djay_sequence",
    {
      title: "Run a timed sequence of djay actions",
      description:
        "Execute a choreographed list of steps with precise timing (cue juggling, FX throws, scripted drops, multi-control moves). Each step waits wait_ms, then does trigger/set/ramp/turn. Ramps run inline (blocking the next step). Max ~10 minutes total.",
      inputSchema: { steps: z.array(step).min(1).max(500) },
    },
    safe(async (a) => {
      const results: unknown[] = [];
      const t0 = Date.now();
      for (const s of a.steps) {
        if (s.wait_ms) await sleep(s.wait_ms);
        let r: unknown;
        if (s.action === "trigger") r = await dj.trigger(s.feature, { deck: s.deck, param: s.param, mode: s.mode, holdMs: s.hold_ms });
        else if (s.action === "set") r = await dj.set(s.feature, s.value ?? 0, s.deck);
        else if (s.action === "ramp") r = await dj.ramp(s.feature, s.value ?? 0, s.duration_ms ?? 1000, { deck: s.deck });
        else r = await dj.turn(s.feature, s.steps ?? 0, s.deck);
        results.push({ atMs: Date.now() - t0, ...(r as object) });
      }
      return ok({ steps: results.length, totalMs: Date.now() - t0, results });
    }),
  );

  server.registerTool(
    "djay_midi_raw",
    {
      title: "Send raw MIDI to djay",
      description: "Low-level: send raw MIDI bytes on one of the virtual ports ('Global djay MCP', or 'One'/'Two'/'Three'/'Four djay MCP' for decks 1-4). For debugging mappings.",
      inputSchema: {
        port: z.string().describe("e.g. 'One djay MCP' (deck 1)"),
        bytes: z.array(z.number().int().min(0).max(255)).min(1).max(256),
      },
    },
    safe(async (a) => {
      const midi = await dj.startMidi();
      midi.sendRaw(a.port, a.bytes);
      return ok({ sent: a.bytes.length, port: a.port });
    }),
  );
}
