/**
 * core/npc-classifier.js — is this world NPC hostile or not?
 *
 * Pure decision logic for `npc-spawn-filter.js`. It reads plugin records
 * through a `lookup(formId)` function shaped exactly like
 * `mp.lookupEspmRecordById` (see `core/espm.js` for how that shape was read off
 * a live server), so it can be tested with recorded record data and no game.
 *
 * ─── The rule (owner decision, 2026-11-19) ──────────────────────────────────
 *
 *   KEEP    every creature: an actor whose race is NOT a person race
 *           (wolves, bears, draugr, dragons, spiders, falmer, horses...).
 *   KEEP    every person (human/elf/beast-folk race) that belongs to a hostile
 *           faction: bandits, Forsworn, necromancers, warlocks, vampires,
 *           Silver Hand, Miraak's cultists, Morag Tong...
 *   REMOVE  every other person: civilians, merchants, innkeepers, guards,
 *           travellers, Thalmor patrols. Players fill those roles.
 *
 * "Person race" = the RACE record carries the `ActorTypeNPC` keyword
 * (0x13794:Skyrim.esm), or has the Playable flag. Read from the five masters on
 * 2026-11-19: that covers the ten playable races, their vampire and child
 * variants, ElderRace, SnowElfRace, DLC1NordRace and DLC2DremoraRace, and none
 * of the creature races (Falmer, draugr and rieklings do NOT carry it).
 *
 * ─── Templates and leveled lists ────────────────────────────────────────────
 *
 * Most bandits are not placed as "a bandit": the reference points at an NPC_
 * whose TPLT field names another NPC_ or a leveled list (LVLN), and the ACBS
 * template flags say which data comes from the template — `UseTraits` (0x01)
 * for the race, `UseFactions` (0x04) for the factions. This walks the chain the
 * same way SkyMP's `EvaluateTemplate<Flag>` does (stop at the first element
 * that has no template, or whose template flag for that data is off).
 *
 * Two ways in:
 *   - `classifyChain(chain)` — the server already resolved the chain for that
 *     actor (`mp.get(actorId, 'templateChain')`, leveled lists included). That
 *     is exact: it is the NPC that actually spawned.
 *   - `classifyBase(baseId)` — no chain available. The chain is built here, and
 *     a leveled list is expanded to every NPC it can produce. All hostile →
 *     hostile; all peaceful → peaceful; both → `mixed` (the service keeps those
 *     by default — wrongly keeping a civilian is better than deleting a bandit
 *     camp).
 *
 * ─── Fail direction ─────────────────────────────────────────────────────────
 *
 * Anything that cannot be read (API missing, record missing, broken chain) is
 * `unknown`, and the service never removes `unknown`. This file decides what
 * stays in the world; it must not turn a read error into a disappearance.
 */

const NPC_TEMPLATE_USE_TRAITS = 0x01;
const NPC_TEMPLATE_USE_FACTIONS = 0x04;

// ActorTypeNPC keyword, Skyrim.esm. A master record, so its global id is fixed.
const ACTOR_TYPE_NPC_KEYWORD = 0x00013794;
const RACE_FLAG_PLAYABLE = 0x00000001;

const MAX_CHAIN_DEPTH = 16;
const MAX_LEVELED_DEPTH = 8;

const VERDICT = Object.freeze({
  HOSTILE: 'hostile',   // keep
  CREATURE: 'creature', // keep
  PEACEFUL: 'peaceful', // remove
  MIXED: 'mixed',       // leveled list that can produce both
  UNKNOWN: 'unknown'    // could not read — never removed
});

// ─────────────────────────────────────────────────────────────────────────────
// Byte helpers. `fields[i].data` is a Uint8Array on the real server (ScampServer
// builds it with Napi::Uint8Array::New). Recorded fixtures may come as plain
// arrays or as `{0: b0, 1: b1, ...}` objects after a JSON round-trip.
// ─────────────────────────────────────────────────────────────────────────────

function toBytes(data) {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (typeof data === 'object') {
    const keys = Object.keys(data).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
    const out = new Uint8Array(keys.length ? keys[keys.length - 1] + 1 : 0);
    for (const k of keys) out[k] = data[k] & 0xff;
    return out;
  }
  return new Uint8Array(0);
}

