/**
 * Types for `parity.mjs`.
 *
 * The module is plain JS so `node --test` runs with no build step; this
 * declaration is what keeps `main.ts` typechecked when importing it.
 */

export interface PluginHeader {
  masters: string[];
  isMaster: boolean;
  isLight: boolean;
  error?: string;
}

export interface PluginEntry {
  name: string;
  enabled: boolean;
}

export interface ServerMod {
  filename: string;
  hash: string;
}

export function parsePluginsTxt(content: string): PluginEntry[];

export function parsePluginHeader(buffer: Buffer | null | undefined): PluginHeader;

export function compareMods(params: {
  serverMods: ServerMod[] | null | undefined;
  localFiles: string[];
  // Async on purpose: hashing a whole reference .esm/.bsa at once (e.g.
  // fs.readFileSync) blew the process memory before the game opened. An async
  // hashOf lets the caller hash via a stream.
  hashOf: (filename: string) => string | Promise<string>;
  // Algorithm declared by the manifest. A different HASH_ALGORITHM fails with
  // a message pointing at the cause (an old manifest), not at "corrupted
  // mod".
  hashAlgorithm: string | undefined;
  // Files hashed in parallel (default 4) -- sequential made big manifests
  // take minutes with the disk idle between reads.
  concurrency?: number;
}): Promise<{ success: boolean; error?: string }>;

export function analyzePlugins(params: {
  localPlugins: string[];
  serverLoadOrder: string[] | null | undefined;
  enabledPlugins?: string[];
  readHeader: (name: string) => PluginHeader;
}): { ok: boolean; problems: string[]; plugins: Array<{ name: string } & PluginHeader> };

export const HASH_ALGORITHM: 'sha256';

export function parseCccTxt(content: string | null | undefined): string[];

/**
 * `effective` is the Creation Club plugins the game actually loads: listed in
 * `Skyrim.ccc` **and** present in `Data/`.
 */
export function analyzeCreationClub(params: {
  cccEntries: string[] | null | undefined;
  localPlugins: string[] | null | undefined;
  serverLoadOrder: string[] | null | undefined;
  /** plugins.txt entries: CC enabled there counts as loaded (no Skyrim.ccc needed). */
  enabledPlugins?: string[] | null;
}): { ok: boolean; problems: string[]; effective: string[] };
