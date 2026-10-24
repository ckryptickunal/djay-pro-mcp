// DJ-level tools: decks, transport, tempo, mixer, loops, cues, FX, Neural Mix, sampler,
// looper, Automix, recording, view modes and automated transitions.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Djay, DjayError, round, sleep } from "../djay.js";
import { cancelJob, listJobs, startTransition } from "../mix.js";
import { deckSchema, ok, safe, unit } from "./util.js";

// Beat lengths -> djay's id fragments.
const LOOP_BEATS: Record<string, string> = {
  "1/32": "003125", "1/16": "00625", "1/8": "0125", "1/4": "025", "1/3": "033", "1/2": "05", "3/4": "075",
  "1": "1", "1.5": "1_5", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  "12": "12", "16": "16", "32": "32", "64": "64", "128": "128",
};
const JUMP_BEATS: Record<string, string> = {
  "1/8": "0125Beats", "1/4": "025Beats", "1/2": "05Beats", "1": "1Beat", "2": "2Beats", "4": "4Beats",
  "8": "8Beats", "16": "16Beats", "32": "32Beats", "64": "64Beats",
};
const beatsKey = z.enum(Object.keys(LOOP_BEATS) as [string, ...string[]]);

export function registerPerform(server: McpServer, dj: Djay) {
  const t = (feature: string, deck?: number, mode: "tap" | "on" | "off" | "hold" = "tap", extra: { param?: number; holdMs?: number } = {}) =>
    dj.trigger(feature, { deck, mode, ...extra });

  // ---------------- decks ----------------
  server.registerTool(
    "djay_deck",
    {
      title: "Get deck state",
      description:
        "Full live state of one deck or all decks: loaded track (title, artist), BPM, key, time remaining, progress, playing, sync / sync master, key lock, loop, slip, tempo %, level meter, line volume, EQ, filter, gain.",
      inputSchema: { deck: deckSchema.optional().describe("Omit for decks 1 and 2 (and 3-4 if visible)") },
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      if (a.deck) return ok(await dj.deck(a.deck));
      const ro = await dj.readouts();
      const visible = ro.length ? ro.map((r) => r.deck) : [1, 2];
      const decks = [];
      for (const d of visible) decks.push(await dj.deck(d));
      return ok({ decks, mixer: dj.mixer() });
    }),
  );

  server.registerTool(
    "djay_transport",
    {
      title: "Deck transport",
      description:
        "Transport and deck actions: play, pause, toggle, cue (classic CUE button), play_from_start, go_to_start, sync_on, sync_off, sync_master, key_lock_on, key_lock_off, reverse, slip_on, slip_off, repeat_on, repeat_off, quantize_on, quantize_off, brake (brake-stop effect), echo_out, censor (hold), instant_double (copy other deck), eject, load_next, load_previous, match_key.",
      inputSchema: {
        deck: deckSchema,
        action: z.enum([
          "play", "pause", "toggle", "cue", "play_from_start", "go_to_start", "sync_on", "sync_off", "sync_master",
          "key_lock_on", "key_lock_off", "reverse", "slip_on", "slip_off", "repeat_on", "repeat_off", "quantize_on",
          "quantize_off", "brake", "echo_out", "censor", "instant_double", "eject", "load_next", "load_previous", "match_key",
        ]),
        hold_ms: z.number().int().min(50).max(10000).optional().describe("For censor"),
      },
    },
    safe(async ({ deck, action, hold_ms }) => {
      const map: Record<string, () => Promise<unknown>> = {
        play: () => dj.setPlaying(deck, true),
        pause: () => dj.setPlaying(deck, false),
        toggle: () => t("turntable.playPause", deck),
        cue: () => t("turntable.cuePositionOrJumpConsideringPlayState1", deck),
        play_from_start: () => t("turntable.gotoBeginningAndPlay", deck),
        go_to_start: () => t("turntable.gotoBeginning", deck),
        sync_on: () => t("turntable.bpmSync", deck, "on"),
        sync_off: () => t("turntable.bpmSync", deck, "off"),
        sync_master: () => t("turntable.turntableIsSyncMaster", deck),
        key_lock_on: () => t("turntable.key", deck, "on"),
        key_lock_off: () => t("turntable.key", deck, "off"),
        reverse: () => t("turntable.reverse", deck),
        slip_on: () => t("turntable.deckSlipToggle", deck, "on"),
        slip_off: () => t("turntable.deckSlipToggle", deck, "off"),
        repeat_on: () => t("turntable.autoRepeat", deck, "on"),
        repeat_off: () => t("turntable.autoRepeat", deck, "off"),
        quantize_on: () => t("turntable.toggleQuantize", deck, "on"),
        quantize_off: () => t("turntable.toggleQuantize", deck, "off"),
        brake: () => t("turntable.brakeTransitionEffect", deck),
        echo_out: () => t("turntable.echoTransitionEffect", deck),
        censor: () => t("turntable.censor", deck, "hold", { holdMs: hold_ms ?? 1000 }),
        instant_double: () => t("turntable.loadDouble", deck),
        eject: () => t("turntable.unload", deck),
        load_next: () => t("turntable.loadNextTrack", deck),
        load_previous: () => t("turntable.loadPreviousTrack", deck),
        match_key: () => t("turntable.matchKey", deck),
      };
      const r = await map[action]();
      await sleep(150);
      return ok({ action, result: r, deck: await dj.deck(deck) });
    }),
  );

  // ---------------- tempo ----------------
  server.registerTool(
    "djay_tempo",
    {
      title: "Set deck tempo / BPM",
      description:
        "Set a deck's tempo precisely. Give percent (e.g. -2.5), bpm (target BPM), match_deck (copy another deck's BPM without enabling sync), or reset. Closed-loop: reads djay's tempo display back and corrects. Also: nudge (temporary pitch bend for manual beatmatching) and range_next (cycle the tempo slider range ±8/16/50%).",
      inputSchema: {
        deck: deckSchema,
        percent: z.number().min(-100).max(100).optional(),
        bpm: z.number().min(20).max(300).optional(),
        match_deck: deckSchema.optional(),
        reset: z.boolean().optional(),
        nudge: z.enum(["faster", "slower"]).optional(),
        nudge_ms: z.number().int().min(20).max(5000).default(300),
        range_next: z.boolean().optional(),
      },
    },
    safe(async (a) => {
      const deck = a.deck;
      if (a.range_next) await t("application.tempoSliderRangeNext");
      if (a.nudge) {
        await t(a.nudge === "faster" ? "turntable.pitchBendPlus" : "turntable.pitchBendMinus", deck, "hold", { holdMs: a.nudge_ms });
        return ok(await dj.deck(deck));
      }
      if (a.reset) {
        await t("turntable.resetSpeed", deck);
        await sleep(150);
        return ok(await dj.deck(deck));
      }
      const now = await dj.deck(deck);
      let target = a.percent;
      if (a.bpm !== undefined || a.match_deck !== undefined) {
        const goal = a.bpm ?? (await dj.deck(a.match_deck!)).bpm;
        if (!goal) throw new DjayError("target deck has no BPM reading (is a track loaded?)");
        if (!now.bpm) throw new DjayError(`deck ${deck} has no BPM reading (is a track loaded?)`);
        const base = now.bpm / (1 + (now.tempoPercent ?? 0) / 100);
        target = (goal / base - 1) * 100;
      }
      if (target === undefined) return ok(now, "Nothing to change; pass percent, bpm, match_deck, reset or nudge.");
      // Closed loop on djay's own % readout (the slider has a snap zone near 0 and a selectable range).
      let range = 16;
      let v = 0.5 + target / (2 * range);
      let reading = now.tempoPercent;
      for (let i = 0; i < 6; i++) {
        v = Math.min(1, Math.max(0, v));
        await dj.set("turntable.speed", v, deck);
        await sleep(120);
        reading = (await dj.readouts()).find((r) => r.deck === deck)?.tempoPercent;
        if (reading === undefined) break;
        const err = target - reading;
        if (Math.abs(err) < 0.05) break;
        if (Math.abs(v - 0.5) > 0.02 && Math.abs(reading) > 0.2) range = Math.abs(reading / ((v - 0.5) * 2));
        v += err / (2 * range);
      }
      return ok({ targetPercent: round(target, 2), readPercent: reading, deck: await dj.deck(deck) });
    }),
  );

  // ---------------- mixer ----------------
  const deckMix = z.object({
    deck: deckSchema,
    volume: unit.optional().describe("Channel fader 0..1"),
    high: unit.optional().describe("EQ 0 = kill, 0.5 = flat, 1 = boost"),
    mid: unit.optional(),
    low: unit.optional(),
    filter: unit.optional().describe("0.5 = off, <0.5 low-pass, >0.5 high-pass"),
    gain: unit.optional().describe("Trim, 0.5 = unity"),
    pan: unit.optional(),
    kill_high: z.boolean().optional(),
    kill_mid: z.boolean().optional(),
    kill_low: z.boolean().optional(),
    headphone_cue: z.boolean().optional().describe("Pre-cue (headphones) on/off"),
    crossfader_side: z.enum(["left", "right", "through"]).optional(),
  });

  server.registerTool(
    "djay_mixer",
    {
      title: "Mixer control",
      description:
        "Set mixer controls in one call: crossfader (0 left .. 1 right), master, booth, headphone level and cue mix, plus per-deck channel volume, 3-band EQ, filter, gain, pan, EQ kills, headphone pre-cue and crossfader assignment. Optional ramp_ms moves continuous controls smoothly. Values are 0..1.",
      inputSchema: {
        crossfader: unit.optional(),
        master: unit.optional(),
        booth: unit.optional(),
        headphones: unit.optional(),
        cue_mix: unit.optional().describe("Headphone cue/master mix"),
        crossfader_curve: z.enum(["default", "linear", "constant_power", "dipped", "cut"]).optional(),
        decks: z.array(deckMix).optional(),
        ramp_ms: z.number().int().min(0).max(600000).optional(),
      },
    },
    safe(async (a) => {
      const jobs: Promise<unknown>[] = [];
      const move = (feature: string, value: number, deck?: number) =>
        jobs.push(a.ramp_ms ? dj.ramp(feature, value, a.ramp_ms, { deck, curve: "ease" }) : dj.set(feature, value, deck));
      if (a.crossfader !== undefined) move("mixer.crossfade", a.crossfader);
      if (a.master !== undefined) move("mixer.masterLevel", a.master);
      if (a.booth !== undefined) move("mixer.boothLevel", a.booth);
      if (a.headphones !== undefined) move("mixer.monitorLevel", a.headphones);
      if (a.cue_mix !== undefined) move("mixer.monitorMix", a.cue_mix);
      for (const d of a.decks ?? []) {
        if (d.volume !== undefined) move(`mixer.lineVolume${d.deck}`, d.volume);
        if (d.high !== undefined) move("turntable.highEQ", d.high, d.deck);
        if (d.mid !== undefined) move("turntable.midEQ", d.mid, d.deck);
        if (d.low !== undefined) move("turntable.lowEQ", d.low, d.deck);
        if (d.filter !== undefined) move("turntable.filter", d.filter, d.deck);
        if (d.gain !== undefined) move("turntable.gain", d.gain, d.deck);
        if (d.pan !== undefined) move("turntable.pan", d.pan, d.deck);
        if (d.kill_high !== undefined) jobs.push(t("turntable.highEQKill", d.deck, d.kill_high ? "on" : "off"));
        if (d.kill_mid !== undefined) jobs.push(t("turntable.midEQKill", d.deck, d.kill_mid ? "on" : "off"));
        if (d.kill_low !== undefined) jobs.push(t("turntable.lowEQKill", d.deck, d.kill_low ? "on" : "off"));
        if (d.headphone_cue !== undefined) jobs.push(t(`mixer.monitorActive${d.deck}`, undefined, d.headphone_cue ? "on" : "off"));
        if (d.crossfader_side) {
          const side = d.crossfader_side === "left" ? "Left" : d.crossfader_side === "right" ? "Right" : "Through";
          jobs.push(t(`mixer.crossfadeAssignment${d.deck}${side}`));
        }
      }
      await Promise.all(jobs);
      if (a.crossfader_curve) {
        const names: Record<string, string> = { default: "Default", linear: "Linear", constant_power: "Constant Power", dipped: "Dipped", cut: "Cut" };
        await dj.ax.menu(["Mixer", "Crossfade Curve", names[a.crossfader_curve]]);
      }
      await sleep(80);
      return ok(dj.mixer());
    }),
  );

  // ---------------- loops & beat jump ----------------
  server.registerTool(
    "djay_loop",
    {
      title: "Loops and beat jump",
      description:
        "Looping: auto (beat loop of `beats` length: 1/32 .. 128), toggle (auto loop on/off), in, out, exit, reloop, half, double, roll (temporary bounce loop while held: hold_ms), beat_jump_forward / beat_jump_back (by `beats`, or by djay's current jump size), jump_size_up/down.",
      inputSchema: {
        deck: deckSchema,
        action: z.enum(["auto", "toggle", "in", "out", "exit", "reloop", "half", "double", "roll", "beat_jump_forward", "beat_jump_back", "jump_size_up", "jump_size_down"]),
        beats: beatsKey.optional(),
        hold_ms: z.number().int().min(50).max(30000).optional(),
      },
    },
    safe(async ({ deck, action, beats, hold_ms }) => {
      let r: unknown;
      switch (action) {
        case "auto":
          r = await t(beats ? `turntable.autoLoop${LOOP_BEATS[beats]}BeatInterval` : "turntable.autoLoopOnOff", deck);
          break;
        case "toggle": r = await t("turntable.autoLoopOnOff", deck); break;
        case "in": r = await t("turntable.loopIn", deck); break;
        case "out": r = await t("turntable.loopOut", deck); break;
        case "exit": r = await t("turntable.loopingActive", deck, "off"); break;
        case "reloop": r = await t("turntable.reloop", deck); break;
        case "half": r = await t("turntable.autoLoopDurationHalf", deck); break;
        case "double": r = await t("turntable.autoLoopDurationDouble", deck); break;
        case "roll": {
          const id = `turntable.bounceLoop${LOOP_BEATS[beats ?? "1/4"]}BeatInterval`;
          dj.feature(id);
          r = await t(id, deck, "hold", { holdMs: hold_ms ?? 1000 });
          break;
        }
        case "beat_jump_forward":
        case "beat_jump_back": {
          const dir = action === "beat_jump_forward" ? "Forward" : "Backward";
          if (beats && !JUMP_BEATS[beats]) throw new DjayError(`beat jump sizes: ${Object.keys(JUMP_BEATS).join(", ")}`);
          r = await t(beats ? `turntable.skip${dir}${JUMP_BEATS[beats]}` : `turntable.skip${dir}`, deck);
          break;
        }
        case "jump_size_up": r = await t("turntable.skipDurationUp", deck); break;
        case "jump_size_down": r = await t("turntable.skipDurationDown", deck); break;
      }
      await sleep(100);
      const d = await dj.deck(deck);
      return ok({ action, result: r, looping: d.looping, loopLength: d.loopLength, beatJump: d.beatJump });
    }),
  );

  // ---------------- cue points ----------------
  server.registerTool(
    "djay_cue",
    {
      title: "Hot cues",
      description:
        "Hot cue points 1-16: pad (set if empty, else jump — like a controller pad), jump, set, clear, jump_and_play (cue 1 only). Also start-point helpers: set_start, jump_start, clear_start, clear_all.",
      inputSchema: {
        deck: deckSchema,
        action: z.enum(["pad", "jump", "set", "clear", "jump_and_play", "set_start", "jump_start", "clear_start", "clear_all"]),
        n: z.number().int().min(1).max(16).optional(),
      },
    },
    safe(async ({ deck, action, n }) => {
      const need = () => {
        if (!n) throw new DjayError("pass n (1-16)");
        return n;
      };
      let id: string;
      switch (action) {
        case "pad": id = `turntable.cueOrJumpIfAlreadySetCuePoint${need()}`; break;
        case "jump": id = need() <= 8 ? `turntable.jumpToCueConsideringPlayState${n}` : `turntable.cueOrJumpIfAlreadySetCuePoint${n}`; break;
        case "set":
          if (need() > 8) throw new DjayError("set supports cues 1-8; use pad for 9-16 (sets when empty)");
          id = `turntable.cuePosition${n}`;
          break;
        case "clear": id = `turntable.clearCuePointCuePoint${need()}`; break;
        case "jump_and_play": id = "turntable.jumpToCueAndPlay1"; break;
        case "set_start": id = "turntable.startPoint"; break;
        case "jump_start": id = "turntable.cueOrJumpIfAlreadySetStart"; break;
        case "clear_start": id = "turntable.clearStartPoint"; break;
        case "clear_all": id = "turntable.resetCuePoints"; break;
      }
      return ok(await t(id!, deck));
    }),
  );

  // ---------------- FX ----------------
  server.registerTool(
    "djay_fx",
    {
      title: "Effects",
      description:
        "Deck effects. slot 1-3: enabled (true/false), select ('next' | 'prev' | FX index 0-120 within the current pack), parameter (0..1), wet_dry (0..1), reset_parameter. pad_fx: enabled / parameter / wet_dry for the XY pad FX. instant: fire Instant FX 1-8 (hold_ms to hold). Use djay_screenshot or djay_deck to see which FX is loaded.",
      inputSchema: {
        deck: deckSchema,
        slot: z.number().int().min(1).max(3).optional(),
        enabled: z.boolean().optional(),
        select: z.union([z.enum(["next", "prev"]), z.number().int().min(0).max(120)]).optional(),
        parameter: unit.optional(),
        wet_dry: unit.optional(),
        reset_parameter: z.boolean().optional(),
        pad_fx: z.object({ enabled: z.boolean().optional(), parameter: unit.optional(), wet_dry: unit.optional() }).optional(),
        instant: z.number().int().min(1).max(8).optional(),
        hold_ms: z.number().int().min(50).max(30000).optional(),
      },
    },
    safe(async (a) => {
      const deck = a.deck;
      const out: Record<string, unknown> = {};
      if (a.slot) {
        const s = a.slot;
        if (a.select !== undefined) {
          if (a.select === "next") out.select = await t(`turntable.fx${s}SelectNext`, deck);
          else if (a.select === "prev") out.select = await t(`turntable.fx${s}SelectPrev`, deck);
          else out.select = await t(`turntable.fx${s}Select`, deck, "tap", { param: a.select });
        }
        if (a.parameter !== undefined) out.parameter = await dj.set(`turntable.fx${s}ParameterValue`, a.parameter, deck);
        if (a.wet_dry !== undefined) out.wet_dry = await dj.set(`turntable.fx${s}WetDryValue`, a.wet_dry, deck);
        if (a.reset_parameter) out.reset = await t(`turntable.fx${s}ParameterDefaultValue`, deck);
        if (a.enabled !== undefined) out.enabled = await t(`turntable.fx${s}Enabled`, deck, a.enabled ? "on" : "off");
      }
      if (a.pad_fx) {
        if (a.pad_fx.parameter !== undefined) out.pad_parameter = await dj.set("turntable.padFxParameterValue", a.pad_fx.parameter, deck);
        if (a.pad_fx.wet_dry !== undefined) out.pad_wet_dry = await dj.set("turntable.padFxWetDryValue", a.pad_fx.wet_dry, deck);
        if (a.pad_fx.enabled !== undefined) out.pad_enabled = await t("turntable.padFxEnabled", deck, a.pad_fx.enabled ? "on" : "off");
      }
      if (a.instant) out.instant = await t(`turntable.instantFx${a.instant}`, deck, a.hold_ms ? "hold" : "tap", { holdMs: a.hold_ms });
      if (!Object.keys(out).length) throw new DjayError("nothing to do: pass slot (+ enabled/select/parameter/wet_dry), pad_fx or instant");
      return ok(out);
    }),
  );

  // ---------------- Neural Mix ----------------
  const stems = new Map<string, { ch: number; mode: string }>();
  for (const f of dj.catalog.features) {
    const m = f.id.match(/^turntable\.unmixer(Four|Three|Two)TrackChannel(\d)Muted$/);
    const s = f.title.match(/\((\d)ch: ([^)]+)\)/);
    if (m && s) stems.set(`${s[1]}:${s[2].toLowerCase().replace("acappella", "acapella")}`, { ch: Number(m[2]), mode: m[1] });
  }

  server.registerTool(
    "djay_neural_mix",
    {
      title: "Neural Mix stems",
      description:
        "Real-time stem separation per deck. stem: drums, bass, harmonic, vocals (4-stem mode), or instrumental / acapella (2-stem). action: mute, unmute, solo, unsolo, volume (value 0..1), eq (value 0..1 stem EQ), swap. Also crossfader (value 0..1) for the Neural Mix crossfader. Requires djay's Neural Mix (subscription feature).",
      inputSchema: {
        deck: deckSchema,
        stem: z.enum(["drums", "bass", "harmonic", "vocals", "instrumental", "acapella"]).optional(),
        action: z.enum(["mute", "unmute", "solo", "unsolo", "volume", "eq", "swap", "crossfader"]),
        value: unit.optional(),
        stems: z.enum(["4", "3", "2"]).optional().describe("Stem layout; default 4 for drums/bass/harmonic/vocals, 2 for instrumental/acapella"),
      },
    },
    safe(async ({ deck, stem, action, value, stems: layout }) => {
      if (action === "crossfader") {
        if (value === undefined) throw new DjayError("pass value 0..1");
        return ok(await dj.set("turntable.unmixerCrossfade", value, deck));
      }
      if (!stem) throw new DjayError("pass stem");
      const n = layout ?? (stem === "instrumental" || stem === "acapella" ? "2" : "4");
      const s = stems.get(`${n}:${stem}`);
      if (!s) throw new DjayError(`stem '${stem}' is not available in ${n}-stem mode`);
      const base = `turntable.unmixer${s.mode}TrackChannel${s.ch}`;
      switch (action) {
        case "mute": return ok(await t(`${base}Muted`, deck, "on"));
        case "unmute": return ok(await t(`${base}Muted`, deck, "off"));
        case "solo": return ok(await t(`${base}Solo`, deck, "on"));
        case "unsolo": return ok(await t(`${base}Solo`, deck, "off"));
        case "swap": return ok(await t(`${base}Swapped`, deck));
        case "volume":
        case "eq":
          if (value === undefined) throw new DjayError("pass value 0..1");
          return ok(await dj.set(`${base}${action === "volume" ? "Volume" : "VolumeEQ"}`, value, deck));
      }
    }),
  );

  // ---------------- transitions ----------------
  server.registerTool(
    "djay_transition",
    {
      title: "Automated mix transition",
      description:
        "Mix from one deck to another automatically, in the background. styles: bass_swap (default: bring in the new track with its lows cut, swap basslines halfway, fade out), smooth (equal-power fade), filter_out (high-pass the outgoing track), echo_out, brake, cut, djay_auto (djay's own transition). " +
        "Length in beats (default 32, uses the outgoing deck's BPM) or seconds. By default syncs and starts the incoming deck and stops the outgoing one at the end. action status / cancel manage running jobs.",
      inputSchema: {
        action: z.enum(["start", "status", "cancel"]).default("start"),
        from: deckSchema.optional(),
        to: deckSchema.optional(),
        style: z.enum(["bass_swap", "smooth", "filter_out", "echo_out", "brake", "cut", "djay_auto"]).optional(),
        beats: z.number().min(1).max(256).optional(),
        seconds: z.number().min(0.5).max(600).optional(),
        sync: z.boolean().default(true),
        start_incoming: z.boolean().default(true),
        stop_outgoing: z.boolean().default(true),
        job_id: z.string().optional(),
      },
    },
    safe(async (a) => {
      if (a.action === "status") return ok({ jobs: listJobs() });
      if (a.action === "cancel") return ok({ cancelled: cancelJob(a.job_id) });
      if (!a.from || !a.to) throw new DjayError("pass from and to decks");
      const job = await startTransition(dj, {
        from: a.from,
        to: a.to,
        style: a.style,
        beats: a.beats,
        seconds: a.seconds,
        syncTarget: a.sync,
        startTarget: a.start_incoming,
        stopSource: a.stop_outgoing,
      });
      return ok({ started: job.id, durationSeconds: round(job.durationMs / 1000, 1), style: job.style, hint: "Poll with action 'status'." });
    }),
  );

  // ---------------- sampler & looper ----------------
  server.registerTool(
    "djay_sampler",
    {
      title: "Sampler",
      description:
        "Trigger djay's sampler pads. Global sampler: pad 1-16. Per-deck samplers: deck 1-2 with pad 1-8. action: play (respects djay's hold setting), stop, hold (play while held for hold_ms), volume (value 0..1, pad or whole sampler), sequence (toggle sequencer play/record), clear_sequence, show.",
      inputSchema: {
        action: z.enum(["play", "stop", "hold", "volume", "sequence", "clear_sequence", "show"]),
        pad: z.number().int().min(1).max(16).optional(),
        deck: z.number().int().min(1).max(2).optional().describe("Use a deck sampler instead of the global one"),
        value: unit.optional(),
        hold_ms: z.number().int().min(50).max(30000).optional(),
      },
    },
    safe(async ({ action, pad, deck, value, hold_ms }) => {
      const base = (p: number) => (deck ? `sampler.turntable${deck}.player${p}` : `sampler.player${p}`);
      if (action === "sequence") return ok(await t("sampler.toggleSequencePlayAndRecord"));
      if (action === "clear_sequence") return ok(await t("sampler.clearSequenceRecording"));
      if (action === "show") return ok(await t("sampler.toggleSamplerShown"));
      if (action === "volume") {
        if (value === undefined) throw new DjayError("pass value 0..1");
        return ok(await dj.set(pad ? `${base(pad)}.volume` : "sampler.volume", value));
      }
      if (!pad) throw new DjayError("pass pad");
      if (action === "play") return ok(await t(`${base(pad)}.playingConsideringHoldSetting`));
      if (action === "stop") return ok(await t(`${base(pad)}.paused`));
      return ok(await t(deck ? `${base(pad)}.playingConsideringHoldSetting` : `${base(pad)}.playingHold`, undefined, "hold", { holdMs: hold_ms ?? 1000 }));
    }),
  );

  server.registerTool(
    "djay_looper",
    {
      title: "Looper",
      description: "djay's Looper: trigger sample 1-6 on track 1-8, play_pause the looper, set a track's volume or the looper volume (0..1), or show/hide it.",
      inputSchema: {
        action: z.enum(["trigger", "play_pause", "volume", "show"]),
        track: z.number().int().min(1).max(8).optional(),
        sample: z.number().int().min(1).max(6).optional(),
        value: unit.optional(),
      },
    },
    safe(async ({ action, track, sample, value }) => {
      if (action === "play_pause") return ok(await t("looper.playPause"));
      if (action === "show") return ok(await t("looper.toggleLooperShown"));
      if (action === "volume") {
        if (value === undefined) throw new DjayError("pass value 0..1");
        return ok(await dj.set(track ? `looper.track${track}.volume` : "looper.volume", value));
      }
      if (!track || !sample) throw new DjayError("pass track and sample");
      return ok(await t(`looper.track${track}.sample${sample}.trigger`));
    }),
  );

  // ---------------- Automix, recording, view ----------------
  server.registerTool(
    "djay_automix",
    {
      title: "Automix",
      description:
        "djay's AI Automix: on, off, toggle, status, skip (transition to the next track now), add_selection (add the selected library track to the Automix queue), remove_selection, show_panel. The queue itself can be read with djay_library action 'queue'.",
      inputSchema: { action: z.enum(["on", "off", "toggle", "status", "skip", "add_selection", "remove_selection", "show_panel"]) },
    },
    safe(async ({ action }) => {
      switch (action) {
        case "on": return ok(await t("application.automix", undefined, "on"));
        case "off": return ok(await t("application.automix", undefined, "off"));
        case "toggle": return ok(await t("application.automix"));
        case "status": await dj.startMidi(); return ok({ automix: dj.mixer().automix, queue: dj.lib.queue() });
        case "skip": return ok(await t("mixer.transitionActiveToInactive"));
        case "add_selection": await dj.ax.menu(["Library", "Add Selection to Queue"]); return ok({ done: true });
        case "remove_selection": await dj.ax.menu(["Library", "Remove Selection from Queue"]); return ok({ done: true });
        case "show_panel": await dj.ax.press({ label: "Show Automix panel" }); return ok({ done: true });
      }
    }),
  );

  server.registerTool(
    "djay_record",
    {
      title: "Recording",
      description: "Record your mix: start, stop, status, list (recent recordings in ~/Music/djay/Recordings), stop_and_load (stop and load the recording onto a deck). djay blocks recording while streaming-service tracks are loaded; local files can be recorded.",
      inputSchema: { action: z.enum(["start", "stop", "status", "list", "stop_and_load"]), deck: deckSchema.optional() },
    },
    safe(async ({ action, deck }) => {
      if (action === "list") return ok({ recordings: dj.recordings() });
      if (action === "status") return ok(await dj.read(dj.feature("application.recording")));
      if (action === "stop_and_load") return ok(await t(`application.stopRecordingAndLoad${deck ?? 1}`));
      const r: Record<string, unknown> = await t("application.recording", undefined, action === "start" ? "on" : "off");
      if (action === "start" && r.warning) {
        r.warning =
          "djay did not start recording. djay disables mix recording while streaming tracks (Spotify, Apple Music, TIDAL...) are loaded on a deck; use local files or eject streaming tracks, then try again.";
      }
      return ok({ ...r, recent: action === "stop" ? dj.recordings(1) : undefined });
    }),
  );

  const VIEW: Record<string, string> = {
    two_decks: "application.viewModeTwoDeckTurntable",
    two_decks_pro: "application.viewModeTwoDeckPro",
    two_decks_simple: "application.viewModeTwoDeckSimple",
    sequencer: "application.viewModeTwoDeckSequencer",
    one_deck: "application.viewModeOneDeckTurntable",
    automix: "application.viewModeOneDeckAutomix",
    four_decks: "application.viewModeFourDeckWaveform",
    video: "application.viewModeVideo",
  };
  const PANELS: Record<string, string> = {
    cue_bar: "application.toggleShowCueBar",
    neural_mix_bar: "application.toggleShowUnmixerBar",
    fx: "application.toggleShowEffects",
    tools: "application.toggleShowTools",
    waveforms: "application.toggleShowWaveforms",
    sampler: "sampler.toggleSamplerShown",
    looper: "looper.toggleLooperShown",
    library: "musicLibrary.toggleLibraryVisible",
    split_library: "musicLibrary.toggleSplitLayout",
  };

  server.registerTool(
    "djay_view",
    {
      title: "Layout and view",
      description:
        `Switch djay's layout (mode: ${Object.keys(VIEW).join(", ")}) and toggle panels (toggle: ${Object.keys(PANELS).join(", ")}). Also waveform zoom in/out and undo/redo.`,
      inputSchema: {
        mode: z.enum(Object.keys(VIEW) as [string, ...string[]]).optional(),
        toggle: z.enum(Object.keys(PANELS) as [string, ...string[]]).optional(),
        zoom: z.enum(["in", "out"]).optional(),
        undo: z.boolean().optional(),
        redo: z.boolean().optional(),
      },
    },
    safe(async (a) => {
      const out: Record<string, unknown> = {};
      if (a.mode) out.mode = await t(VIEW[a.mode]);
      if (a.toggle) out.toggle = await t(PANELS[a.toggle]);
      if (a.zoom) out.zoom = await t(a.zoom === "in" ? "application.waveformZoomFactorPlus" : "application.waveformZoomFactorMinus");
      if (a.undo) out.undo = await t("application.undo");
      if (a.redo) out.redo = await t("application.redo");
      return ok(out);
    }),
  );
}
