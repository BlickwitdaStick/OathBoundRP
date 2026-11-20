/**
 * npc-spawn-filter.js — hostiles stay in the world, peaceful NPCs go
 *
 * Owner decision (2026-11-19): bandits, wolves, bears and every other hostile
 * creature or hostile-faction NPC should exist; every non-hostile person
 * (civilians, merchants, innkeepers, guards, everywhere) should not, because
 * players fill those roles. This overrides the "bandits out" line of
 * `docs/technical/NPC_POLICY_DECISION.md`. Operator guide:
 * `docs/technical/NPC_SPAWN_FILTER.md`.
 *
 * ─── Why this is a gamemode service and not server config ───────────────────
 *
 * SkyMP's own NPC switches (`npcEnabled`, `npcSettings`) only filter by plugin
 * and interior/exterior. They cannot tell a bandit from a farmer. SkyMP already
 * refuses to load essential, protected and unique NPCs and anyone in a town
 * crime faction (`WorldState::AttachEspmRecord`, CrimeFactionsList 0x26953), so
 * named townsfolk and guards never spawn at all. What is left — generic
 * travellers, hunters, Thalmor patrols, leveled civilians, mod-added NPCs — is
 * what this service handles. The decision itself lives in
 * `core/npc-classifier.js`.
 *
 * ─── How NPCs are found ─────────────────────────────────────────────────────
 *
 * NOT via `mp.getActorsByProfileId(0)`: SkyMP only indexes profileIds > 0
 * (`MpObjectReference::RegisterProfileId`), so that call always returns an
 * empty list. Instead, each sweep reads `mp.get(0, 'onlinePlayers')` and, for
 * each player, `mp.get(player, 'actorNeighbors')` — exactly the actors the
 * server streams to that player. An NPC that no player is near is never
 * loaded and does not need a decision yet.
 *
 * ─── What "remove" means ────────────────────────────────────────────────────
 *
 * `mp.set(actorId, 'isDisabled', true)` — the reversible `Disable()` on the
 * reference, persisted in its change form. Never `delete`. `/npcfilter restore
 * <hex id>` puts one back.
 *
 * ─── Safe radius ────────────────────────────────────────────────────────────
 *
 * A peaceful NPC is disabled only when no online player is within
 * `safeRadius` of it (other cells count as far away). Until then it stays in a
 * pending set that every sweep re-checks — even after it drops out of every
 * player's neighbour list — so it goes away as soon as people leave, and is
 * already gone the next time anyone walks in. `disableOnFirstSight` (off by
 * default) trades that for removing an NPC the moment it first streams in.
 */

const fs = require('fs');
const path = require('path');
const classifierLib = require('./core/npc-classifier');
const rangeUtils = require('./core/range-utils');

const { VERDICT } = classifierLib;

const CONFIG_PATH = path.resolve(__dirname, '../config/npc-spawn-filter.json');

// World references from plugins are below this. 0xFF... ids are forms the
// server created: player characters and anything a gamemode placed. Never ours.
const FIRST_RUNTIME_FORM_ID = 0xff000000;

/**
 * Hostile factions, read from the masters on 2026-11-19 (FACT records,
 * editorId → FormID). Descs, not numeric ids: the top byte of a FormID is the
 * load-order index, so a DLC id only means something next to its plugin name.
 * Creature-only factions are left out on purpose — creatures are kept by race.
 */
const DEFAULT_HOSTILE_FACTIONS = Object.freeze([
  '1bcc0:Skyrim.esm',      // BanditFaction (also reavers and most dungeon bandits)
  '43599:Skyrim.esm',      // ForswornFaction
  '34b74:Skyrim.esm',      // NecromancerFaction
  '26724:Skyrim.esm',      // WarlockFaction
  '27242:Skyrim.esm',      // VampireFaction
  'aa0a4:Skyrim.esm',      // SilverHandFaction
  '43597:Skyrim.esm',      // DremoraFaction
  '2b0e5:Skyrim.esm',      // DaedraFaction
  '4359e:Skyrim.esm',      // HagravenFaction
  '2430d:Skyrim.esm',      // DraugrFaction
  '2997e:Skyrim.esm',      // FalmerFaction
  '106643:Skyrim.esm',     // DragonPriestFaction
  '43594:Skyrim.esm',      // WerewolfFaction
  '3376:Dawnguard.esm',    // DLC1VampireFaction (Volkihar)
  '34fbc:Dragonborn.esm',  // DLC2CultistFaction (Miraak's cultists)
  '2929a:Dragonborn.esm',  // DLC2MoragTongFaction
  '2bc5d:Dragonborn.esm'   // DLC2MiraakFaction
]);

