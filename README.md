# djay Pro MCP

An MCP server that lets Claude (or any MCP client) drive **djay Pro for Mac** (Algoriddim): decks, mixer, tempo and sync, loops, hot cues, FX, Neural Mix, sampler, looper, Automix, recording, layouts, menus and the music library, plus automated transitions between decks.

It was built by reverse-engineering djay Pro 5.6.10 with [REA (Reverse Engineer Anything)](https://github.com/morluto/rea). See [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md) for what was found and how.

## How it works

djay has no scripting API, so the server uses three channels djay already supports:

| Channel | What it gives | How |
| --- | --- | --- |
| **Virtual MIDI controllers** | Control of every MIDI-mappable feature (1,274 in djay 5.6.10, per deck where relevant) and live state feedback (play state, sync, loops, FX on/off, every knob and fader value, level meters, track progress) | Five virtual CoreMIDI ports, plus `.djayMidiMapping` files generated from djay's own resource files and installed in `~/Music/djay/MIDI Mappings` |
| **Accessibility** | Text readouts (title, artist, BPM, key, remaining time, tempo %), the library browser, djay's search box, every menu item and any visible control | A small Swift helper that reads djay's accessibility tree |
| **Library database** | Offline search of every track djay knows (BPM, Camelot key, source, play count), DJ history sessions with deck and time per track, the Automix queue | Read-only access to djay's YapDatabase file, decoding its FastCoder records |

The ports are named `Global djay MCP`, `One djay MCP`, `Two djay MCP`, `Three djay MCP` and `Four djay MCP`. The global port carries mixer, app, library, sampler, looper and microphone features. Each deck port carries one deck's features. djay sees them as five connected controllers.

## Requirements

- macOS with djay Pro installed at `/Applications/djay Pro.app` (set `DJAY_APP_PATH` to override)
- Node.js 22.13 or newer (uses the built-in `node:sqlite`)
- Xcode command line tools (`swiftc`) to build the three small Swift helpers
- **Accessibility permission** for the app that launches the server (Claude, Terminal...): System Settings > Privacy & Security > Accessibility

## Install

```bash
git clone https://github.com/ckryptickunal/djay-pro-mcp.git
```

```bash
cd djay-pro-mcp && npm install && npm run build
```

```bash
npm run setup
```

`npm run build` compiles the TypeScript server and the Swift helpers. `npm run setup` writes the five mapping files. djay reads mappings only when it launches, so **restart djay Pro once** afterwards. The `djay_setup` tool with `restart_djay: true` does both for you.

Register with Claude Code, from inside the project folder:

```bash
claude mcp add --scope user djay-pro -- "$(which node)" --disable-warning=ExperimentalWarning "$(pwd)/dist/index.js"
```

Other MCP clients: run `node --disable-warning=ExperimentalWarning /path/to/djay-pro-mcp/dist/index.js` as a stdio server.

Check everything with:

```bash
npm run doctor
```

## Tools

Start with `djay_status`. It reports whether djay is running, whether the mappings are installed and current, and whether djay is sending state back.

| Tool | Purpose |
| --- | --- |
| `djay_status` | Health check and a summary of what each deck is playing |
| `djay_setup` | Generate and install mappings; optionally restart djay to load them |
| `djay_app` | Launch (in the background), show, hide, quit, restart djay |
| `djay_deck` | Full state of one or all decks: track, BPM, key, time, playing, sync, key lock, loop, tempo, meters, volume, EQ, filter |
| `djay_transport` | play, pause, cue, play from start, sync on/off, sync master, key lock, reverse, slip, repeat, quantize, brake, echo out, censor, instant double, eject, load next/previous, match key |
| `djay_tempo` | Set tempo % or a target BPM, or match another deck. Closed loop: reads djay's display back and corrects. Also nudge and tempo range |
| `djay_mixer` | Crossfader, master, booth, headphones, cue mix, crossfader curve, and per deck: volume, 3-band EQ, filter, gain, pan, EQ kills, headphone cue, crossfader side. Optional smooth ramps |
| `djay_loop` | Beat loops 1/32 to 128 beats, loop in/out/exit/reloop, half/double, loop roll, beat jump 1/8 to 64 beats |
| `djay_cue` | Hot cues 1-16 (pad, jump, set, clear), start point, clear all |
| `djay_fx` | FX slots 1-3 (enable, select by index or next/prev, parameter, wet/dry), XY pad FX, Instant FX 1-8 |
| `djay_neural_mix` | Stem mute/solo/volume/EQ (drums, bass, harmonic, vocals; instrumental/acapella) and the Neural Mix crossfader |
| `djay_transition` | Automated mix from one deck to another in the background: `bass_swap`, `smooth`, `filter_out`, `echo_out`, `brake`, `cut`, `djay_auto`; length in beats or seconds; status and cancel |
| `djay_sampler` | Global sampler pads 1-16 and per-deck sampler pads, volume, sequencer |
| `djay_looper` | Looper tracks 1-8 x samples 1-6, play/pause, volumes |
| `djay_automix` | Automix on/off/skip, add or remove the selected track from the queue, show panel |
| `djay_record` | Start/stop mix recording, list recordings |
| `djay_view` | Layouts (two decks, four decks, automix, video...), show/hide panels, waveform zoom, undo/redo |
| `djay_library` | Database search (text, BPM range, key, harmonically compatible keys, source), queue, history, stats; plus the live browser: browse rows, sources, playlists, open a source or playlist, search in djay |
| `djay_load` | Load a track by text, title + artist, library id, list row or local file; waits until it is on the deck; does not start playback unless `play: true` |
| `djay_features` | Search the full catalog of 1,274 controllable features |
| `djay_trigger` / `djay_set` / `djay_get` | Drive or read **any** feature by id: buttons (tap, press, hold, on/off), absolute controls (0..1, 14-bit, with ramps), relative encoders (steps) |
| `djay_sequence` | Timed list of trigger/set/ramp/turn steps, for scripted moves |
| `djay_menu` | List or click any djay menu item |
| `djay_ui` | Find, press or set any visible control through accessibility |
| `djay_screenshot` | Image of djay's window, even when it is behind other windows |
| `djay_midi_raw` | Send raw MIDI on one of the ports (debugging) |

Continuous values are 0..1. For EQ, filter, gain, pan and tempo, 0.5 is neutral; for the crossfader, 0 is left and 1 is right.

### Example requests

- "Load Digital Love by Daft Punk on deck 1 and One More Time on deck 2, match their BPM, and do a 32-beat bass-swap transition."
- "Find tracks between 120 and 126 BPM that mix harmonically with 8A."
- "Set a 4-beat loop on deck 1, then fade the filter to high-pass over 8 seconds."
- "What did I play in my last DJ session?"

## What was tested live (djay 5.6.10, macOS 27.0.1)

Tested end to end through the MCP protocol, with master volume at 0:

- Setup, restarting djay, all five ports connecting (at djay launch and hot-plugged while djay runs), about 1,900 live state values
- Library database search and filters; history, queue and stats; djay's search box and the results panel
- Loading Spotify tracks onto decks 1 and 2, refusing loads when no result matches
- Play/pause (idempotent), tempo % (exact to 0.1%), BPM matching, sync, 4-beat loop on/off, setting a hot cue, FX slot on/wet-dry/off, eject
- An 8-beat `bass_swap` transition from deck 1 to deck 2
- Automix on, skip, off
- Mix recording start/stop (with no streaming tracks loaded)
- Menu clicks, accessibility search, screenshots

Built but **not yet exercised live**: sampler, looper, view modes, `djay_sequence`, the other transition styles, tempo nudge, crossfader curve menu, loading from a local file path, opening playlists from the sidebar.

## Known limits

- **djay must be restarted once** after mappings are installed or regenerated (for example after a djay update; `djay_status` tells you).
- **Auto-play on load:** djay may start a deck when a track loads. `djay_load` pauses it again unless you pass `play: true`.
- **Recording** does not start while streaming-service tracks are loaded on a deck (observed with Spotify); it works with local files.
- **Neural Mix** stem mute did not engage on the Spotify tracks used in testing. The cause (track source or subscription) was not confirmed. The tool reports a warning when djay does not change state.
- **One session at a time:** each running copy of the server creates the five ports. Two Claude sessions using it at once would create duplicate controllers.
- Track text readouts (title, BPM, key, time) come from accessibility, so the main window must exist (it can be hidden behind other windows).
- No Ableton Link yet; tempo readouts come from djay's display (0.1 BPM resolution).
- The MCP produces real audio. Ask before playing loud material.

## Uninstall

```bash
claude mcp remove djay-pro -s user
```

```bash
node dist/cli.js uninstall
```

The second command deletes only the five generated mapping files. Your own controller mappings in the same folder are never touched.

## Project layout

```
bridge/        Swift helpers: MIDI ports, accessibility, window list
src/catalog.ts feature catalog built from djay's resource files
src/mapping.ts address allocation + mapping file generator
src/midi.ts    MIDI bridge client and feedback decoder
src/ax.ts      accessibility client and deck readout parser
src/library/   FastCoder decoder and library database reader
src/djay.ts    controller tying it together
src/mix.ts     automated transitions
src/tools/     MCP tool definitions
scripts/       build script and an end-to-end MCP test client
docs/          reverse-engineering notes
```

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by or supported by Algoriddim. djay and djay Pro are trademarks of Algoriddim GmbH. The server only talks to your own installed copy of djay through interfaces djay already offers (MIDI controller mappings, macOS accessibility and its local library file). It ships no djay code or resources, bypasses no licensing, and reads djay's resource files from your installation at runtime.

## License

MIT. See [LICENSE](LICENSE).
