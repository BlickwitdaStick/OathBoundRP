/**
 * npc-cleaner.js — selective removal of vanilla NPCs
 *
 * ─── What this file did before, and why it changed ──────────────────────────
 *
 * The previous version swept `mp.getActorsByProfileId(0)` and called `disable` +
 * `delete` on **every** actor it found, skipping only those on an
 * allowlist — which was empty, with a comment "add base IDs of essential
 * merchants here". In other words: it deleted merchants, guards and quest NPCs
 * every 60 seconds, and `delete` on a persistent reference does not come back.
 *
 * That contradicted the decision recorded in `docs/technical/NPC_POLICY_DECISION.md`,
 * which evaluated three options and chose **C — Selective Vanilla Spawn** ("NPCs
 * should exist where they help atmosphere and onboarding; NPCs that generate loot,
 * repetitive combat or conflict with player roles should be removed,
 * frozen or replaced"). The code implemented option B, the rejected one, in
 * its most extreme form.
 *
 * Three inversions:
 *
 *   1. **The allowlist became a blocklist.** Only what is listed leaves the world. An
 *      empty list now means "remove nothing" instead of "remove everything" —
 *      the failure mode points to the safe side.
 *   2. **`safeRadius` now really exists.** It was declared in the config
 *      with the comment "only clean NPCs far from players so as not to break
 *      immersion abruptly" and was never read. The comment described a feature that
 *      had not been written.
 *   3. **`delete` is gone.** `disable` is reversible (`enable` brings it back);
 *      `delete` on a persistent reference is final. Until the curation
 *      in section 4 of NPC_POLICY exists, nothing here should be irreversible.
 *
 * ─── About the list's format ────────────────────────────────────────────────
 *
 * The list stores `baseDesc` ("1a6a0:Skyrim.esm"), never a numeric FormID. The
 * first byte of a FormID is the load-order index, so the same number
 * points to different records on clients with a different load order — and the
 * FormID contract (`MODS_AND_GAMEMODE_CONTRACT.md` section 3) exists
 * precisely because of that. The desc carries the plugin inside the value itself.
 *
 * (The old allowlist compared `mp.get(actorId, 'baseDesc')` — a string —
 * against a Set described as "base IDs". Even when filled in, it would never have
 * matched.)
 */

const fs = require('fs');
const path = require('path');
const { actorRef } = require('./core/papyrus');
const rangeUtils = require('./core/range-utils');

const POLICY_PATH = path.resolve(__dirname, '../config/npc-policy.json');

// profileId range swept looking for connected players, for the safeRadius.
// Same cap used in phase0-basic.js and death-service.js.
const MAX_PLAYER_PROFILE_ID = 50;

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  blockedBaseDescs: [],
  safeRadius: 5000,
  sweepIntervalMs: 60000,
  mode: 'disable'
});

let _sweepTimer = null;

/**
 * Reads `skymp/config/npc-policy.json`. A missing file is not an error — the
 * default is inert, which is the correct state until curation happens.
 *
 * @returns {{enabled: boolean, blockedBaseDescs: Set<string>, safeRadius: number, sweepIntervalMs: number, mode: string}}
 */
function loadPolicy() {
  let raw = {};
  if (fs.existsSync(POLICY_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    } catch (err) {
      // Broken config must not turn into "remove everything" nor "remove at random":
      // it falls back to the inert default and screams.
      console.error(`[npc-cleaner] ${POLICY_PATH} is not valid JSON (${err.message}). The service stays inert.`);
      raw = {};
    }
  }

  const bloqueados = Array.isArray(raw.blockedBaseDescs) ? raw.blockedBaseDescs : [];
  const safeRadius = Number(raw.safeRadius);
  const sweepIntervalMs = Number(raw.sweepIntervalMs);

  return {
    enabled: raw.enabled === true,
    blockedBaseDescs: new Set(bloqueados.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim())),
    // `Number.isFinite` rejects Infinity and NaN on purpose: an infinite radius
    // would protect everyone (an inert service disguised as active) and a NaN
    // would make every comparison false (it would protect nobody). Both are worse
    // than the default.
    safeRadius: Number.isFinite(safeRadius) && safeRadius >= 0 ? safeRadius : DEFAULT_POLICY.safeRadius,
    sweepIntervalMs: Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 1000
      ? sweepIntervalMs
      : DEFAULT_POLICY.sweepIntervalMs,
    // Only 'disable' is accepted. See the header: 'delete' is not an option.
    mode: 'disable'
  };
}

/**
 * actorIds of connected players, to measure the safeRadius against them.
 * @returns {number[]}
 */
