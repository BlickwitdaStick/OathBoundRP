/**
 * core/progression-forms.js — which perks and spells the server re-applies
 *
 * SkyMP saves inventory, learned spells it added itself, equipment and a few
 * more things (skymp5-server MpChangeForms.h). It does NOT save perks, and
 * anything a mod script adds on the player's own client — a Mundus standing
 * stone, a Pilgrim shrine blessing or worship perk, an Apprentice class — never
 * reaches the server, so it is gone at the next login.
 *
 * This module answers two questions at boot, from the plugins the server
 * itself loads (server-settings.json loadOrder):
 *
 *   1. Tree perks: vanilla PERK editor ids (core/skill-trees.js) → form ids.
 *   2. Tracked mods: every PERK and SPEL record in the tracked plugins
 *      (Mundus.esp, Pilgrim.esp, …) → form id + a load-order-proof
 *      "0xLOCALID:Origin.esp" description, which is what the database keeps.
 *
 * skills-service.js sends both lists to the player's client; the client adds
 * what is missing at login and reports back which tracked forms it has, so a
 * stone switched or a blessing gained in play is mirrored in the database.
 */

'use strict';

const index = require('./plugin-record-index');

const PROGRESSION_TYPES = new Set(['PERK', 'SPEL']);

/** Plugins that hold tree and tier perks, looked up by editor id. */
const PERK_PLUGINS = new Set(['skyrim.esm', 'oathbound_armor.esp']);

/** Default plugins whose perks/spells are mirrored. Patches included. */
const DEFAULT_TRACKED_PLUGINS = Object.freeze(['Mundus.esp', 'MundusUSSEP.esp', 'Pilgrim.esp', 'PilgrimVanillaPatch.esp',
  'Apprentice.esp', 'ApprenticeAetherius.esp']);

function parseTrackedPlugins(value) {
  if (typeof value !== 'string' || !value.trim()) return [...DEFAULT_TRACKED_PLUGINS];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function formDescOf(localId, origin) {
  return `0x${(localId >>> 0).toString(16)}:${origin}`;
}

/**
 * @param {{name: string, path: string}[]} files load order
 * @param {{trackedPlugins: string[], perkEditorIds: string[], parseFile?: Function, isLight?: Function, log?: Function}} opts
 * @returns {Promise<{
 *   perkByEditorId: Map<string, number>,
 *   tracked: Map<number, {kind: 'perk'|'spell', formDesc: string, editorId: string|null, plugin: string}>,
 *   globalByDesc: Map<string, number>,
 *   missingPerks: string[], missingPlugins: string[], errors: string[]
 * }>}
 */
async function buildCatalog(files, { trackedPlugins = DEFAULT_TRACKED_PLUGINS, perkEditorIds = [], parseFile = index.parsePluginFile, isLight = index.readIsLight, log = () => {} } = {}) {
  const flagged = [];
  for (const f of files) {
    let light = false;
    try { light = await isLight(f.path, f.name); } catch { light = /\.esl$/i.test(f.name); }
    flagged.push({ name: f.name, light });
  }
  const loadIndex = index.buildLoadIndex(flagged);
  const trackedLower = new Set(trackedPlugins.map(p => p.toLowerCase()));
  const wantedPerks = new Set(perkEditorIds);

  const perkByEditorId = new Map();
  const tracked = new Map();
  const globalByDesc = new Map();
  const errors = [];

  for (const file of files) {
    const lower = file.name.toLowerCase();
    const isTracked = trackedLower.has(lower);
    const isMaster = PERK_PLUGINS.has(lower);
    if (!isTracked && !isMaster) continue;
    let entries;
    try {
      entries = await parseFile(file.path, file.name, loadIndex, PROGRESSION_TYPES);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
      log(`[progression-forms] Could not read ${file.name}: ${err.message}`);
      continue;
    }
    for (const e of entries) {
      if (isMaster && e.type === 'PERK' && e.editorId && wantedPerks.has(e.editorId)) {
        perkByEditorId.set(e.editorId, e.id);
      }
      if (isTracked) {
        const formDesc = formDescOf(e.localId, e.origin || file.name);
        tracked.set(e.id, { kind: e.type === 'PERK' ? 'perk' : 'spell', formDesc, editorId: e.editorId || null, plugin: file.name });
        globalByDesc.set(formDesc.toLowerCase(), e.id);
      }
    }
  }

  const present = new Set(files.map(f => f.name.toLowerCase()));
  return {
    perkByEditorId,
    tracked,
    globalByDesc,
    missingPerks: [...wantedPerks].filter(id => !perkByEditorId.has(id)),
    missingPlugins: trackedPlugins.filter(p => !present.has(p.toLowerCase())),
    errors
  };
}

/** Same catalog, reading the plugin list SkyMP itself parsed. */
async function buildCatalogFromServer(mpApi, opts = {}) {
  const plugins = index.pluginsFromServerSettings(mpApi);
  if (!plugins || plugins.files.length === 0) {
    return { perkByEditorId: new Map(), tracked: new Map(), globalByDesc: new Map(), missingPerks: opts.perkEditorIds || [], missingPlugins: [], errors: ['server settings list no plugins'] };
  }
  return buildCatalog(plugins.files, opts);
}

/**
 * Turns a client report into the set to store. Only forms the catalog tracks
 * are accepted (a client cannot make the server remember an arbitrary perk);
 * forms the client could not resolve (`unresolved`, e.g. it lacks a plugin)
 * are kept as they were instead of being deleted.
 *
 * @param {Map<number, {kind, formDesc}>} tracked
 * @param {Set<string>} storedDescs  what the database has now ("kind|desc")
 * @param {{perks?: number[], spells?: number[], unresolved?: number[]}} report
 * @returns {{keep: Set<string>, add: Array<{kind, formDesc}>, remove: Array<{kind, formDesc}>}}
 */
function diffReport(tracked, storedDescs, report) {
  const have = new Set();
  for (const id of [...(report.perks || []), ...(report.spells || [])]) {
    const t = tracked.get(Number(id) >>> 0);
    if (t) have.add(`${t.kind}|${t.formDesc}`);
  }
  const unresolved = new Set();
  for (const id of report.unresolved || []) {
    const t = tracked.get(Number(id) >>> 0);
    if (t) unresolved.add(`${t.kind}|${t.formDesc}`);
  }
  const split = (key) => { const i = key.indexOf('|'); return { kind: key.slice(0, i), formDesc: key.slice(i + 1) }; };
  const add = [...have].filter(k => !storedDescs.has(k)).map(split);
  const remove = [...storedDescs].filter(k => !have.has(k) && !unresolved.has(k)).map(split);
  return { keep: have, add, remove };
}

module.exports = {
  DEFAULT_TRACKED_PLUGINS,
  PROGRESSION_TYPES,
  parseTrackedPlugins,
  formDescOf,
  buildCatalog,
  buildCatalogFromServer,
  diffReport
};
