#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Terminal helper: `node dist/cli.js setup | doctor | features [query] | uninstall`
import { existsSync } from "node:fs";
import { loadCatalog, searchFeatures } from "./catalog.js";
import { Djay } from "./djay.js";
import { installMappings, removeMappings } from "./mapping.js";
import { AX_BRIDGE, MIDI_BRIDGE, WINDOWS_TOOL } from "./paths.js";

const [cmd = "doctor", ...rest] = process.argv.slice(2);

async function main() {
  if (cmd === "setup") {
    const res = installMappings();
    console.log(`Wrote ${res.files.length} mapping files:`);
    res.files.forEach((f) => console.log(`  ${f}`));
    if (res.removed.length) console.log(`Removed stale: ${res.removed.join(", ")}`);
    console.log("Address usage per port:", res.map.counts);
    console.log("Restart djay Pro so it loads the mappings (djay reads them only at launch).");
    return;
  }
  if (cmd === "uninstall") {
    const removed = removeMappings();
    console.log(removed.length ? `Removed: ${removed.join(", ")}` : "No djay MCP mappings found.");
    return;
  }
  if (cmd === "features") {
    const r = searchFeatures(loadCatalog(), { query: rest.join(" "), limit: 200 });
    for (const f of r.items) console.log(`${f.id.padEnd(60)} ${f.kind.padEnd(8)} ${f.title}`);
    console.log(`${r.total} matching`);
    return;
  }
  // doctor
  const checks: [string, boolean, string][] = [];
  checks.push(["MIDI bridge built", existsSync(MIDI_BRIDGE), MIDI_BRIDGE]);
  checks.push(["Accessibility bridge built", existsSync(AX_BRIDGE), AX_BRIDGE]);
  checks.push(["Window tool built", existsSync(WINDOWS_TOOL), WINDOWS_TOOL]);
  const dj = new Djay();
  checks.push(["djay Pro found", true, `${dj.catalog.appVersion} (${dj.catalog.features.length} features)`]);
  const m = dj.mappingStatus();
  checks.push(["Mappings installed", m.installed, m.files.join(", ") || "run: npm run setup"]);
  checks.push(["Mappings match djay version", m.upToDate, `${m.mapAppVersion ?? "-"} vs ${m.appVersion}`]);
  const running = await dj.isRunning();
  checks.push(["djay running", running, running ? "yes" : "start djay Pro"]);
  try {
    const s = await dj.ax.status();
    checks.push(["Accessibility permission", s.trusted, s.trusted ? "granted" : "grant it in System Settings > Privacy & Security > Accessibility"]);
  } catch (e) {
    checks.push(["Accessibility bridge", false, String(e)]);
  }
  if (m.installed && running) {
    await dj.startMidi();
    await new Promise((r) => setTimeout(r, 3000));
    const n = dj.midi?.state.size ?? 0;
    checks.push(["djay reports state over MIDI", n > 0, `${n} state values received`]);
  }
  for (const [name, pass, detail] of checks) console.log(`${pass ? "OK  " : "FAIL"} ${name.padEnd(32)} ${detail}`);
  dj.shutdown();
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
