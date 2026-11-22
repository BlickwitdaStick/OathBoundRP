/**
 * core/safe-zones.js — zones where certain actions do not apply
 *
 * ─── Attribution (LICENSE_AND_AFFILIATION_POLICY.md §4) ─────────────────────
 *
 *   Project : alekcey0211/red-house-public — public build of Red House (SkyMP)
 *   Author  : alekcey0211 and contributors
 *   License : GPL-3.0. Compatible with this project's AGPL-3.0-or-later through
 *             GPLv3 §13; the combined work is still distributed under the AGPL.
 *   Commit  : 65c66bb3e1b9f5765ed5fc036d69d75e3afbb53d (branch `master`,
 *             2021-11-01 — repository inactive, last push on 2021-11-16)
 *   Origin  : `functions-lib/src/` — the check of the `isInSafeLocation` property
 *             done by `hitSync` before applying damage
 *   Study   : docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md §4.1
 *
 *   **What was adapted is technique, not code.** No line was copied. What
 *   came from there are two ideas: (a) that a place can block an action, not only
 *   the character's state; and (b) **the two-sided rule** — check the target *and*
 *   the aggressor, otherwise you can shoot from inside the zone to outside it. That
 *   second one is the finding that made the read worthwhile, and it has its own test here.
 *
 *   The rest diverges: there it is a boolean property per actor, checked inside the
 *   damage calculation; here it is declarative config on disk (cell/radius), with
 *   `action-policy` categories, and the verdict is "this action does not apply" instead
 *   of "this damage is not applied". Consistent with the decision recorded in
 *   `core/hit-events.js`: the hit event is evidence, never authority.
 *
 *   Also recorded in CHANGELOG.md, section `[Unreleased]`.
 *
 * ─── Where it came from ─────────────────────────────────────────────────────
 *
 * From Red House (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1). Before applying
 * damage, they check an `isInSafeLocation` property **on both sides** — target and
 * aggressor — and, if either one is in a safe zone, the damage does not happen. The
 * event is still recorded; it just does not hurt.
 *
 * Checking both sides is the detail that matters: protecting only the target lets the
 * aggressor shoot from inside the safe zone to outside it, which is the obvious
 * abuse. This module keeps the same rule, and the test covers that case.
 *
 * ─── What this file does, and what it deliberately does not do ──────────────
 *
 * It answers **where** someone is and **what that place forbids**. It does not decide
 * which places exist: that comes from `skymp/config/safe-zones.json`, and the list
 * starts out empty.
 *
 * A safe zone is a world mechanic, and Constitution §15 asks that world
 * mechanics answer 15 questions before they exist. These remain open and
 * belong to whoever designs the server, not to whoever writes the module:
 *
 *   - Is a city under truce a safe zone, or is a truce an IC agreement the guard
 *     enforces? (the second creates stories; the first creates rules)
 *   - Does a safe zone protect from theft, or only from damage?
 *   - What happens to someone already in combat who walks into one? Is fleeing
 *     into a safe zone a legitimate tactic or an exploit?
 *   - Does the spawn area need to be permanent, or only until the character leaves the
 *     first scene?
 *
 * While `zones` is empty, this module answers "there is no zone" and
 * nothing changes — same pattern as `npc-cleaner.js`, for the same reason: missing
 * config must not turn into surprise behavior.
 *
 * ─── Cost ───────────────────────────────────────────────────────────────────
 *
 * `mp.get(actorId, 'locationalData')` is a **property** read, served from the
 * server's cache — it is not a Papyrus round trip, so it does not pay the 13–35 ms that
 * Red House measured. That is why it can be checked on every action without a special
 * budget. If that ever changes, the cache goes here and nowhere else.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'safe-zones.json');

/** action-policy categories a zone can forbid. */
const CATEGORIAS_VALIDAS = new Set([
  'gameplay', 'combat', 'trade', 'craft', 'gather', 'work', 'move', 'move_world', 'use_item', 'speak_rp', 'sell'
]);

let _zonas = null;