// Dungeon- and event-specific copies (dunRobbersGorgeBanditFaction,
// WE20WarlockFaction, MS02ForswornFaction...). Matched on the faction editorId.
const DEFAULT_HOSTILE_EDITOR_ID_PATTERNS = Object.freeze([
  'Bandit', 'Forsworn', 'Necromancer', 'Warlock', 'SilverHand', 'Cultist'
]);
// BanditFriendFaction, BanditAllyFaction, SilverHandFactionPacified,
// *CrimeFaction, *DialogueFaction, Services*: NOT hostile.
const DEFAULT_HOSTILE_EDITOR_ID_EXCLUSIONS = Object.freeze([
  'Friend', 'Ally', 'Pacified', 'Crime', 'Dialogue', 'Services'
]);

const DEFAULT_CONFIG = Object.freeze({
  safeRadius: 5000,
  sweepIntervalMs: 2000,
  disableOnFirstSight: false,
  removeMixedLeveledLists: false,
  hostileFactionDescs: DEFAULT_HOSTILE_FACTIONS,
  extraHostileFactionDescs: [],
  hostileFactionEditorIdPatterns: DEFAULT_HOSTILE_EDITOR_ID_PATTERNS,
  hostileFactionEditorIdExclusions: DEFAULT_HOSTILE_EDITOR_ID_EXCLUSIONS,
  // Per-record overrides, `id:Plugin.esp` of the NPC_ base.
  alwaysKeepBaseDescs: [],
  alwaysRemoveBaseDescs: []
});

function _stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
}

function _regexList(words) {
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escaped.map(w => new RegExp(w, 'i'));
}

/**
 * Optional overrides in `skymp/config/npc-spawn-filter.json` (gitignored;
 * example next to it). A missing or broken file means the defaults.
 */
function loadConfig(raw) {
  if (raw === undefined) {
    raw = {};
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
      } catch (err) {
        console.error(`[npc-spawn-filter] ${CONFIG_PATH} is not valid JSON (${err.message}). Using defaults.`);
        raw = {};
      }
    }
  }
  const safeRadius = Number(raw.safeRadius);
  const sweepIntervalMs = Number(raw.sweepIntervalMs);
  return {
    // Infinity would protect everyone forever, NaN would protect no one.
    safeRadius: Number.isFinite(safeRadius) && safeRadius >= 0 ? safeRadius : DEFAULT_CONFIG.safeRadius,
    sweepIntervalMs: Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 500 ? sweepIntervalMs : DEFAULT_CONFIG.sweepIntervalMs,
    disableOnFirstSight: raw.disableOnFirstSight === true,
    removeMixedLeveledLists: raw.removeMixedLeveledLists === true,
    hostileFactionDescs: [
      ..._stringList(raw.hostileFactionDescs, DEFAULT_CONFIG.hostileFactionDescs),
      ..._stringList(raw.extraHostileFactionDescs, [])
    ],
    hostileFactionEditorIdPatterns: _stringList(raw.hostileFactionEditorIdPatterns, DEFAULT_CONFIG.hostileFactionEditorIdPatterns),
    hostileFactionEditorIdExclusions: _stringList(raw.hostileFactionEditorIdExclusions, DEFAULT_CONFIG.hostileFactionEditorIdExclusions),
    alwaysKeepBaseDescs: new Set(_stringList(raw.alwaysKeepBaseDescs, []).map(d => d.toLowerCase())),
    alwaysRemoveBaseDescs: new Set(_stringList(raw.alwaysRemoveBaseDescs, []).map(d => d.toLowerCase()))
  };
}

/** `'1bcc0:Skyrim.esm'` → global FormID, or null if that plugin is not loaded. */
function _descToId(desc) {
  try {
    const id = mp.getIdFromDesc(desc);
    return Number.isFinite(id) && id > 0 ? id >>> 0 : null;
  } catch (err) {
    return null;
  }
}

function _safeGet(formId, prop) {
  try {
    return mp.get(formId, prop);
  } catch (err) {
    return undefined;
  }
}

/**
 * Builds a filter bound to a config. Kept as a factory so tests get a fresh
 * one with its own state, and the module-level instance is just one of them.
 */
