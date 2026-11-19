/**
 * core/espm.js — reading records from the loaded plugins
 *
 * ─── Attribution (LICENSE_AND_AFFILIATION_POLICY.md §4) ─────────────────────
 *
 *   Project : alekcey0211/red-house-public — public build of Red House (SkyMP)
 *   Author  : alekcey0211 and contributors
 *   License : GPL-3.0. Compatible with this project's AGPL-3.0-or-later through
 *             GPLv3 §13; the combined work is still distributed under the AGPL.
 *   Commit  : 65c66bb3e1b9f5765ed5fc036d69d75e3afbb53d (branch `master`,
 *             2021-11-01 — repository inactive, last push on 2021-11-16)
 *   Origin  : `functions-lib/src/` — that is where `mp.lookupEspmRecordById` shows up
 *             in use, to read base weapon and armor damage in the damage calculation
 *   Study   : docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md §4.1,
 *             "Other things we learned"
 *
 *   **What was adapted is technique, not code.** No line was copied: what
 *   came from there is *knowing the API exists* — that the server can read
 *   records from the loaded plugins, which this project did not know. The return
 *   format **did not come from them**: it was read from a real server (see below), and the
 *   use is different — they read stats to compute damage, we read `type` to
 *   check whether a hand-typed `base_id` is really an item.
 *
 *   Also recorded in CHANGELOG.md, section `[Unreleased]`.
 *
 * ─── Where it came from, and how the format was discovered ──────────────────
 *
 * `mp.lookupEspmRecordById` showed up in the Red House study
 * (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1) — the project knew it existed
 * and had never seen what it returns.
 *
 * The format below **was not inferred**: it was read from a real server on
 * 2026-08-06, with a temporary probe set as the gamemode. That matters
 * because this project has already paid dearly twice for assuming an API format —
 * the 22 Papyrus calls with the wrong `self` (QA 2.13) and the bare
 * `require('dotenv')`, which only surfaced when something actually ran.
 *
 *     mp.lookupEspmRecordById(0x0000000f)
 *     // => { record: { id: 15, editorId: 'Gold001', type: 'MISC',
 *     //                flags: 0, fields: [ { type, data }, ... ] },
 *     //      fileIndex: ..., toGlobalRecordId: ... }
 *
 *     mp.lookupEspmRecordById(0x00000014)   // Player, which is a reference
 *     // => {}                              ← no `record`
 *
 *     mp.lookupEspmRecordById(0x7fffffff)   // does not exist
 *     // => {}
 *
 * **`{}` is the answer for "does not exist as a plugin record".** It does not throw, it does not
 * return null: it returns an empty object. That is why the check here is on
 * `r && r.record`, and not on the truthiness of the return — `{}` is truthy.
 *
 * ─── Cache ──────────────────────────────────────────────────────────────────
 *
 * The return carries **every field of the record as bytes** — a Gold001 already comes with
 * hundreds of bytes of EDID, OBND, MODL, MODT. Calling this per inventory
 * operation would allocate garbage for nothing, and the data is immutable while the server runs:
 * the load order does not change at runtime.
 *
 * The cache keeps only what matters (`type` and `editorId`), not the raw record.
 */

/** baseId → { existe (exists), type, editorId } */
const _cache = new Map();

/**
 * Skyrim records that make sense inside an inventory.
 *
 * Deliberately an ALLOW list, not a block list: a mistyped FormID
 * lands on any record in the game — cell, quest, sound, perk — and the
 * right question is "is this an item?", not "is this one of the things I
 * remembered to forbid".
 */
const TIPOS_DE_INVENTARIO = new Set([
  'WEAP', // arma
  'ARMO', // armadura e roupa
  'MISC', // misc (gold, ore, bones)
  'ALCH', // potions and food
  'AMMO', // flecha e virote
  'BOOK', // books and spell tomes
  'INGR', // alchemy ingredient
  'KEYM', // chave
  'SLGM', // soul gem
  'SCRL', // pergaminho
  'LIGH'  // torch (it can be carried)
]);

/**
 * @typedef {object} RecordConsultado
 * @property {boolean} existe
 * @property {string|null} type      4-letter record tag (WEAP, ARMO, ...)
 * @property {string|null} editorId
 * @property {boolean} [indisponivel] the API did not answer — "I don't know", which is
 *   different from "it does not exist". See `pareceItem`.
 */

/**
 * Looks up a FormID's record in the loaded plugins.
 *
 * @param {number} baseId
 * @returns {RecordConsultado}
 */
function lookup(baseId) {
  if (!Number.isFinite(baseId)) return { existe: false, type: null, editorId: null };

  const cacheado = _cache.get(baseId);
  if (cacheado) return cacheado;

  let resultado = { existe: false, type: null, editorId: null };

  if (typeof mp !== 'undefined' && typeof mp.lookupEspmRecordById === 'function') {
    try {
      const r = mp.lookupEspmRecordById(baseId);
      // `{}` when it does not exist — hence `r.record` and not `r`.
      if (r && r.record) {
        resultado = {
          existe: true,
          type: r.record.type || null,
          editorId: r.record.editorId || null
        };
      }
    } catch (err) {
      // A read failure must not become "the item does not exist", otherwise an
      // unstable API would block legitimate operations. It stays unknown,
      // and the caller decides (see `pareceItem`).
      console.error(`[espm] Failed to look up 0x${baseId.toString(16)}:`, err.message);
      return { existe: false, type: null, editorId: null, indisponivel: true };
    }
  } else {
    // Without `mp` (tests) or without the function (old server): nothing can be
    // asserted. Marked as unavailable so validation does not turn into a block.
    return { existe: false, type: null, editorId: null, indisponivel: true };
  }

  _cache.set(baseId, resultado);
  return resultado;
}

/**
 * Is the FormID an item that makes sense in an inventory?
 *
 * **Returns `true` when it cannot tell.** That is deliberate: the function
 * exists to catch typos, not to be an authority. If the API is not
 * available — old server, test environment — blocking would
 * turn a diagnostics improvement into broken functionality.
 *
 * The only case where it says no is when it is certain: the API answered, and
 * answered that the FormID is not an item.
 *
 * @param {number} baseId
 * @returns {{ok: boolean, motivo?: string, type?: string, editorId?: string}}
 */
function pareceItem(baseId) {
  const r = lookup(baseId);

  if (r.indisponivel) return { ok: true };

  if (!r.existe) {
    return {
      ok: false,
      motivo: `0x${Number(baseId).toString(16)} does not exist in the loaded plugins`
    };
  }

  if (!TIPOS_DE_INVENTARIO.has(r.type)) {
    return {
      ok: false,
      motivo: `0x${Number(baseId).toString(16)} is ${r.type}${r.editorId ? ` (${r.editorId})` : ''}, which does not go into an inventory`,
      type: r.type,
      editorId: r.editorId
    };
  }

  return { ok: true, type: r.type, editorId: r.editorId };
}

/** The record's editor name, for readable logs and audits. */
function editorIdOf(baseId) {
  return lookup(baseId).editorId;
}

module.exports = {
  TIPOS_DE_INVENTARIO,
  lookup,
  pareceItem,
  editorIdOf,
  _limparCache: () => _cache.clear()
};