/**
 * `cellId` must be a `FormDesc`, not a hexadecimal number.
 *
 * **[DOC]** `FormDesc.cpp` (`SKYMP_UPSTREAM_REFERENCE.md` §8.5): `ToString()` is
 * `shortFormId` in hex **without the `0x` prefix**, `:`, file name —
 * `"162e2:Skyrim.esm"`. That is the string `locationalData.cellOrWorldDesc`
 * returns, and it is what `zoneOf` compares against for equality.
 *
 * ─── Why this needs to be loud ──────────────────────────────────────────────
 *
 * `FormDesc::FromString` **does not validate**: without `:` it does not fail, it just falls into the
 * no-file branch and resolves to the range of server-generated forms. On
 * our side the effect is even quieter — `"0x162e2" !== "162e2:Skyrim.esm"`
 * is just a string comparison that never matches. The zone loads, shows up in the
 * logs as active, and **never fires**.
 *
 * A safe zone that fails like this fails **open**: the protection does not exist and there is
 * no error anywhere. It is the same failure mode as the phantom `safeRadius` already
 * catalogued in `npc-cleaner`, and the opposite of what this file's header says it
 * wants — *"missing config must not turn into surprise behavior"*. Config that is
 * **present and wrong** is worse, because whoever wrote it thinks they created a rule.
 *
 * The example in `safe-zones.example.json` had `"0x162e2"` until 2026-08-09, which
 * means: whoever copied the example — the expected path — would land exactly here.
 *
 * @param {string} cellId
 * @returns {string|null} the reason for rejection, or `null` if it is well formed
 */
function motivoDeCellIdInvalido(cellId) {
  if (/^0x/i.test(cellId)) {
    return `starts with '0x' — FormDesc is hex WITHOUT a prefix (use '${cellId.replace(/^0x/i, '')}:Skyrim.esm')`;
  }
  const partes = cellId.split(':');
  if (partes.length !== 2) {
    return `does not have the shape '<hex>:<file.esm>' — without the ':' the server silently resolves to another FormID range`;
  }
  const [hex, arquivo] = partes;
  if (!/^[0-9a-f]+$/i.test(hex)) {
    return `'${hex}' before the ':' is not hexadecimal`;
  }
  if (!arquivo.trim()) {
    return `the file name after the ':' is missing`;
  }
  return null;
}

/**
 * Reads the configuration. A missing file is not an error — the empty list is the
 * correct state until someone designs the zones.
 *
 * @returns {{id: string, cellId: string, pos: number[]|null, radius: number|null, blocks: string[], label: string}[]}
 */
function loadZones() {
  if (!fs.existsSync(CONFIG_PATH)) return [];

  let bruto;
  try {
    bruto = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    // Broken config must not turn into "everything is a safe zone" nor "nothing is":
    // the first turns off combat on the server, the second removes protection
    // without warning. It stays inert and screams.
    console.error(`[safe-zones] ${CONFIG_PATH} is not valid JSON (${err.message}). No zone active.`);
    return [];
  }

  return parseZones(bruto);
}

/**
 * The validation itself, separate from reading the disk.
 *
 * It is separate for the same reason as `sweepOnce(policy = loadPolicy())` in
 * `npc-cleaner`: malformed config can be exercised without writing to
 * `skymp/config/safe-zones.json`, which is the server's real path. A test that
 * had to create that file would, if it failed midway, leave an active safe zone
 * config behind — which is exactly the kind of surprise this
 * module exists not to cause.
 *
 * @param {object} bruto  the already-deserialized contents of `safe-zones.json`
 * @returns {{id: string, cellId: string, pos: number[]|null, radius: number|null, blocks: string[], label: string}[]}
 */
