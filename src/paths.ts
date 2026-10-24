import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN_DIR = join(PROJECT_ROOT, "bin");
export const DATA_DIR = join(PROJECT_ROOT, "data");

export const APP_PATH = process.env.DJAY_APP_PATH ?? "/Applications/djay Pro.app";
export const APP_RESOURCES = join(APP_PATH, "Contents", "Resources");
export const APP_BUNDLE_ID = "com.algoriddim.djay-iphone-free";

// djay is sandboxed, but its container symlinks ~/Music, so these are the real paths.
export const DJAY_DATA_DIR = join(homedir(), "Music", "djay");
export const USER_MAPPINGS_DIR = join(DJAY_DATA_DIR, "MIDI Mappings");
export const RECORDINGS_DIR = join(DJAY_DATA_DIR, "Recordings");
export const LIBRARY_DB = join(DJAY_DATA_DIR, "djay Media Library.djayMediaLibrary", "MediaLibrary.db");
export const PREFS_PLIST = join(
  homedir(),
  "Library/Containers",
  APP_BUNDLE_ID,
  "Data/Library/Preferences",
  `${APP_BUNDLE_ID}.plist`,
);

export const ADDRESS_MAP_FILE = join(DATA_DIR, "address-map.json");

export const MIDI_BRIDGE = join(BIN_DIR, "djay-midi-bridge");
export const AX_BRIDGE = join(BIN_DIR, "djay-ax-bridge");
export const WINDOWS_TOOL = join(BIN_DIR, "djay-windows");

/**
 * Virtual MIDI ports. One global port plus one per deck keeps every port under the 2048-note limit.
 * Each name must start with a different word: djay merges devices whose names share leading
 * words (split on spaces, hyphens and camelCase) and renames them to the shared prefix, which
 * breaks the name match with the mapping file.
 */
export const PORT_SUFFIX = "djay MCP";
export const GLOBAL_PORT = `Global ${PORT_SUFFIX}`;
const DECK_WORDS = ["One", "Two", "Three", "Four"];
export const deckPort = (deck: number) => `${DECK_WORDS[deck - 1]} ${PORT_SUFFIX}`;
export const ALL_PORTS = [GLOBAL_PORT, deckPort(1), deckPort(2), deckPort(3), deckPort(4)];
/** Matches mapping files this project wrote, including older naming schemes. */
export const isOwnMappingFile = (name: string) =>
  name.endsWith(".djayMidiMapping") && (name.endsWith(` ${PORT_SUFFIX}.djayMidiMapping`) || name.startsWith(`${PORT_SUFFIX} `));