function createSpawnFilter(config = loadConfig()) {
  const hostileIds = [];
  const unresolvedFactions = [];
  for (const desc of config.hostileFactionDescs) {
    const id = _descToId(desc);
    if (id === null) unresolvedFactions.push(desc);
    else hostileIds.push(id);
  }

  const classifier = classifierLib.createClassifier({
    lookup: (formId) => mp.lookupEspmRecordById(formId),
    hostileFactionIds: hostileIds,
    hostileFactionEditorIdPatterns: _regexList(config.hostileFactionEditorIdPatterns),
    hostileFactionEditorIdExclusions: _regexList(config.hostileFactionEditorIdExclusions)
  });

  /** actorId → 'keep' | 'removed' | 'restored' — decided, never looked at again */
  const decided = new Map();
  /** actorId → classification, peaceful but a player is too close */
  const pending = new Map();
  const stats = { sweeps: 0, examined: 0, kept: 0, removed: 0, pendingNow: 0, unknown: 0, errors: 0 };
  let firstSweepDone = false;

  /** Why this actor gets the verdict it gets. Read-only. */
  function classifyActor(actorId) {
    const baseDesc = _safeGet(actorId, 'baseDesc') || null;
    const key = baseDesc ? String(baseDesc).toLowerCase() : null;
    if (key && config.alwaysKeepBaseDescs.has(key)) {
      return { verdict: VERDICT.HOSTILE, reason: 'alwaysKeepBaseDescs', baseDesc };
    }
    if (key && config.alwaysRemoveBaseDescs.has(key)) {
      return { verdict: VERDICT.PEACEFUL, reason: 'alwaysRemoveBaseDescs', baseDesc };
    }

    // The chain the server resolved for this very actor (leveled list already
    // rolled) is exact; the base record is the fallback.
    const chain = _safeGet(actorId, 'templateChain');
    let result = Array.isArray(chain) && chain.length > 0 ? classifier.classifyChain(chain) : null;
    if (!result || result.verdict === VERDICT.UNKNOWN) {
      const baseId = baseDesc ? _descToId(baseDesc) : null;
      if (baseId !== null) result = classifier.classifyBase(baseId);
    }
    return Object.assign({ baseDesc }, result || { verdict: VERDICT.UNKNOWN, reason: 'no base record' });
  }

  function _isWorldNpc(actorId, playerSet) {
    if (!Number.isFinite(actorId) || actorId <= 0) return false;
    if (actorId >= FIRST_RUNTIME_FORM_ID) return false;
    if (playerSet.has(actorId)) return false;
    const profileId = _safeGet(actorId, 'profileId');
    // -1 = no owner. Anything else belongs to a player account.
    return !(Number.isFinite(profileId) && profileId >= 0);
  }

  function _nearestPlayerDistance(actorId, players) {
    let best = Infinity;
    for (const p of players) {
      const d = rangeUtils.distanceBetween(actorId, p);
      if (d === null) continue;
      if (d < best) best = d;
    }
    return best;
  }

  function _disable(actorId) {
    // `isDisabled` → MpObjectReference::Disable(). Reversible. No delete.
    mp.set(actorId, 'isDisabled', true);
  }

  function _tryRemove(actorId, classification, players, firstSight) {
    const dist = _nearestPlayerDistance(actorId, players);
    if ((firstSight && config.disableOnFirstSight) || dist > config.safeRadius) {
      _disable(actorId);
      decided.set(actorId, 'removed');
      pending.delete(actorId);
      stats.removed++;
      return true;
    }
    pending.set(actorId, classification);
    return false;
  }

  /** One pass. Returns this pass's counts. */
  function sweepOnce() {
    const report = { examined: 0, kept: 0, removed: 0, pending: 0, unknown: 0 };
    if (typeof mp === 'undefined') return report;
    stats.sweeps++;

    const online = _safeGet(0, 'onlinePlayers');
    const players = Array.isArray(online) ? online.filter(Number.isFinite) : [];
    const playerSet = new Set(players);

    // 1. Peaceful NPCs that were too close last time.
    for (const [actorId, classification] of pending) {
      try {
        if (_safeGet(actorId, 'isDisabled') === true) {
          pending.delete(actorId);
          decided.set(actorId, 'removed');
          continue;
        }
        if (_tryRemove(actorId, classification, players, false)) report.removed++;
      } catch (err) {
        // The form may be gone (server unloaded it). Forget it; it gets a
        // fresh decision if it streams in again.
        pending.delete(actorId);
        stats.errors++;
      }
    }

    // 2. Anything new near a player.
    for (const playerId of players) {
      const neighbours = _safeGet(playerId, 'actorNeighbors');
      if (!Array.isArray(neighbours)) continue;
      for (const actorId of neighbours) {
        if (decided.has(actorId) || pending.has(actorId)) continue;
        if (!_isWorldNpc(actorId, playerSet)) continue;
        try {
          report.examined++;
          stats.examined++;
          if (_safeGet(actorId, 'isDisabled') === true) {
            decided.set(actorId, 'removed');
            continue;
          }
          const classification = classifyActor(actorId);
          if (classification.verdict === VERDICT.UNKNOWN) {
            report.unknown++;
            stats.unknown++;
          }
          const remove = classifierLib.shouldRemoveVerdict(classification.verdict, {
            removeMixed: config.removeMixedLeveledLists
          });
          if (!remove) {
            decided.set(actorId, 'keep');
            report.kept++;
            stats.kept++;
            continue;
          }
          if (_tryRemove(actorId, classification, players, firstSweepDone)) report.removed++;
        } catch (err) {
          stats.errors++;
          console.error(`[npc-spawn-filter] 0x${actorId.toString(16)}: ${err.message}`);
        }
      }
    }

    report.pending = pending.size;
    stats.pendingNow = pending.size;
    firstSweepDone = true;
    return report;
  }

  /** Staff undo for one actor. It is then never touched again this run. */
  function restore(actorId) {
    mp.set(actorId, 'isDisabled', false);
    decided.set(actorId, 'restored');
    pending.delete(actorId);
  }

  return {
    config,
    unresolvedFactions,
    hostileFactionCount: hostileIds.length,
    classifyActor,
    sweepOnce,
    restore,
    stats,
    _decided: decided,
    _pending: pending
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module lifecycle (wired in phase0-basic.js behind ENABLE_NPC_SPAWN_FILTER)
// ─────────────────────────────────────────────────────────────────────────────

let _filter = null;
let _timer = null;

function start() {
  if (typeof mp === 'undefined') return;
  if (typeof mp.lookupEspmRecordById !== 'function') {
    console.error('[npc-spawn-filter] mp.lookupEspmRecordById is missing: cannot read records. Filter stays off.');
    return;
  }
  _filter = createSpawnFilter(loadConfig());
  const c = _filter.config;
  console.log(
    `[npc-spawn-filter] On: ${_filter.hostileFactionCount} hostile faction(s), safeRadius=${c.safeRadius}, ` +
    `every ${c.sweepIntervalMs}ms, disableOnFirstSight=${c.disableOnFirstSight}, removeMixed=${c.removeMixedLeveledLists}.`
  );
  if (_filter.unresolvedFactions.length) {
    console.warn(`[npc-spawn-filter] Faction(s) not in the load order, ignored: ${_filter.unresolvedFactions.join(', ')}`);
  }

  _timer = setInterval(() => {
    try {
      const r = _filter.sweepOnce();
      if (r.removed > 0 || r.unknown > 0) {
        console.log(
          `[npc-spawn-filter] Sweep: ${r.examined} new, ${r.kept} kept, ${r.removed} disabled, ` +
          `${r.pending} waiting for players to leave, ${r.unknown} unreadable (kept).`
        );
      }
    } catch (err) {
      console.error('[npc-spawn-filter] Sweep failed:', err.message);
    }
  }, _filter.config.sweepIntervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _filter = null;
}

function commandDefs() {
  return [
    {
      name: ['/npcfilter'],
      description: '[Staff] NPC spawn filter: status, why <hex id>, restore <hex id>',
      usage: '/npcfilter [why <npc hex id> | restore <npc hex id>]',
      handler: (actorId, args) => {
        const commands = require('./commands');
        const admin = require('./admin-service');
        if (!admin.hasPermission(actorId, 'run_world_probe')) {
          commands.sendNotification(actorId, 'You do not have permission to do that.');
          return;
        }
        if (!_filter) {
          commands.sendNotification(actorId, 'The NPC spawn filter is not running.');
          return;
        }
        const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] || '').toLowerCase();
        if (sub === 'why' || sub === 'restore') {
          const target = Number.parseInt(String(parts[1] || '').replace(/^0x/i, ''), 16);
          if (!Number.isFinite(target)) {
            commands.sendNotification(actorId, `Usage: /npcfilter ${sub} <npc hex id>`);
            return;
          }
          if (sub === 'restore') {
            try {
              _filter.restore(target);
              console.log(`[npc-spawn-filter] Restored 0x${target.toString(16)} by staff actor 0x${actorId.toString(16)}.`);
              commands.sendNotification(actorId, `NPC 0x${target.toString(16)} enabled again. The filter will leave it alone until restart.`);
            } catch (err) {
              commands.sendNotification(actorId, `Could not restore 0x${target.toString(16)}: ${err.message}`);
            }
            return;
          }
          const c = _filter.classifyActor(target);
          const state = _filter._decided.get(target) || (_filter._pending.has(target) ? 'pending' : 'not seen yet');
          commands.sendNotification(actorId, `0x${target.toString(16)} ${c.baseDesc || '(no base)'}: ${c.verdict} (${c.reason}). State: ${state}.`);
          return;
        }
        const s = _filter.stats;
        commands.sendNotification(
          actorId,
          `NPC filter: ${s.examined} examined, ${s.kept} kept, ${s.removed} disabled, ${s.pendingNow} waiting, ` +
          `${s.unknown} unreadable, ${s.errors} errors over ${s.sweeps} sweeps.`
        );
      }
    }
  ];
}

module.exports = {
  DEFAULT_HOSTILE_FACTIONS,
  DEFAULT_CONFIG,
  loadConfig,
  createSpawnFilter,
  start,
  stop,
  commandDefs
};
