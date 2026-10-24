# Reverse-engineering notes: djay Pro 5.6.10

Target: `/Applications/djay Pro.app`, version 5.6.10 (build 67091), bundle id `com.algoriddim.djay-iphone-free`, Mac App Store build (sandboxed), universal x86_64 + arm64.

Tools: [REA](https://github.com/morluto/rea) 6.7.0 CLI (`inspect-macho`, `inspect-native-dispatch-metadata`, `inspect-sqlite-database`, `observe-native-ui`), plus `plutil`, `strings`, `sqlite3` and live experiments against the running app. No decompiler (Hopper, Ghidra, IDA) was needed.

Each finding is marked **verified** (tested against the running app) or **inferred** (read from files but not exercised).

## 1. Control surfaces djay exposes

| Surface | Finding |
| --- | --- |
| AppleScript | No scripting dictionary. Not usable. |
| URL schemes | `djay://` and `djay-app://` are registered, but the binary's strings show them used only for OAuth callbacks (SoundCloud, Spotify, Beatport). Not a control channel. |
| Open file | `DJAppDelegate` implements `application:openFile:` and `handleOpenFile:` (REA dispatch metadata). Inferred: opening an audio file loads it. Not tested. |
| MIDI mappings | User mappings are XML plists (`.djayMidiMapping`, UTI `com.algoriddim.djay-midi-mapping`) in `~/Music/djay/MIDI Mappings`. **This is the main control channel.** |
| Key bindings | `.djayKeyBindings` files map keys to the same key paths as MIDI. Not needed once MIDI covers everything. |
| Accessibility | Rich labelled tree: decks, mixer, library tables, search box, menus. **Verified.** |
| Library | `~/Music/djay/djay Media Library.djayMediaLibrary/MediaLibrary.db`, a YapDatabase (SQLite) file. **Verified readable.** |
| MIDI clock / Ableton Link | `ARMidiClockController` (sends start and clock ticks) and `ARAbletonLinkController` plus the Ableton Link C++ library are in the binary. Inferred; not used yet. |

The sandbox container symlinks `~/Music`, so the user folder and the container path are the same files.

## 2. The MIDI feature catalog (all from the app bundle)

`Contents/Resources` holds everything needed to drive djay generically:

- `MidiModelKeyPath.strings` (UTF-16): 1,085 key paths with human titles, e.g. `turntable.lowEQ` = "Low EQ".
- `MidiModelMetadata.plist`: 944 entries, each with a `type` (`button-action`, `button-toggle`, `button-hold`, `button-trigger`, `control`) and the model paths djay reports back: `modelState` (on/off), `modelValue` (continuous), `modelEnabled`, `modelDescription` (text). Ten features take an `actionParameter` (FX index 0-120, pitch -12..12, view mode 0-7, crossfader FX 0-15).
- `MidiMappingMenu.plist`: the curated mapping menu, split into `button` and `control`, by category (`turntable`, `mixer`, `application`, `musicLibrary`, `sampler`, `looper`, `microphone`), with `# Section` headings.
- `MIDI Mappings/`: 210 shipped controller mappings, used as references for field usage.

Merging the three gives **1,274 features**. `turntable.*` features exist once per deck; in mapping files they are written `turntable1.*` to `turntable4.*` (or `turntableSelected.*`).

## 3. Mapping file format

Top level: `endpointName` (string or array), `uuid`, `schemeVersion` 1, `version`, `controls` (array), optional `outputs` (array), `userInfo`, `customClassName`, `USBID`.

A control entry:

```
{ keyPath, midiChannel (0-15), midiData (note or CC number), midiMessageType,
  [controlType: rotary | rotary-64 | rotary-absolute | button],
  [output: {...}], [actionParameter], [condition: "modifier2 == 1"], [suppressAutoSelect], [pickupMode] }
```

- `midiMessageType` 1 = note, 3 = control change. **Verified.** Shipped files also use 0, 2 and 6; by the MIDI status order these are likely note off, poly aftertouch and pitch bend. **Inferred.**
- `output: {}` makes djay send the feature's `modelState` back on the same address (127 on, 0 off). **Verified.**
- `output: {controlType: "control"}` sends `modelValue` instead, normalized 0..1 to 0..127 (`midiMinValue` / `midiMaxValue` rescale it). **Verified.**
- `outputs` entries send any model key path, without an input (meters, `display.songProgress`, `isPlaying`, `song.loadingSuccess`...). **Verified.**
- `userInfo.highResControls` is a per-channel list of LSB CC numbers. A CC n (MSB) plus CC n+32 (LSB) pair then gives 14-bit resolution. **Verified:** changing only the LSB moved tempo by 0.1-0.3%.
- `rotary-64` is a relative encoder (64 = no change). Used for `*Rotary` and `*Move` features.
- djay reads mapping files **only at launch**; a changed file is ignored until restart, even if the device reconnects. **Verified.**

The generator puts buttons on notes, absolute controls on 14-bit CC pairs (CC 0-31 + 32-63), relative encoders on CC 64-119, and feedback-only outputs on the remaining notes and CCs. Five ports keep each one under 2,048 note addresses (busiest port: 1,227).

## 4. Device naming rule (important)

djay merges hot-plugged MIDI devices whose names share leading words and renames them to the shared prefix. Words are split on spaces, hyphens and camelCase. **Verified** by experiment:

| Port names created | Names djay showed |
| --- | --- |
| `djay MCP Global`, `djay MCP Deck 1..4` | `djay MCP`, `djay MCP Deck` x3, `djay MCP Deck 1` |
| `djay MCP Deck A`, `djay MCP Deck B` | `djay MCP Deck` x2 |
| `djayMCPGlobal`, `djayMCPDeck1..4` | `djay` x5 |
| `MCPGlobal`, `MCPDeckOne`, `MCPDeckTwo` | unchanged |
| `Global djay MCP`, `One/Two/Three/Four djay MCP` | unchanged (used) |

A renamed device no longer matches its mapping's `endpointName`, so it gets no mapping and sends no feedback. djay stores the device-to-mapping link in its preferences as `<device name>.midiConfiguration`.

## 5. Runtime behaviour worth knowing

- djay sends a burst of all output states when it attaches to a port, about 0.4-0.9 s after the port appears. Messages sent earlier are lost, so the server waits for that burst. **Verified.**
- `turntable.playPause`'s state (`isPlayingButtonState`) is the button LED; it can be on while paused. The true flag is `turntableN.isPlaying`. **Verified** (a pause based on the LED toggled a paused deck on).
- Loading a track can auto-start the deck. **Verified.**
- Mix recording did not start while Spotify tracks were loaded and started with the decks empty. **Verified** (the cause is inferred to be streaming-service rules).
- Automix moves the crossfader normally even with a MIDI crossfader mapped. With "Current Playlist" as its source it plays from the visible list. **Verified.**
- Neural Mix mute did not engage on Spotify tracks. **Verified** that it did not engage; cause unknown.
- Tempo slider: ±16% default range with a snap zone near 0, so `djay_tempo` corrects in a closed loop against the display.

## 6. Accessibility tree

Labels follow `"<control>, Deck N"`: `Title`, `Artist`, `Remaining time`, `Key`, `Tempo` (slider, value like `-2.0%`), `Key Lock on-off` (value `Active`), `Line volume`, `High EQ`, `Mid EQ`, `Low EQ`, `Filter`, `Gain`, `Loop` (title `8 Beats`), `Skip Forward` (value `16 Beats`), and a button whose label is the BPM (`122.2, Deck 1`). Library tables: `Your Library` (outline of playlists), `Playlist` (current track list), `Library` (sources: My Collection, Apple Music, Spotify...). The search box (subrole `AXSearchField`, label `Search Spotify` etc.) accepts a value plus `AXConfirm`. Results appear in a **separate untitled table** with section rows ("Songs") and one cell per row holding title, album, artist, duration, key and "125 BPM". When that panel is open it has its own search box, and typing into the main one no longer re-runs the search.

## 7. Library database

YapDatabase layout: table `database2(rowid, collection, key, data, metadata)` plus secondary indexes and FTS tables. Collections used: `mediaItemTitleIDs`, `mediaItemAnalyzedData` (bpm, manualBPM, keySignatureIndex), `globalMediaItemLocations` (`spotify:track:…`, `apple-music:…` URIs, ISRC), `localMediaItemLocations` (file URLs + bookmarks), `mediaItemUserData` (play count, colour, gain), `historySessions`, `historySessionItems` (title, `deckNumber`, `startTime`), `queues` + `queueItems`, `mediaItemPlaylists`.

Records are **FastCoder v3** archives (magic bytes `TSAF` = 'FAST' little-endian, major 3, minor 3). Header: object count, class count, string count. Values are type-tagged (Nick Lockwood's FastCoder enum), numbers aligned to their size, strings NUL-terminated and remembered for aliases, NSCoding objects as class name + (value, key) pairs ending in nil. Two details found here: type **48** is a date in seconds since 2001-01-01, and **URLs are not entered in the object table**. With those, all 14,702 FastCoder records decode with object and string counts matching their headers. **Verified.**

`keySignatureIndex` i: root = floor(i / 2) semitones above C; even = major, odd = its relative minor. Camelot: 0 = 8B (C), 1 = 8A (Am), 2 = 3B (Db), 3 = 3A (Bbm) ... 22 = 1B (B), 23 = 1A (G#m). **Verified** against the Key column for 546 tracks.

## 8. REA evidence

Raw REA outputs are kept in `.rea-evidence/` (not committed): `macho.json`, `dispatch.json` (559 Objective-C classes, 4,622 method implementations), `sqlite.json`, `ax.json`. Classes of note: `DJAppDelegate` (`handleGetURLEvent:withReplyEvent:`, `application:openFile:`, `automixLoadNextTrack:`), `ARApplication` (`keyBindingsController`), `ARMidiClockController`, `ARMidiMapping` / `ARMidiControlMapping` / `ARMidiOutputMapping` (property names match the plist fields), `PYMIDIVirtualSource` / `PYMIDIVirtualDestination` (djay uses the PYMIDI library).