function parseZones(bruto) {
  if (!bruto || bruto.enabled !== true) return [];
  if (!Array.isArray(bruto.zones)) return [];

  const zonas = [];
  for (const z of bruto.zones) {
    if (!z || typeof z.cellId !== 'string' || !z.cellId.trim()) {
      console.error('[safe-zones] Zone without cellId ignored:', JSON.stringify(z));
      continue;
    }

    const cellId = z.cellId.trim();
    const motivo = motivoDeCellIdInvalido(cellId);
    if (motivo) {
      // Same discipline as the unknown category right below: the zone leaves the
      // list instead of entering inert. Both protect equally
      // (not at all), but only one of them is visible.
      console.error(
        `[safe-zones] Zone '${z.id || cellId}' has an invalid cellId: '${cellId}' — ${motivo}. ` +
        `Expected the FormDesc format '<hex without 0x>:<file.esm>', such as '162e2:Skyrim.esm'. ` +
        `Zone IGNORED: a cellId that never matches never fires, and a safe zone that ` +
        `fails silently fails OPEN.`
      );
      continue;
    }

    const blocks = Array.isArray(z.blocks) ? z.blocks.filter(b => CATEGORIAS_VALIDAS.has(b)) : [];
    const invalidas = Array.isArray(z.blocks) ? z.blocks.filter(b => !CATEGORIAS_VALIDAS.has(b)) : [];
    if (invalidas.length > 0) {
      // Same logic as admin-service.hasPermission: a category that does not exist
      // is a rule whoever wrote it thinks they created, and did not.
      console.error(
        `[safe-zones] Zone '${z.id || z.cellId}' lists unknown categories: ${invalidas.join(', ')}. ` +
        `Valid: ${[...CATEGORIAS_VALIDAS].join(', ')}. Ignored.`
      );
    }
    if (blocks.length === 0) {
      console.error(`[safe-zones] Zone '${z.id || z.cellId}' forbids nothing — ignored.`);
      continue;
    }

    const raio = Number(z.radius);
    const temRaio = Array.isArray(z.pos) && z.pos.length === 3 && Number.isFinite(raio) && raio > 0;

    zonas.push({
      id: String(z.id || cellId),
      label: String(z.label || z.id || cellId),
      cellId,
      // Without a valid pos/radius, the zone is the WHOLE CELL. It is coarse on
      // purpose: "the whole tavern" is an easier decision to get right than a
      // radius in Skyrim units, and it does not require measuring anything in game.
      pos: temRaio ? z.pos.map(Number) : null,
      radius: temRaio ? raio : null,
      blocks
    });
  }
  return zonas;
}

/** Reloads from disk. Called on boot; exposed for tests and staff. */
function reload() {
  _zonas = loadZones();
  return _zonas;
}

function zones() {
  if (_zonas === null) _zonas = loadZones();
  return _zonas;
}

/**
 * The zone that contains the actor, or `null`.
 *
 * @param {number} actorId
 * @returns {object|null}
 */
function zoneOf(actorId) {
  const lista = zones();
  if (lista.length === 0) return null;
  if (typeof mp === 'undefined') return null;

  let loc;
  try {
    loc = mp.get(actorId, 'locationalData');
  } catch (err) {
    console.error('[safe-zones] Failed to read locationalData:', err.message);
    return null;
  }
  if (!loc) return null;

  const celula = loc.cellOrWorldDesc || loc.cellOrWorldSpaceId || loc.cellId || loc.worldOrCell || null;
  if (!celula) return null;

  for (const zona of lista) {
    if (zona.cellId !== celula) continue;
    if (!zona.pos) return zona; // celula inteira

    const p = loc.pos;
    if (!Array.isArray(p) || p.length < 3) continue;
    const dx = p[0] - zona.pos[0];
    const dy = p[1] - zona.pos[1];
    const dz = p[2] - zona.pos[2];
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= zona.radius) return zona;
  }
  return null;
}

/**
 * @typedef {object} VeredictoDeZona
 * @property {boolean} blocked
 * @property {object} [zone]  the zone that blocked it
 * @property {'actor'|'target'} [side]  whose protection it is (only in blocksBetween)
 */

/**
 * Is the category forbidden for this actor, because of where they are?
 *
 * @param {number} actorId
 * @param {string} categoria
 * @returns {VeredictoDeZona}
 */
function blocksCategory(actorId, categoria) {
  const zona = zoneOf(actorId);
  if (!zona) return { blocked: false };
  return zona.blocks.includes(categoria) ? { blocked: true, zone: zona } : { blocked: false };
}

/**
 * The two-sided rule: an action between two people is blocked if EITHER
 * of them is protected.
 *
 * It is what prevents the obvious abuse — standing inside the safe zone shooting
 * outward. Red House already did it this way, and the reason is the same here.
 *
 * @param {number} actorId    who acts
 * @param {number} targetActorId  who is acted upon
 * @param {string} categoria
 * @returns {VeredictoDeZona}
 */
function blocksBetween(actorId, targetActorId, categoria) {
  const doAgressor = blocksCategory(actorId, categoria);
  if (doAgressor.blocked) return { ...doAgressor, side: 'actor' };

  const doAlvo = blocksCategory(targetActorId, categoria);
  if (doAlvo.blocked) return { ...doAlvo, side: 'target' };

  return { blocked: false };
}

module.exports = {
  CATEGORIAS_VALIDAS,
  motivoDeCellIdInvalido,
  parseZones,
  loadZones,
  reload,
  zones,
  zoneOf,
  blocksCategory,
  blocksBetween,
  // Test only: injects zones without needing a file on disk.
  _setZones: (z) => { _zonas = z; }
};