function _onlinePlayerActorIds() {
  const ids = [];
  for (let profileId = 1; profileId <= MAX_PLAYER_PROFILE_ID; profileId++) {
    const atores = mp.getActorsByProfileId(profileId);
    if (atores && atores.length > 0) ids.push(...atores);
  }
  return ids;
}

/**
 * Decides whether an NPC can be removed now.
 *
 * Separate from the loop so it is testable without `mp`: this is where the rule lives, and
 * a permanent-removal rule deserves a direct test.
 *
 * @param {string|null} baseDesc          `mp.get(npcActorId, 'baseDesc')`
 * @param {number} distanciaAoJogadorMaisProximo  `Infinity` if nobody is nearby
 * @param {{blockedBaseDescs: Set<string>, safeRadius: number}} policy
 * @returns {boolean}
 */
function _shouldRemove(baseDesc, distanciaAoJogadorMaisProximo, policy) {
  if (!baseDesc) return false;
  if (!policy.blockedBaseDescs.has(baseDesc)) return false;
  return distanciaAoJogadorMaisProximo > policy.safeRadius;
}

/**
 * Distance from the NPC to the nearest connected player.
 * `Infinity` when there is no player at all, or when all of them are in another
 * cell (`range-utils.distanceBetween` already returns Infinity in that case).
 */
function _distanciaAoJogadorMaisProximo(npcActorId, jogadores) {
  let menor = Infinity;
  for (const jogadorId of jogadores) {
    const d = rangeUtils.distanceBetween(npcActorId, jogadorId);
    if (d === null) continue; // position unavailable: does not count as "near"
    if (d < menor) menor = d;
  }
  return menor;
}

/**
 * One pass. Exported for tests and to allow manual execution by staff.
 * @param {object} [policy] - default: read from disk
 * @returns {{avaliados: number, removidos: number, protegidosPorDistancia: number}}
 */
function sweepOnce(policy = loadPolicy()) {
  const relatorio = { avaliados: 0, removidos: 0, protegidosPorDistancia: 0 };
  if (typeof mp === 'undefined') return relatorio;

  // With nothing blocked there is nothing to do — and it is not worth sweeping the world.
  if (policy.blockedBaseDescs.size === 0) return relatorio;

  const npcs = mp.getActorsByProfileId(0) || [];
  const jogadores = _onlinePlayerActorIds();

  for (const npcActorId of npcs) {
    if (!npcActorId) continue;
    relatorio.avaliados++;

    const baseDesc = mp.get(npcActorId, 'baseDesc');
    if (!baseDesc || !policy.blockedBaseDescs.has(baseDesc)) continue;

    const distancia = _distanciaAoJogadorMaisProximo(npcActorId, jogadores);
    if (!_shouldRemove(baseDesc, distancia, policy)) {
      relatorio.protegidosPorDistancia++;
      continue;
    }

    // `disable(false)` — the argument is `abFadeOut`. No delete: see the header.
    mp.callPapyrusFunction('method', 'ObjectReference', 'disable', actorRef(npcActorId), [false]);
    relatorio.removidos++;
  }

  return relatorio;
}

function startWorldCleaner() {
  if (typeof mp === 'undefined') return;

  const policy = loadPolicy();

  if (!policy.enabled) {
    console.log('[npc-cleaner] Off (npc-policy.json missing or enabled=false). No NPC will be touched.');
    return;
  }
  if (policy.blockedBaseDescs.size === 0) {
    console.warn(
      '[npc-cleaner] enabled=true, but blockedBaseDescs is empty — no NPC will be removed. ' +
      'This is deliberate: it is a BLOCK list. Fill it in after the curation in section 4 of NPC_POLICY_DECISION.md.'
    );
    return;
  }

  console.log(
    `[npc-cleaner] Active: ${policy.blockedBaseDescs.size} record(s) blocked, ` +
    `safeRadius=${policy.safeRadius}, interval=${policy.sweepIntervalMs}ms, mode=${policy.mode}.`
  );

  _sweepTimer = setInterval(() => {
    try {
      const r = sweepOnce(policy);
      if (r.removidos > 0 || r.protegidosPorDistancia > 0) {
        console.log(
          `[npc-cleaner] Sweep: ${r.removidos} disabled, ` +
          `${r.protegidosPorDistancia} preserved because a player was near, ${r.avaliados} evaluated.`
        );
      }
    } catch (err) {
      console.error('[npc-cleaner] Sweep error:', err.message);
    }
  }, policy.sweepIntervalMs);

  if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
}

function stopWorldCleaner() {
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = null;
}

module.exports = {
  startWorldCleaner,
  stopWorldCleaner,
  loadPolicy,
  sweepOnce,
  // Exposed for tests: the permanent-removal rule deserves a direct test.
  _shouldRemove
};
