// Automated transitions between two decks, run as cancellable background jobs.
// Uses the channel (line) faders, EQs and filter, so it does not depend on how the
// crossfader sides are assigned; the crossfader is centred first.
import { Djay, DjayError, round, sleep } from "./djay.js";

export type TransitionStyle = "smooth" | "bass_swap" | "filter_out" | "echo_out" | "brake" | "cut" | "djay_auto";

export interface TransitionJob {
  id: string;
  from: number;
  to: number;
  style: TransitionStyle;
  durationMs: number;
  status: "running" | "done" | "cancelled" | "failed";
  progress: number;
  startedAt: string;
  finishedAt?: string;
  log: string[];
  error?: string;
}

const jobs = new Map<string, { job: TransitionJob; abort: AbortController }>();
let counter = 0;

export function listJobs(): TransitionJob[] {
  return [...jobs.values()].map((j) => j.job).slice(-20);
}

export function cancelJob(id?: string): TransitionJob[] {
  const out: TransitionJob[] = [];
  for (const j of jobs.values()) {
    if ((!id || j.job.id === id) && j.job.status === "running") {
      j.abort.abort();
      out.push(j.job);
    }
  }
  return out;
}

export async function startTransition(
  dj: Djay,
  opts: {
    from: number;
    to: number;
    style?: TransitionStyle;
    seconds?: number;
    beats?: number;
    startTarget?: boolean;
    syncTarget?: boolean;
    stopSource?: boolean;
  },
): Promise<TransitionJob> {
  if (opts.from === opts.to) throw new DjayError("from and to must be different decks");
  await dj.startMidi();
  const style = opts.style ?? "bass_swap";
  const src = await dj.deck(opts.from);
  const dst = await dj.deck(opts.to);
  if (!dst.loaded) throw new DjayError(`Deck ${opts.to} has no track loaded. Load one first (djay_load).`);
  const bpm = src.bpm ?? dst.bpm ?? 120;
  const durationMs = Math.round(
    opts.seconds !== undefined ? opts.seconds * 1000 : ((opts.beats ?? 32) * 60_000) / (bpm * (1 + (src.tempoPercent ?? 0) / 100)),
  );
  const job: TransitionJob = {
    id: `mix-${++counter}`,
    from: opts.from,
    to: opts.to,
    style,
    durationMs,
    status: "running",
    progress: 0,
    startedAt: new Date().toISOString(),
    log: [],
  };
  const abort = new AbortController();
  jobs.set(job.id, { job, abort });
  run(dj, job, abort.signal, {
    startTarget: opts.startTarget ?? true,
    syncTarget: opts.syncTarget ?? true,
    stopSource: opts.stopSource ?? true,
  }).catch((e) => {
    job.status = "failed";
    job.error = String(e?.message ?? e);
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

async function run(dj: Djay, job: TransitionJob, signal: AbortSignal, o: { startTarget: boolean; syncTarget: boolean; stopSource: boolean }) {
  const { from: A, to: B, durationMs } = job;
  const log = (s: string) => job.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  const vol = (deck: number) => `mixer.lineVolume${deck}`;
  const check = () => {
    if (signal.aborted) throw new Error("cancelled");
  };

  try {
    if (job.style === "djay_auto") {
      log("using djay's built-in transition to the inactive deck");
      if (o.syncTarget) await dj.trigger("turntable.bpmSync", { deck: B, mode: "on" });
      await dj.trigger("mixer.transitionActiveToInactive");
      await sleep(durationMs);
      job.progress = 1;
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      return;
    }

    // Prepare the incoming deck: silent, neutral filter, lows cut for a bass swap.
    await dj.set(vol(B), 0);
    await dj.set("turntable.filter", 0.5, B);
    if (job.style === "bass_swap") await dj.set("turntable.lowEQ", 0, B);
    if (o.syncTarget) {
      await dj.trigger("turntable.bpmSync", { deck: B, mode: "on" });
      log(`deck ${B} synced`);
    }
    const mixer = dj.mixer();
    if (mixer.crossfader === undefined || Math.abs(mixer.crossfader - 0.5) > 0.02) {
      await dj.ramp("mixer.crossfade", 0.5, 400, { signal });
      log("crossfader centred");
    }
    if (o.startTarget) {
      await dj.setPlaying(B, true);
      log(`deck ${B} playing`);
    }
    check();

    if (job.style === "cut") {
      await dj.set(vol(B), 1);
      await dj.set(vol(A), 0);
    } else if (job.style === "echo_out" || job.style === "brake") {
      await dj.ramp(vol(B), 1, Math.min(durationMs, 2000), { signal });
      await dj.trigger(job.style === "echo_out" ? "turntable.echoTransitionEffect" : "turntable.brakeTransitionEffect", { deck: A });
      log(`${job.style} fired on deck ${A}`);
      await sleep(Math.max(0, durationMs - 2000));
    } else {
      const steps = Math.max(8, Math.round(durationMs / 40));
      const t0 = Date.now();
      let swapped = false;
      for (let i = 1; i <= steps; i++) {
        check();
        const x = i / steps;
        job.progress = round(x, 2);
        // Equal-power style curves for the faders.
        dj.midi!.setControl(dj.midi!.binding(vol(B), 0)!, Math.sin((x * Math.PI) / 2));
        dj.midi!.setControl(dj.midi!.binding(vol(A), 0)!, job.style === "smooth" ? Math.cos((x * Math.PI) / 2) : x < 0.75 ? 1 : 1 - (x - 0.75) / 0.25);
        if (job.style === "bass_swap" && !swapped && x >= 0.5) {
          swapped = true;
          await dj.set("turntable.lowEQ", 0, A);
          await dj.set("turntable.lowEQ", 0.5, B);
          log("bass swapped");
        }
        if (job.style === "filter_out") {
          dj.midi!.setControl(dj.midi!.binding("turntable.filter", A)!, 0.5 + 0.45 * x);
        }
        const wait = t0 + (durationMs * i) / steps - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }

    // Finish: source silent and stopped, EQ/filter reset, source fader back up for next time.
    await dj.set(vol(B), 1);
    await dj.set(vol(A), 0);
    if (o.stopSource) {
      await dj.setPlaying(A, false);
      log(`deck ${A} stopped`);
    }
    await dj.set("turntable.lowEQ", 0.5, A);
    await dj.set("turntable.filter", 0.5, A);
    if (o.stopSource) await dj.set(vol(A), 1);
    job.progress = 1;
    job.status = "done";
    log("transition complete");
  } catch (e: any) {
    if (signal.aborted) {
      job.status = "cancelled";
      log("cancelled; faders left where they were");
    } else throw e;
  } finally {
    job.finishedAt ??= new Date().toISOString();
  }
}
