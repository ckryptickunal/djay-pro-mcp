#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// djay Pro MCP server (stdio). Never write to stdout here: it carries the MCP protocol.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Djay } from "./djay.js";
import { registerGeneric } from "./tools/generic.js";
import { registerPerform } from "./tools/perform.js";
import { registerSystem } from "./tools/system.js";

const INSTRUCTIONS = `Controls djay Pro (Algoriddim) on this Mac.
How it works: five virtual MIDI ports ("Global djay MCP" and "One"-"Four djay MCP" for decks 1-4) carry generated mappings for every MIDI-mappable djay feature, and djay reports state back over them. Text readouts (title, artist, BPM, key, time) and the library browser come from djay's accessibility tree; the track catalog, history and Automix queue come from djay's library database.
Start with djay_status. If mappings are missing or djay shows no feedback, run djay_setup (restart_djay: true restarts djay so it loads them).
Typical flow: djay_library search -> djay_load -> djay_transport play -> djay_tempo / sync -> djay_transition to mix into the other deck.
Use the dedicated tools for common jobs (deck, transport, tempo, mixer, loop, cue, fx, neural_mix, sampler, looper, automix, record, view, transition). For anything else, find the feature with djay_features and drive it with djay_trigger / djay_set / djay_get. djay_menu and djay_ui reach any menu item or visible control; djay_screenshot shows the window.
Values for continuous controls are 0..1 (0.5 = neutral for EQ, filter, gain, pan, tempo).
Be mindful that actions produce real audio on the user's speakers.`;

const dj = new Djay();
const server = new McpServer({ name: "djay-pro", version: "0.1.0" }, { instructions: INSTRUCTIONS });
registerSystem(server, dj);
registerPerform(server, dj);
registerGeneric(server, dj);

// Bring the virtual ports up right away so djay sees the controllers.
dj.startMidi().catch((e) => console.error(`[djay-mcp] MIDI not started: ${e?.message ?? e}`));

const shutdown = () => {
  dj.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
console.error(`[djay-mcp] ready: ${dj.catalog.features.length} djay features (djay ${dj.catalog.appVersion})`);