function u16(bytes, offset) {
  if (bytes.length < offset + 2) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  if (bytes.length < offset + 4) return null;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function fieldsOf(record, type) {
  const fields = record && Array.isArray(record.fields) ? record.fields : [];
  return fields.filter(f => f && f.type === type).map(f => toBytes(f.data));
}

function firstField(record, type) {
  const all = fieldsOf(record, type);
  return all.length ? all[0] : null;
}

/**
 * Plugin records name other records by a file-local id (top byte = index in
 * that plugin's master list). The lookup result's `toGlobalRecordId` maps it to
 * the server's load-order id. Without it, only Skyrim.esm-local ids are safe
 * to use as-is, which is what the fallback assumes.
 */
function globalizer(lookupResult) {
  if (lookupResult && typeof lookupResult.toGlobalRecordId === 'function') {
    return (localId) => {
      try {
        const g = lookupResult.toGlobalRecordId(localId);
        return Number.isFinite(g) ? g >>> 0 : localId;
      } catch (err) {
        return localId;
      }
    };
  }
  return (localId) => localId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NPC_ record → the parts the decision needs, ids already global.
 * ACBS layout (libespm NPC_.cpp): flags u32 @0 ... templateDataFlags u16 @18.
 */
function readNpc(lookupResult) {
  const record = lookupResult && lookupResult.record;
  if (!record || record.type !== 'NPC_') return null;
  const toGlobal = globalizer(lookupResult);

  const acbs = firstField(record, 'ACBS');
  const tplt = firstField(record, 'TPLT');
  const rnam = firstField(record, 'RNAM');
  const templateLocal = tplt ? u32(tplt, 0) : 0;
  const raceLocal = rnam ? u32(rnam, 0) : 0;

  return {
    id: record.id,
    editorId: record.editorId || null,
    templateFlags: acbs ? (u16(acbs, 18) || 0) : 0,
    template: templateLocal ? toGlobal(templateLocal) : 0,
    race: raceLocal ? toGlobal(raceLocal) : 0,
    // SNAM: faction formId u32 + rank i8 + 3 unused bytes, one per faction.
    factions: fieldsOf(record, 'SNAM').map(b => u32(b, 0)).filter(Boolean).map(toGlobal)
  };
}

/** LVLN record → global ids of every entry (LVLO: level u16, pad u16, formId u32, count u16, pad u16). */
function readLeveledEntries(lookupResult) {
  const record = lookupResult && lookupResult.record;
  if (!record || record.type !== 'LVLN') return null;
  const toGlobal = globalizer(lookupResult);
  return fieldsOf(record, 'LVLO').map(b => u32(b, 4)).filter(Boolean).map(toGlobal);
}

/** RACE record → is it a person race? `null` when the record is unreadable. */
function readRaceIsPerson(lookupResult) {
  const record = lookupResult && lookupResult.record;
  if (!record || record.type !== 'RACE') return null;
  const toGlobal = globalizer(lookupResult);

  const kwda = firstField(record, 'KWDA');
  if (kwda) {
    for (let o = 0; o + 4 <= kwda.length; o += 4) {
      if (toGlobal(u32(kwda, o)) === ACTOR_TYPE_NPC_KEYWORD) return true;
    }
  }
  // RACE DATA flags u32 @32 (libespm RACE.cpp).
  const data = firstField(record, 'DATA');
  const flags = data ? u32(data, 32) : null;
  return flags !== null && (flags & RACE_FLAG_PLAYABLE) !== 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {(formId: number) => object} options.lookup  `mp.lookupEspmRecordById`-shaped
 * @param {Iterable<number>} options.hostileFactionIds global FormIDs of hostile factions
 * @param {RegExp[]} [options.hostileFactionEditorIdPatterns] extra match on the faction's editorId
 * @param {RegExp[]} [options.hostileFactionEditorIdExclusions] editorIds that never count
 */
function createClassifier(options) {
  const lookup = options.lookup;
  const hostileFactionIds = new Set(Array.from(options.hostileFactionIds || [], id => id >>> 0));
  const patterns = options.hostileFactionEditorIdPatterns || [];
  const exclusions = options.hostileFactionEditorIdExclusions || [];

  const recordCache = new Map();
  const raceCache = new Map();
  const factionCache = new Map();
  const baseCache = new Map();

  function look(formId) {
    if (recordCache.has(formId)) return recordCache.get(formId);
    let res = null;
    try {
      const r = lookup(formId);
      res = r && r.record ? r : null;
    } catch (err) {
      res = null;
    }
    recordCache.set(formId, res);
    return res;
  }

  function isPersonRace(raceId) {
    if (!raceId) return null;
    if (raceCache.has(raceId)) return raceCache.get(raceId);
    const v = readRaceIsPerson(look(raceId));
    raceCache.set(raceId, v);
    return v;
  }

  function isHostileFaction(factionId) {
    if (hostileFactionIds.has(factionId)) return true;
    if (!patterns.length) return false;
    if (factionCache.has(factionId)) return factionCache.get(factionId);
    const rec = look(factionId);
    const edid = rec && rec.record.type === 'FACT' ? rec.record.editorId || '' : '';
    const hit = !!edid && patterns.some(p => p.test(edid)) && !exclusions.some(p => p.test(edid));
    factionCache.set(factionId, hit);
    return hit;
  }

  /**
   * SkyMP's EvaluateTemplate: first chain element with no template, or with
   * the flag for this data switched off, supplies the data.
   */
  function pick(npcs, flag) {
    for (const npc of npcs) {
      if (!npc.template || !(npc.templateFlags & flag)) return npc;
    }
    return null;
  }

  /** Decide from fully-resolved NPC_ records (head first). */
  function decide(npcs) {
    const raceSource = pick(npcs, NPC_TEMPLATE_USE_TRAITS);
    const factionSource = pick(npcs, NPC_TEMPLATE_USE_FACTIONS);
    if (!raceSource) return { verdict: VERDICT.UNKNOWN, reason: 'template chain does not resolve a race' };

    const person = isPersonRace(raceSource.race);
    if (person === null) {
      return { verdict: VERDICT.UNKNOWN, reason: `race 0x${(raceSource.race || 0).toString(16)} unreadable`, race: raceSource.race };
    }
    if (!person) {
      return { verdict: VERDICT.CREATURE, reason: 'creature race', race: raceSource.race };
    }
    if (!factionSource) {
      return { verdict: VERDICT.UNKNOWN, reason: 'template chain does not resolve factions', race: raceSource.race };
    }
    const hostile = factionSource.factions.find(isHostileFaction);
    if (hostile) {
      return { verdict: VERDICT.HOSTILE, reason: `hostile faction 0x${hostile.toString(16)}`, race: raceSource.race, faction: hostile };
    }
    return { verdict: VERDICT.PEACEFUL, reason: 'person race, no hostile faction', race: raceSource.race };
  }

  /** Server-resolved chain (`mp.get(actorId, 'templateChain')`). */
  function classifyChain(chain) {
    if (!Array.isArray(chain) || chain.length === 0) return { verdict: VERDICT.UNKNOWN, reason: 'empty template chain' };
    const npcs = [];
    for (const formId of chain.slice(0, MAX_CHAIN_DEPTH)) {
      const npc = readNpc(look(formId >>> 0));
      if (!npc) break; // SkyMP stops at the first non-NPC_ too
      npcs.push(npc);
    }
    if (!npcs.length) return { verdict: VERDICT.UNKNOWN, reason: 'template chain head is not an NPC_' };
    return decide(npcs);
  }

  /**
   * Every complete chain this base can produce. A leveled list forks the
   * chain once per entry; nested lists recurse.
   */
  function expandChains(prefix, nextId, depth, seen) {
    if (prefix.length >= MAX_CHAIN_DEPTH || depth > MAX_LEVELED_DEPTH) return [null];
    const rec = look(nextId);
    if (!rec) return [null];

    if (rec.record.type === 'NPC_') {
      if (seen.has(nextId)) return [null];
      const npc = readNpc(rec);
      const chain = prefix.concat(npc);
      // Same stop rule as `pick`: once both race and factions are settled,
      // the rest of the chain cannot change the answer.
      const settled = pick(chain, NPC_TEMPLATE_USE_TRAITS) && pick(chain, NPC_TEMPLATE_USE_FACTIONS);
      if (settled || !npc.template) return [chain];
      return expandChains(chain, npc.template, depth, new Set(seen).add(nextId));
    }

    if (rec.record.type === 'LVLN') {
      if (seen.has(nextId)) return [null];
      const entries = readLeveledEntries(rec) || [];
      if (!entries.length) return [null];
      const nextSeen = new Set(seen).add(nextId);
      const out = [];
      for (const entry of new Set(entries)) out.push(...expandChains(prefix, entry, depth + 1, nextSeen));
      return out;
    }

    return [null];
  }

  /** Static decision from the reference's base record (`baseDesc`). */
  function classifyBase(baseId) {
    baseId = baseId >>> 0;
    if (baseCache.has(baseId)) return baseCache.get(baseId);

    const chains = expandChains([], baseId, 0, new Set());
    const verdicts = chains.map(c => (c ? decide(c) : { verdict: VERDICT.UNKNOWN, reason: 'unreadable chain' }));

    let result;
    if (verdicts.some(v => v.verdict === VERDICT.UNKNOWN)) {
      result = verdicts.find(v => v.verdict === VERDICT.UNKNOWN);
    } else {
      const removed = verdicts.filter(v => v.verdict === VERDICT.PEACEFUL);
      if (removed.length === 0) result = verdicts.find(v => v.verdict === VERDICT.HOSTILE) || verdicts[0];
      else if (removed.length === verdicts.length) result = removed[0];
      else result = { verdict: VERDICT.MIXED, reason: `leveled list: ${removed.length} of ${verdicts.length} outcomes are peaceful` };
    }
    result = Object.assign({ outcomes: verdicts.length }, result);
    baseCache.set(baseId, result);
    return result;
  }

  return {
    classifyChain,
    classifyBase,
    clearCache: () => { recordCache.clear(); raceCache.clear(); factionCache.clear(); baseCache.clear(); }
  };
}

/** Removed from the world? Only `peaceful`, plus `mixed` when the policy says so. */
function shouldRemoveVerdict(verdict, { removeMixed = false } = {}) {
  if (verdict === VERDICT.PEACEFUL) return true;
  if (verdict === VERDICT.MIXED) return removeMixed === true;
  return false;
}

module.exports = {
  VERDICT,
  ACTOR_TYPE_NPC_KEYWORD,
  NPC_TEMPLATE_USE_TRAITS,
  NPC_TEMPLATE_USE_FACTIONS,
  createClassifier,
  shouldRemoveVerdict,
  // exposed for tests
  _readNpc: readNpc,
  _readLeveledEntries: readLeveledEntries,
  _readRaceIsPerson: readRaceIsPerson,
  _toBytes: toBytes
};
