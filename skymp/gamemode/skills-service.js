/**
 * skills-service.js — Skills, attributes, soul level and persisted progression
 *
 * Rules: core/skills.js (levels, tiers, EXP, attributes, slots) and
 * core/skill-trees.js (tree nodes). This file stores them (migration v36),
 * exposes commands and the F3 menu, awards EXP, and keeps the player's own
 * game in step with the server.
 *
 * ─── Server owns progression, the client is told what to be ────────────────
 * SkyMP saves inventory, server-side spells, equipment and a few stats, but
 * not perks, not skill levels and nothing a mod script adds on the client.
 * So the server is the only record. At every login (and after every change)
 * the `oathboundProgression` property carries, for the owner only:
 *   - `av`     Skyrim actor values: skill levels (with attribute modifiers)
 *              and the stats attributes drive (health, carry weight, …);
 *   - `perks`  tree perks the character owns + mirrored mod perks;
 *   - `spells` mirrored mod spells (Mundus stones, Pilgrim blessings, …);
 *   - `tracked` every perk/spell of the tracked mods, so the client can
 *              report which ones it has.
 * The client snippet adds what is missing. The event source reports tracked
 * mod forms back every few seconds (only when they change) and reports
 * combat hits, being struck and spell casts for EXP.
 *
 * ⚠️ Actor values set this way live on the player's client (SkyMP's
 * `SetActorValue` is client-side too). The server re-applies them at every
 * login, which is what makes them stick; server-side damage math does not
 * see them.
 *
 * ─── EXP only for skills you own ────────────────────────────────────────────
 * `awardExp` does nothing for a skill the character has not been given.
 * Profession EXP arrives through core/skill-activity.js (mining, crafting,
 * jobs); combat/armor/magic EXP from the client reports below, throttled per
 * skill so spamming attacks does not out-level real play.
 */

'use strict';

const skills = require('./core/skills');
const trees = require('./core/skill-trees');
const progressionForms = require('./core/progression-forms');
const skillActivity = require('./core/skill-activity');

const fs = require('fs');
const path = require('path');

const MODULE_ID = 'skills';
const FLAG = 'ENABLE_SKILLS_SERVICE';
const PROPERTY = 'oathboundProgression';
const PANEL_PROPERTY = 'skillsPanelData';
const REPORT_EVENT = '_onProgressionReport';
const PERMISSION = 'manage_skills';

/** EXP per reported action, and the minimum gap between two awards per skill. */
const EXP_RULES = Object.freeze({
  hit: 4,
  powerHit: 6,
  struck: 3,
  cast: 5,
  minGapMs: 2000
});

/** Soul EXP per soul event (soul-service.js). */
const SOUL_EXP = Object.freeze({
  'soul.sign.revealed': 10,
  'soul.resolved': 15,
  'soul.mark.created': 40,
  'soul.path.advanced': 100
});

/** Legacy profession-service codes → skill codes. */
const PROFESSION_TO_SKILL = Object.freeze({
  miner: 'prospector',
  lumberjack: 'carpenter',
  hunter: 'hunter',
  farmer: 'farmer',
  smelter: 'metal_worker',
  blacksmith: 'metal_worker',
  tanner: 'outfitter',
  enchanter: 'enchanter',
  cook: 'innkeeper',
  innkeeper: 'innkeeper'
});

/** Skyrim WEAP animation types (Weapon.GetWeaponType). */
function skillForWeaponType(type) {
  const t = Number(type);
  if (t === 0) return 'unarmed';
  if (t >= 1 && t <= 4) return 'one_handed';
  if (t === 5 || t === 6) return 'two_handed';
  if (t === 7 || t === 9) return 'archery';
  return null; // staff (8) or unknown
}

/** Armor.GetWeightClass on the body slot: 0 light, 1 heavy, 2 clothing/robes. */
function skillForWeightClass(weightClass) {
  const w = Number(weightClass);
  if (w === 0) return 'light_armor';
  if (w === 1) return 'heavy_armor';
  if (w === 2) return 'mage_armor';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client code
// ─────────────────────────────────────────────────────────────────────────────

/** Shared between the property snippet and the event source (same client). */
const CLIENT_STORE = "((ctx.sp && ctx.sp.storage) ? ctx.sp.storage : (typeof globalThis !== 'undefined' ? globalThis : {}))";

/**
 * Applies the server's progression when a new value arrives (new `sentAt`).
 * Idempotent: perks/spells the player already has are skipped.
 */
/**
 * Runs inside the CEF page. The in-game UI is installed by the player's
 * launcher (Data/Platform/UI), so a launcher built before the skills menu has
 * no `skills-panel.js`: the F3 key reached `handlePlayerShortcutKey`, which
 * ignored it. This adds the menu's CSS, its container and its script to the
 * page, and teaches the shortcut handler `skills:open` — only when the page
 * does not have the menu already (a newer launcher makes this a no-op).
 */
const CEF_INJECTOR = `(function (ui) {
  // A launcher built before the skills menu also has a keybinds.js without
  // "Open skills menu", so the Controls tab had no row to rebind it (the key
  // itself works: the server's bindings include it). Add the row.
  var kb = window.OathboundKeybinds;
  try {
    if (kb && kb.ACTIONS && !kb.ACTIONS.some(function (a) { return a && a.id === 'skills.open'; })) {
      kb.ACTIONS.push({ id: 'skills.open', label: 'Open skills menu', hint: 'Profession, skills, trees and attributes' });
      if (kb.DEFAULT_BINDINGS && !Object.prototype.hasOwnProperty.call(kb.DEFAULT_BINDINGS, 'skills.open')) kb.DEFAULT_BINDINGS['skills.open'] = 61;
    }
  } catch (e) {}
  // A launcher that already has the menu (0.2.0 to 0.2.4) ships a
  // skills-panel.js that opens the menu by itself when data arrives, without
  // focus: data now only reaches a menu the player has open.
  if (window.SkillsPanel && !window.__obSkillsDataGuard && typeof window.handleSkillsPanelData === 'function') {
    window.__obSkillsDataGuard = true;
    var pageHandler = window.handleSkillsPanelData;
    window.handleSkillsPanelData = function (data) {
      if (window.SkillsPanel && typeof window.SkillsPanel.isOpen === 'function' && !window.SkillsPanel.isOpen()) return;
      return pageHandler(data);
    };
  }
  // The menu in launcher 0.2.5 closes on its own key (F3) and on Esc, and the
  // press that opened it (F3, or the Esc taps closing Skyrim's Tab menu) can
  // reach the page right after focus moves, closing it at once. Swallow those
  // for a moment after opening (its handler skips prevented events).
  if (window.SkillsPanel && !window.__obSkillsKeyGuard && typeof window.openSkillsPanel === 'function') {
    window.__obSkillsKeyGuard = true;
    var openedAt = 0;
    var pageOpen = window.openSkillsPanel;
    window.openSkillsPanel = function () { openedAt = Date.now(); return pageOpen.apply(this, arguments); };
    if (typeof window.SkillsPanel.open === 'function') {
      var panelOpen = window.SkillsPanel.open;
      window.SkillsPanel.open = function () { openedAt = Date.now(); return panelOpen.apply(this, arguments); };
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', function (event) {
        if (!window.SkillsPanel || typeof window.SkillsPanel.isOpen !== 'function' || !window.SkillsPanel.isOpen()) return;
        if (event.repeat || Date.now() - openedAt < 400) event.preventDefault();
      }, true);
    }
  }
  if (window.SkillsPanel || !ui || !ui.js) return;
  var style = document.createElement('style');
  style.textContent = ui.css || '';
  document.head.appendChild(style);
  if (!document.getElementById('skills-panel')) {
    var box = document.createElement('div');
    box.id = 'skills-panel';
    box.setAttribute('aria-hidden', 'true');
    document.body.appendChild(box);
  }
  var script = document.createElement('script');
  script.textContent = ui.js;
  document.body.appendChild(script);
  var previous = window.handlePlayerShortcutKey;
  window.handlePlayerShortcutKey = function (action) {
    if (action === 'skills:open') {
      if (typeof window.openSkillsPanel === 'function') window.openSkillsPanel();
      return;
    }
    if (typeof previous === 'function') return previous(action);
  };
})`;

const UPDATE_OWNER_SNIPPET = `
  ctx.state.obProg = ctx.state.obProg || { sentAt: null, ui: null, uiAt: null };
  if (ctx.value && ctx.value.ui) ctx.state.obProg.ui = ctx.value.ui;
  if (ctx.value && ctx.value.sentAt !== ctx.state.obProg.uiAt && ctx.state.obProg.ui && ctx.sp && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
    ctx.state.obProg.uiAt = ctx.value.sentAt;
    try {
      ctx.sp.browser.executeJavaScript(${JSON.stringify(CEF_INJECTOR)} + '(' + JSON.stringify(ctx.state.obProg.ui) + ')');
    } catch (e) {}
  }
  if (ctx.value && ctx.value.sentAt !== ctx.state.obProg.sentAt && ctx.sp && ctx.sp.Game) {
    var obPlayer = ctx.sp.Game.getPlayer();
    if (obPlayer) {
      ctx.state.obProg.sentAt = ctx.value.sentAt;
      var obV = ctx.value;
      var obAv = obV.av || {};
      for (var obK in obAv) {
        try { obPlayer.setActorValue(obK, obAv[obK]); } catch (e) {}
      }
      var obPerks = obV.perks || [];
      for (var obI = 0; obI < obPerks.length; obI++) {
        try {
          var obPerk = ctx.sp.Perk.from(ctx.sp.Game.getFormEx(obPerks[obI]));
          if (obPerk && !obPlayer.hasPerk(obPerk)) obPlayer.addPerk(obPerk);
        } catch (e) {}
      }
      var obRemove = obV.removePerks || [];
      for (var obR = 0; obR < obRemove.length; obR++) {
        try {
          var obOld = ctx.sp.Perk.from(ctx.sp.Game.getFormEx(obRemove[obR]));
          if (obOld && obPlayer.hasPerk(obOld)) obPlayer.removePerk(obOld);
        } catch (e) {}
      }
      var obSpells = obV.spells || [];
      for (var obJ = 0; obJ < obSpells.length; obJ++) {
        try {
          var obSpell = ctx.sp.Spell.from(ctx.sp.Game.getFormEx(obSpells[obJ]));
          if (obSpell && !obPlayer.hasSpell(obSpell)) obPlayer.addSpell(obSpell, false);
        } catch (e) {}
      }
      var obStore = ${CLIENT_STORE};
      obStore.oathboundProgression = { ready: true, sentAt: obV.sentAt, tracked: obV.tracked || { perks: [], spells: [] }, lastReport: null };
    }
  }
`;

/**
 * Event source: mod forms the player has (every 4 s, only on change), and
 * combat/magic activity for EXP. Reports only; the server decides.
 */
const REPORT_SNIPPET = `
  var obStoreOf = function () { return ${CLIENT_STORE}; };
  var obLastScan = 0;
  ctx.sp.on('update', function () {
    var now = Date.now();
    if (now - obLastScan < 4000) return;
    obLastScan = now;
    try {
      var st = obStoreOf().oathboundProgression;
      if (!st || !st.ready) return;
      var player = ctx.sp.Game.getPlayer();
      if (!player) return;
      var perks = [], spells = [], unresolved = [];
      var tp = (st.tracked && st.tracked.perks) || [];
      for (var i = 0; i < tp.length; i++) {
        var pf = ctx.sp.Game.getFormEx(tp[i]);
        var p = pf ? ctx.sp.Perk.from(pf) : null;
        if (!p) { unresolved.push(tp[i]); continue; }
        if (player.hasPerk(p)) perks.push(tp[i]);
      }
      var ts = (st.tracked && st.tracked.spells) || [];
      for (var j = 0; j < ts.length; j++) {
        var sf = ctx.sp.Game.getFormEx(ts[j]);
        var s = sf ? ctx.sp.Spell.from(sf) : null;
        if (!s) { unresolved.push(ts[j]); continue; }
        if (player.hasSpell(s)) spells.push(ts[j]);
      }
      var key = perks.join(',') + '|' + spells.join(',');
      if (key === st.lastReport) return;
      st.lastReport = key;
      ctx.sendEvent({ kind: 'mods', sentAt: st.sentAt, perks: perks, spells: spells, unresolved: unresolved });
    } catch (e) {}
  });

  // Replaces Skyrim's own Skills screen (Tab → Skills, "StatsMenu") with the
  // OATHBOUND skills menu. The client hides the page while the Tab menu or
  // StatsMenu is open, so both are closed first (Esc, only while one of them
  // is actually open — Esc in the open world would bring up the pause menu),
  // then the F3 menu opens. Gives up after 3 s so it can never loop.
  var obRedirect = null;
  ctx.sp.on('menuOpen', function (e) {
    if (e && e.name === 'StatsMenu') obRedirect = { since: Date.now(), lastTap: 0 };
  });
  ctx.sp.on('update', function () {
    if (!obRedirect) return;
    var now = Date.now();
    if (now - obRedirect.since > 3000) { obRedirect = null; return; }
    try {
      var stats = ctx.sp.Ui.isMenuOpen('StatsMenu');
      var tween = ctx.sp.Ui.isMenuOpen('TweenMenu');
      if (stats || tween) {
        if (now - obRedirect.lastTap > 150) {
          obRedirect.lastTap = now;
          ctx.sp.Input.tapKey(1);
        }
        return;
      }
      obRedirect = null;
      var br = ctx.sp.browser;
      if (br && br.executeJavaScript) {
        if (br.setVisible) br.setVisible(true);
        if (br.setFocused) br.setFocused(true);
        br.executeJavaScript('window.handlePlayerShortcutKey && window.handlePlayerShortcutKey("skills:open")');
      }
    } catch (err) { obRedirect = null; }
  });

  var obOneHand = function (w) {
    if (!w) return false;
    var t = w.getWeaponType();
    return t >= 1 && t <= 4;
  };
  ctx.sp.on('hit', function (e) {
    try {
      var player = ctx.sp.Game.getPlayer();
      // Skyrim Platform names it \`aggressor\` (older builds: \`agressor\`).
      var attacker = e.aggressor || e.agressor;
      if (!player || !attacker || !e.target) return;
      var pid = player.getFormID();
      var from = attacker.getFormID();
      var to = e.target.getFormID();
      if (from === pid && to !== pid) {
        if (!ctx.sp.Actor.from(e.target)) return;
        var left = player.getEquippedWeapon(true);
        var right = player.getEquippedWeapon(false);
        var w = e.source ? ctx.sp.Weapon.from(e.source) : null;
        var type;
        if (w) type = w.getWeaponType();
        else if (!e.source && !left && !right) type = 0;
        else return;
        ctx.sendEvent({ kind: 'hit', weaponType: type, dual: obOneHand(left) && obOneHand(right), power: !!e.isPowerAttack });
      } else if (to === pid && from !== pid) {
        var body = player.getWornForm(0x4);
        var armor = body ? ctx.sp.Armor.from(body) : null;
        ctx.sendEvent({ kind: 'struck', weightClass: armor ? armor.getWeightClass() : -1 });
      }
    } catch (err) {}
  });
  ctx.sp.on('spellCast', function (e) {
    try {
      var player = ctx.sp.Game.getPlayer();
      if (!player || !e.caster || e.caster.getFormID() !== player.getFormID()) return;
      var spell = e.spell ? ctx.sp.Spell.from(e.spell) : null;
      if (!spell) return;
      var effect = spell.getNthEffectMagicEffect(0);
      if (!effect) return;
      // getAssociatedSkill is latent: it returns a Promise of the school name.
      var sendSchool = function (school) {
        if (school && typeof school === 'string') ctx.sendEvent({ kind: 'cast', school: school });
      };
      var pending = effect.getAssociatedSkill();
      if (pending && typeof pending.then === 'function') pending.then(sendSchool, function () {});
      else sendSchool(pending);
    } catch (err) {}
  });
`;

/** Forwards new panel data to the CEF menu (dedupe by sentAt). */
// The property keeps its last value with the character, so at login the
// client sees the last session's menu as "new". It is only handed to a menu
// the player has open (any launcher), so it can never open the menu without
// focus. Every new value is delivered: dropping the first one seen (an
// earlier attempt) also dropped the answer to the first F3 of a session, so
// the menu never filled in.
const PANEL_UPDATE_OWNER_SNIPPET = `
  if (ctx.value && ctx.value.sentAt !== ctx.state.skillsPanelSentAt && ctx.sp && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
    ctx.state.skillsPanelSentAt = ctx.value.sentAt;
    ctx.sp.browser.executeJavaScript('window.SkillsPanel && typeof window.SkillsPanel.isOpen === "function" && window.SkillsPanel.isOpen() && window.handleSkillsPanelData && window.handleSkillsPanelData(' + JSON.stringify(ctx.value) + ')');
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (injectable for tests)
// ─────────────────────────────────────────────────────────────────────────────

let _deps = null;

function _defaultDeps() {
  return {
    db: require('./database'),
    commands: require('./commands'),
    admin: require('./admin-service'),
    mp: () => (typeof mp !== 'undefined' ? mp : null),
    logger: console,
    now: () => Date.now(),
    trackedPlugins: progressionForms.parseTrackedPlugins(process.env.SKILLS_TRACKED_PLUGINS)
  };
}

function configure(overrides = {}) {
  _deps = { ...(_deps || _defaultDeps()), ...overrides };
  return _deps;
}

function deps() {
  return _deps || configure();
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog of perks/spells (built once at boot from the server's plugins)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_CATALOG = Object.freeze({
  perkByEditorId: new Map(),
  tracked: new Map(),
  globalByDesc: new Map(),
  missingPerks: [],
  missingPlugins: [],
  errors: []
});

let _catalog = EMPTY_CATALOG;
let _trackedLists = { perks: [], spells: [] };

function setCatalog(catalog) {
  _catalog = catalog || EMPTY_CATALOG;
  const perks = [];
  const spells = [];
  for (const [id, t] of _catalog.tracked) (t.kind === 'perk' ? perks : spells).push(id);
  _trackedLists = { perks, spells };
}

async function loadCatalog() {
  const d = deps();
  const api = d.mp();
  const catalog = await progressionForms.buildCatalogFromServer(api, {
    trackedPlugins: d.trackedPlugins,
    perkEditorIds: trees.allPerkEditorIds(),
    log: (m) => d.logger.log(m)
  });
  setCatalog(catalog);
  d.logger.log(`[skills] ${catalog.perkByEditorId.size} tree perks resolved, ${catalog.tracked.size} mod perks/spells tracked (${d.trackedPlugins.join(', ')}).`);
  if (catalog.missingPerks.length) d.logger.warn(`[skills] Tree perks not found in Skyrim.esm: ${catalog.missingPerks.join(', ')}`);
  if (catalog.missingPlugins.length) d.logger.warn(`[skills] Tracked plugins not in the load order: ${catalog.missingPlugins.join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-character state (cache; the service is the only writer)
// ─────────────────────────────────────────────────────────────────────────────

/** characterId → state */
const _states = new Map();
/** characterId → Promise chain, so two awards never race on the same row */
const _locks = new Map();
/** `${characterId}:${skill}` → last award time */
const _lastAward = new Map();

function _withLock(characterId, fn) {
  const prev = _locks.get(characterId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  _locks.set(characterId, tail);
  tail.then(() => { if (_locks.get(characterId) === tail) _locks.delete(characterId); });
  return next;
}

function _parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

async function loadState(characterId) {
  if (_states.has(characterId)) return _states.get(characterId);
  const { db } = deps();
  const [prog, rows, nodes, forms] = await Promise.all([
    db.query('SELECT * FROM character_progression WHERE character_id = ?', [characterId]),
    db.query('SELECT skill_code, slot, exp, legendary, legendary_bonus, trained_by FROM character_skills WHERE character_id = ?', [characterId]),
    db.query('SELECT skill_code, node_code FROM character_skill_nodes WHERE character_id = ?', [characterId]),
    db.query('SELECT form_kind, form_desc FROM character_mod_forms WHERE character_id = ?', [characterId])
  ]);
  const p = prog[0] || null;
  const added = p ? _parseJson(p.attr_added, {}) : {};
  const state = {
    characterId,
    progression: p ? {
      raceKey: p.race_key,
      isFemale: Boolean(p.is_female),
      base: skills.normalizeAttributes(_parseJson(p.attr_base, {})),
      spent: skills.normalizeAttributes(added.spent || {}),
      staff: skills.normalizeAttributes(added.staff || {}),
      magicUnlocked: Boolean(p.magic_unlocked),
      soulExp: Number(p.soul_exp) || 0,
      soulLegendary: Boolean(p.soul_legendary)
    } : null,
    skills: new Map(rows.map(r => [r.skill_code, {
      skill_code: r.skill_code,
      slot: r.slot,
      exp: Number(r.exp) || 0,
      legendary: Boolean(r.legendary),
      legendaryBonus: r.legendary_bonus || null,
      trainedBy: r.trained_by == null ? null : Number(r.trained_by)
    }])),
    nodes: new Map(),
    modForms: new Set(forms.map(f => `${f.form_kind}|${f.form_desc}`))
  };
  for (const n of nodes) {
    if (!state.nodes.has(n.skill_code)) state.nodes.set(n.skill_code, new Set());
    state.nodes.get(n.skill_code).add(n.node_code);
  }
  _states.set(characterId, state);
  return state;
}

function forget(characterId) {
  _states.delete(characterId);
  for (const key of _lastAward.keys()) if (key.startsWith(`${characterId}:`)) _lastAward.delete(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived view
// ─────────────────────────────────────────────────────────────────────────────

function soulLevelOf(state) {
  if (!state.progression) return 1;
  if (state.progression.soulLegendary) return skills.LEGENDARY_LEVEL;
  return skills.levelFromExp(state.progression.soulExp);
}

function attributesOf(state) {
  if (!state.progression) return null;
  const { base, spent, staff } = state.progression;
  const added = {};
  for (const key of skills.ATTRIBUTES) added[key] = spent[key] + staff[key];
  return skills.totalAttributes(base, added);
}

function characterLevelOf(state) {
  return skills.characterLevel([...state.skills.values()].map(skills.levelOfRow));
}

function attributePointsOf(state) {
  if (!state.progression) return 0;
  return skills.attributePointsAvailable({
    characterLevel: characterLevelOf(state),
    soulLevel: soulLevelOf(state),
    spent: skills.sumAdded(state.progression.spent)
  });
}

function nodesBought(state, skillCode) {
  return [...(state.nodes.get(skillCode) || [])];
}

/** Everything the F3 menu and /skills need. Pure read of the cache. */
function buildProfile(state) {
  const attributes = attributesOf(state);
  const soulLevel = soulLevelOf(state);
  const owned = [...state.skills.values()].map(row => {
    const skill = skills.getSkill(row.skill_code);
    if (!skill) return null;
    const progress = skills.progressOf(row.exp, { cap: skills.capForSlot(row.slot), legendary: row.legendary });
    const bought = nodesBought(state, skill.code);
    const pointsTotal = skills.skillPointsForLevel(progress.level);
    return {
      code: skill.code,
      name: skill.name,
      practitioner: skill.practitioner || null,
      category: skill.category,
      slot: row.slot,
      cap: row.legendary ? skills.LEGENDARY_LEVEL : skills.capForSlot(row.slot),
      level: progress.level,
      tier: progress.tier,
      exp: progress.exp,
      into: progress.into,
      needed: progress.needed,
      legendary: row.legendary,
      legendaryBonus: row.legendaryBonus,
      attribute: skill.attribute,
      modifier: attributes && skill.attribute ? skills.attributeModifier(attributes[skill.attribute]) : 0,
      effectiveLevel: attributes ? skills.effectiveLevel(skill.code, row, attributes) : progress.level,
      wholeTree: skills.hasWholeTree(progress.level),
      pointsTotal,
      pointsFree: Math.max(0, pointsTotal - bought.length),
      nodes: trees.treeOf(skill.code).map(n => ({
        code: n.code,
        name: n.name,
        path: n.path,
        minLevel: n.minLevel,
        requires: [...n.requires],
        effect: n.effect,
        kind: n.perk ? 'perk' : 'unlock',
        owned: skills.hasWholeTree(progress.level) || bought.includes(n.code)
      }))
    };
  }).filter(Boolean);
  const order = { profession: 0, combat: 1, armor: 2, magic: 3 };
  owned.sort((a, b) => order[a.category] - order[b.category] || (a.slot === 'primary' ? -1 : 1));

  return {
    chosen: Boolean(state.progression),
    race: state.progression ? (skills.RACES[state.progression.raceKey] || {}).name || state.progression.raceKey : null,
    characterLevel: characterLevelOf(state),
    attributePoints: attributePointsOf(state),
    attributes: attributes ? skills.ATTRIBUTES.map(key => ({
      key,
      name: skills.ATTRIBUTE_NAMES[key],
      value: attributes[key],
      base: state.progression.base[key],
      modifier: skills.attributeModifier(attributes[key])
    })) : [],
    soul: {
      level: soulLevel,
      tier: skills.tierOf(soulLevel).name,
      ...skills.progressOf(state.progression ? state.progression.soulExp : 0, { legendary: Boolean(state.progression && state.progression.soulLegendary) }),
      expBonusPct: skills.soulExpBonusPct(soulLevel),
      attributeBonus: skills.soulAttributeBonus(soulLevel)
    },
    magicUnlocked: Boolean(state.progression && state.progression.magicUnlocked),
    skills: owned
  };
}

/** Catalog of choosable skills for the F3 start screen. */
function choiceCatalog() {
  return skills.CATEGORIES.map(category => ({
    category,
    name: skills.CATEGORY_NAMES[category],
    skills: skills.skillsInCategory(category).map(s => ({
      code: s.code,
      name: s.name,
      practitioner: s.practitioner || null,
      attribute: skills.ATTRIBUTE_NAMES[s.attribute] || null,
      description: s.description
    }))
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Client sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The F3 menu's own files, sent once per session to clients whose launcher
 * predates the menu (see CEF_INJECTOR). null when they cannot be read.
 */
let _uiBundle = null;
/** actorIds that already received the UI bundle this session */
const _uiSent = new Set();

function loadUiBundle(dir = path.resolve(__dirname, '..', 'ui')) {
  try {
    _uiBundle = {
      js: fs.readFileSync(path.join(dir, 'skills-panel.js'), 'utf8'),
      css: fs.readFileSync(path.join(dir, 'skills-panel.css'), 'utf8')
    };
  } catch (err) {
    _uiBundle = null;
    deps().logger.warn(`[skills] skills-panel.js/.css not found in ${dir}: players with an older launcher will not get the F3 menu (${err.message}).`);
  }
  return _uiBundle;
}

/** characterId → perks sent last time (to remove ones staff took away) */
const _sentPerks = new Map();
/** actorId → characterId synced this session */
const _synced = new Map();

function buildClientPayload(state) {
  const perkIds = new Set();
  const spellIds = new Set();
  let av = {};

  if (state.progression) {
    const attributes = attributesOf(state);
    const rows = Object.fromEntries([...state.skills.entries()]);
    av = { ...skills.vanillaSkillValues(rows, attributes), ...skills.derivedStats(attributes) };
    for (const row of state.skills.values()) {
      const level = skills.levelOfRow(row);
      for (const code of trees.ownedNodes(row.skill_code, level, nodesBought(state, row.skill_code))) {
        const node = trees.findNode(row.skill_code, code);
        const id = node && node.perk ? _catalog.perkByEditorId.get(node.perk) : null;
        if (id) perkIds.add(id);
      }
    }
  }
  for (const key of state.modForms) {
    const i = key.indexOf('|');
    const kind = key.slice(0, i);
    const id = _catalog.globalByDesc.get(key.slice(i + 1).toLowerCase());
    if (!id) continue;
    (kind === 'perk' ? perkIds : spellIds).add(id);
  }

  const previous = _sentPerks.get(state.characterId) || new Set();
  const treePerkIds = new Set(_catalog.perkByEditorId.values());
  const removePerks = [...previous].filter(id => !perkIds.has(id) && treePerkIds.has(id));
  _sentPerks.set(state.characterId, perkIds);

  return {
    sentAt: deps().now(),
    av,
    perks: [...perkIds],
    removePerks,
    spells: [...spellIds],
    tracked: _trackedLists
  };
}

function pushToClient(actorId, state) {
  const api = deps().mp();
  if (!api || typeof api.set !== 'function') return;
  try {
    const payload = buildClientPayload(state);
    if (_uiBundle && !_uiSent.has(actorId)) {
      payload.ui = _uiBundle;
      _uiSent.add(actorId);
    }
    api.set(actorId, PROPERTY, payload);
  } catch (err) {
    deps().logger.error(`[skills] Could not send progression to 0x${actorId.toString(16)}:`, err.message);
  }
}

function sendPanel(actorId, state, extra = {}) {
  const api = deps().mp();
  if (!api || typeof api.set !== 'function') return;
  try {
    api.set(actorId, PANEL_PROPERTY, {
      sentAt: deps().now(),
      profile: buildProfile(state),
      catalog: choiceCatalog(),
      ...extra
    });
  } catch (err) {
    deps().logger.error(`[skills] Could not send the skills menu to 0x${actorId.toString(16)}:`, err.message);
  }
}

/** Re-sends everything to the character's player, if online. */
function refresh(characterId) {
  const state = _states.get(characterId);
  if (!state) return;
  const actorId = actorOf(characterId);
  if (!actorId) return;
  pushToClient(actorId, state);
}

function actorOf(characterId) {
  const { commands } = deps();
  return typeof commands.getActiveActorByCharacterId === 'function' ? commands.getActiveActorByCharacterId(characterId) : null;
}

function characterOf(actorId) {
  const { commands } = deps();
  const data = typeof commands.getActiveCharacterData === 'function' ? commands.getActiveCharacterData(actorId) : null;
  return data && Number.isInteger(data.characterId) ? data : null;
}

function say(actorId, message) {
  const { commands } = deps();
  if (actorId && typeof commands.sendNotification === 'function') commands.sendNotification(actorId, message);
}

function sayTo(characterId, message) {
  const actorId = actorOf(characterId);
  if (actorId) say(actorId, message);
}

let _loading = new Set();

/** Login/logout detection by polling, like player-shortcuts-service. */
async function tick() {
  const { commands } = deps();
  if (typeof commands.listActiveActorIds !== 'function') return;
  const present = new Set(commands.listActiveActorIds());
  for (const [actorId, characterId] of _synced) {
    const data = present.has(actorId) ? characterOf(actorId) : null;
    if (!data || data.characterId !== characterId) {
      _synced.delete(actorId);
      _uiSent.delete(actorId);
      _sentPerks.delete(characterId);
      forget(characterId);
    }
  }
  for (const actorId of present) {
    if (_synced.has(actorId) || _loading.has(actorId)) continue;
    const data = characterOf(actorId);
    if (!data) continue;
    _loading.add(actorId);
    try {
      const state = await loadState(data.characterId);
      _synced.set(actorId, data.characterId);
      pushToClient(actorId, state);
      if (!state.progression) {
        say(actorId, 'Press F3 to choose your profession, combat skill and armor.');
      }
    } catch (err) {
      deps().logger.error(`[skills] Could not load progression for character ${data.characterId}:`, err.message);
    } finally {
      _loading.delete(actorId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

async function audit(characterId, skillCode, action, amount = null, detail = null, byCharacterId = null) {
  try {
    await deps().db.query(
      'INSERT INTO skill_audit_log (character_id, skill_code, action, amount, detail, by_character_id) VALUES (?, ?, ?, ?, ?, ?)',
      [characterId, skillCode, action, amount, detail ? String(detail).slice(0, 255) : null, byCharacterId]
    );
  } catch (err) {
    deps().logger.error('[skills] audit failed:', err.message);
  }
}

function _addedJson(p) {
  return JSON.stringify({ spent: p.spent, staff: p.staff });
}

async function saveProgression(state) {
  const p = state.progression;
  await deps().db.query(
    `UPDATE character_progression
        SET attr_added = ?, magic_unlocked = ?, soul_exp = ?, soul_legendary = ?
      WHERE character_id = ?`,
    [_addedJson(p), p.magicUnlocked ? 1 : 0, p.soulExp, p.soulLegendary ? 1 : 0, state.characterId]
  );
}

/**
 * Race/sex from the character's appearance in SkyMP, for the base attributes.
 * @returns {{raceKey: string, isFemale: boolean}|null}
 */
function readRace(actorId) {
  const api = deps().mp();
  if (!api || typeof api.get !== 'function') return null;
  let appearance = null;
  try { appearance = api.get(actorId, 'appearance'); } catch { appearance = null; }
  if (!appearance) return null;
  const raceKey = skills.raceKeyFromRaceId(appearance.raceId);
  return raceKey ? { raceKey, isFemale: Boolean(appearance.isFemale) } : null;
}

async function createProgression(state, { raceKey, isFemale }) {
  const base = skills.baseAttributes(raceKey, isFemale);
  const empty = skills.normalizeAttributes({});
  await deps().db.query(
    `INSERT INTO character_progression (character_id, race_key, is_female, attr_base, attr_added)
     VALUES (?, ?, ?, ?, ?)`,
    [state.characterId, raceKey, isFemale ? 1 : 0, JSON.stringify(base), JSON.stringify({ spent: empty, staff: empty })]
  );
  state.progression = {
    raceKey,
    isFemale,
    base,
    spent: { ...empty },
    staff: { ...empty },
    magicUnlocked: false,
    soulExp: 0,
    soulLegendary: false
  };
}

async function insertSkill(state, skillCode, slot, { trainedBy = null, exp = 0 } = {}) {
  await deps().db.query(
    'INSERT INTO character_skills (character_id, skill_code, slot, exp, trained_by) VALUES (?, ?, ?, ?, ?)',
    [state.characterId, skillCode, slot, exp, trainedBy]
  );
  state.skills.set(skillCode, { skill_code: skillCode, slot, exp, legendary: false, legendaryBonus: null, trainedBy });
}

/**
 * F3 start choice. Creates the progression (base attributes from the
 * character's race and sex) and the three primary skills.
 */
function chooseStart(characterId, actorId, choice) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (state.progression && [...state.skills.values()].some(r => r.slot === 'primary')) {
      return { ok: false, message: 'You already chose. Ask staff if you need to change it.' };
    }
    const valid = skills.validateStartChoice(choice);
    if (!valid.ok) return valid;
    if (!state.progression) {
      const race = readRace(actorId);
      if (!race) return { ok: false, message: 'Your race could not be read. Ask staff for help.' };
      await createProgression(state, race);
    }
    for (const code of valid.skills) {
      if (!state.skills.has(code)) await insertSkill(state, code, 'primary');
    }
    await audit(characterId, 'start', 'choose', null, valid.skills.join(','));
    refresh(characterId);
    const names = valid.skills.map(c => skills.getSkill(c).name).join(', ');
    return { ok: true, message: `You begin your path: ${names}.` };
  });
}

/** Once spellcasting is unlocked: the character's own (primary) school. */
function chooseMagic(characterId, school) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (!state.progression) return { ok: false, message: 'Choose your profession first (F3).' };
    const skill = skills.getSkill(school);
    if (!skill || skill.category !== 'magic') return { ok: false, message: 'Choose a school of magic.' };
    const can = skills.canTake([...state.skills.values()], skill.code, 'primary', { magicUnlocked: state.progression.magicUnlocked });
    if (!can.ok) return can;
    await insertSkill(state, skill.code, 'primary');
    await audit(characterId, skill.code, 'choose_magic');
    refresh(characterId);
    return { ok: true, message: `You begin to study ${skill.name}.` };
  });
}

/**
 * Adds EXP to an owned skill. No-op (ok: false, code 'not_owned') otherwise.
 * @returns {Promise<{ok: boolean, code?: string, gained?: number, level?: number, tier?: string}>}
 */
function awardExp(characterId, skillCode, amount, { source = 'activity', silent = false } = {}) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    const row = state.skills.get(skillCode);
    if (!row) return { ok: false, code: 'not_owned' };
    const result = skills.addExp(row, amount, { bonusPct: skills.soulExpBonusPct(soulLevelOf(state)) });
    if (result.gained <= 0) return { ok: true, gained: 0, level: result.levelAfter, tier: result.tierAfter, capped: result.capped };
    await deps().db.query('UPDATE character_skills SET exp = ? WHERE character_id = ? AND skill_code = ?', [result.exp, characterId, skillCode]);
    row.exp = result.exp;
    if (result.levelAfter !== result.levelBefore) {
      const skill = skills.getSkill(skillCode);
      if (!silent) {
        sayTo(characterId, result.tierAfter !== result.tierBefore
          ? `${skill.name}: you are now ${articleFor(result.tierAfter)} ${result.tierAfter} (level ${result.levelAfter}).`
          : `${skill.name} increased to ${result.levelAfter}.`);
      }
      refresh(characterId);
    }
    return { ok: true, gained: result.gained, level: result.levelAfter, tier: result.tierAfter, source };
  });
}

function articleFor(word) {
  return /^[AEIOU]/i.test(word) ? 'an' : 'a';
}

/** Throttled award for client-reported actions. */
function _throttledAward(characterId, skillCode, amount, source) {
  const key = `${characterId}:${skillCode}`;
  const now = deps().now();
  if (now - (_lastAward.get(key) || 0) < EXP_RULES.minGapMs) return Promise.resolve({ ok: false, code: 'throttled' });
  _lastAward.set(key, now);
  return awardExp(characterId, skillCode, amount, { source });
}

function awardSoulExp(characterId, amount, { source = 'soul' } = {}) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (!state.progression) return { ok: false, code: 'no_progression' };
    if (state.progression.soulLegendary) return { ok: true, gained: 0, level: skills.LEGENDARY_LEVEL };
    const before = soulLevelOf(state);
    const cap = skills.expForLevel(skills.MAX_EARNED_LEVEL);
    const next = Math.min(cap, state.progression.soulExp + Math.max(0, Math.floor(Number(amount) || 0)));
    state.progression.soulExp = next;
    await saveProgression(state);
    const after = soulLevelOf(state);
    if (after !== before) {
      const tier = skills.tierOf(after).name;
      sayTo(characterId, skills.tierOf(before).name !== tier
        ? `Your soul deepens. It is now ${articleFor(tier)} ${tier} soul (level ${after}).`
        : `Your soul grows stronger (level ${after}).`);
      refresh(characterId);
    }
    return { ok: true, level: after, source };
  });
}

function buyNode(characterId, skillCode, nodeCode) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    const row = state.skills.get(skillCode);
    if (!row) return { ok: false, message: 'You do not know that skill.' };
    const bought = nodesBought(state, skillCode);
    const check = trees.canBuy({ skillCode, nodeCode, level: skills.levelOfRow(row), bought, pointsSpent: bought.length });
    if (!check.ok) return check;
    await deps().db.query(
      'INSERT INTO character_skill_nodes (character_id, skill_code, node_code) VALUES (?, ?, ?)',
      [characterId, skillCode, nodeCode]
    );
    if (!state.nodes.has(skillCode)) state.nodes.set(skillCode, new Set());
    state.nodes.get(skillCode).add(nodeCode);
    refresh(characterId);
    return { ok: true, message: `Learned ${check.node.name}.` };
  });
}

function spendAttributes(characterId, spend) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (!state.progression) return { ok: false, message: 'Choose your profession first (F3).' };
    const p = state.progression;
    const staffAndSpent = {};
    for (const key of skills.ATTRIBUTES) staffAndSpent[key] = p.spent[key] + p.staff[key];
    const r = skills.spendAttributePoints({ base: p.base, added: staffAndSpent, available: attributePointsOf(state), spend });
    if (!r.ok) return r;
    const s = skills.normalizeAttributes(spend);
    for (const key of skills.ATTRIBUTES) p.spent[key] += s[key];
    await saveProgression(state);
    refresh(characterId);
    return { ok: true, message: `Spent ${r.used} attribute point(s).` };
  });
}

/**
 * A Master (or staff) trains another character in a skill as their secondary
 * (capped at Adept). Category rules come from core/skills.js `canTake`.
 */
function trainSecondary({ teacherCharacterId = null, studentCharacterId, skillCode, isStaff = false }) {
  return _withLock(studentCharacterId, async () => {
    const skill = skills.getSkill(skillCode);
    if (!skill) return { ok: false, message: 'Unknown skill.' };
    if (!isStaff) {
      if (teacherCharacterId === studentCharacterId) return { ok: false, message: 'You cannot train yourself.' };
      const teacher = await loadState(teacherCharacterId);
      const level = skills.levelOfRow(teacher.skills.get(skill.code));
      if (!skills.canTeach(level)) return { ok: false, message: `Only a ${skill.name} Master can teach it.` };
    }
    const student = await loadState(studentCharacterId);
    if (!student.progression) return { ok: false, message: 'They have not chosen their path yet (F3).' };
    const can = skills.canTake([...student.skills.values()], skill.code, 'secondary', { magicUnlocked: student.progression.magicUnlocked });
    if (!can.ok) return { ok: false, message: can.message.replace(/^You /, 'They ').replace(/your /g, 'their ') };
    await insertSkill(student, skill.code, 'secondary', { trainedBy: teacherCharacterId });
    await audit(studentCharacterId, skill.code, 'train_secondary', null, isStaff ? 'staff' : null, teacherCharacterId);
    refresh(studentCharacterId);
    sayTo(studentCharacterId, `You have been trained in ${skill.name}. You can practise it up to Adept.`);
    return { ok: true, message: `Trained them in ${skill.name}.` };
  });
}

/** The basics of spellcasting: a magic Master or staff. */
function unlockMagic({ teacherCharacterId = null, studentCharacterId, isStaff = false }) {
  return _withLock(studentCharacterId, async () => {
    if (!isStaff) {
      const teacher = await loadState(teacherCharacterId);
      const isMagicMaster = [...teacher.skills.values()].some(r => {
        const s = skills.getSkill(r.skill_code);
        return s && s.category === 'magic' && skills.levelOfRow(r) >= skills.MASTER_LEVEL;
      });
      if (!isMagicMaster) return { ok: false, message: 'Only a Master of a school of magic can teach spellcasting.' };
      if (teacherCharacterId === studentCharacterId) return { ok: false, message: 'You cannot teach yourself.' };
    }
    const student = await loadState(studentCharacterId);
    if (!student.progression) return { ok: false, message: 'They have not chosen their path yet (F3).' };
    if (student.progression.magicUnlocked) return { ok: false, message: 'They already know the basics of spellcasting.' };
    student.progression.magicUnlocked = true;
    await deps().db.query(
      'UPDATE character_progression SET magic_unlocked = 1, magic_unlocked_by = ? WHERE character_id = ?',
      [teacherCharacterId, studentCharacterId]
    );
    await audit(studentCharacterId, 'magic', 'unlock', null, isStaff ? 'staff' : null, teacherCharacterId);
    sayTo(studentCharacterId, 'You understand the basics of spellcasting. Choose your school of magic in the F3 menu.');
    return { ok: true, message: 'They can now choose a school of magic (F3).' };
  });
}

// ─── Staff ────────────────────────────────────────────────────────────────

function staffSetLevel(characterId, skillCode, level, byCharacterId) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    const l = Math.floor(Number(level));
    if (!Number.isInteger(l) || l < 1 || l > skills.MAX_EARNED_LEVEL) {
      return { ok: false, message: `Level must be 1-${skills.MAX_EARNED_LEVEL}. Use /legendary for 100.` };
    }
    if (skillCode === skills.SOUL_CODE) {
      if (!state.progression) return { ok: false, message: 'They have not chosen their path yet (F3).' };
      state.progression.soulExp = skills.expForLevel(l);
      state.progression.soulLegendary = false;
      await saveProgression(state);
    } else {
      const row = state.skills.get(skillCode);
      if (!row) return { ok: false, message: 'They do not know that skill.' };
      if (l > skills.capForSlot(row.slot)) return { ok: false, message: `A trained (secondary) skill stops at ${skills.SECONDARY_CAP}.` };
      row.exp = skills.expForLevel(l);
      row.legendary = false;
      await deps().db.query('UPDATE character_skills SET exp = ?, legendary = 0 WHERE character_id = ? AND skill_code = ?', [row.exp, characterId, skillCode]);
    }
    await audit(characterId, skillCode, 'set_level', l, null, byCharacterId);
    refresh(characterId);
    return { ok: true, message: `Set to level ${l} (${skills.tierOf(l).name}).` };
  });
}

function staffSetLegendary(characterId, skillCode, on, bonus, byCharacterId) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    const text = bonus ? String(bonus).slice(0, 200) : null;
    if (skillCode === skills.SOUL_CODE) {
      if (!state.progression) return { ok: false, message: 'They have not chosen their path yet (F3).' };
      state.progression.soulLegendary = Boolean(on);
      if (!on) state.progression.soulExp = Math.min(state.progression.soulExp, skills.expForLevel(skills.MAX_EARNED_LEVEL));
      await saveProgression(state);
    } else {
      const row = state.skills.get(skillCode);
      if (!row) return { ok: false, message: 'They do not know that skill.' };
      row.legendary = Boolean(on);
      row.legendaryBonus = on ? text : null;
      if (!on) row.exp = Math.min(row.exp, skills.expForLevel(skills.capForSlot(row.slot)));
      await deps().db.query(
        'UPDATE character_skills SET legendary = ?, legendary_bonus = ?, exp = ? WHERE character_id = ? AND skill_code = ?',
        [on ? 1 : 0, row.legendaryBonus, row.exp, characterId, skillCode]
      );
    }
    await audit(characterId, skillCode, on ? 'legendary' : 'legendary_off', null, text, byCharacterId);
    refresh(characterId);
    if (on) {
      const name = skillCode === skills.SOUL_CODE ? 'soul' : skills.getSkill(skillCode).name;
      sayTo(characterId, `Your ${name} is now Legendary.${text ? ` Bonus: ${text}` : ''}`);
    }
    return { ok: true, message: on ? 'Set to Legendary (100).' : 'Legendary removed.' };
  });
}

function staffGrantSkill(characterId, skillCode, slot, byCharacterId) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (!state.progression) return { ok: false, message: 'They have not chosen their path yet (F3).' };
    const skill = skills.getSkill(skillCode);
    if (!skill) return { ok: false, message: 'Unknown skill.' };
    // Staff may skip the magic lock but not the one-per-slot rule.
    const can = skills.canTake([...state.skills.values()], skill.code, slot, { magicUnlocked: true });
    if (!can.ok) return can;
    await insertSkill(state, skill.code, slot);
    await audit(characterId, skill.code, 'grant', null, slot, byCharacterId);
    refresh(characterId);
    return { ok: true, message: `Gave them ${skill.name} (${slot}).` };
  });
}

function staffRemoveSkill(characterId, skillCode, byCharacterId) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (!state.skills.has(skillCode)) return { ok: false, message: 'They do not know that skill.' };
    const { db } = deps();
    await db.query('DELETE FROM character_skill_nodes WHERE character_id = ? AND skill_code = ?', [characterId, skillCode]);
    await db.query('DELETE FROM character_skills WHERE character_id = ? AND skill_code = ?', [characterId, skillCode]);
    state.skills.delete(skillCode);
    state.nodes.delete(skillCode);
    await audit(characterId, skillCode, 'remove', null, null, byCharacterId);
    refresh(characterId);
    return { ok: true, message: `Removed ${skills.getSkill(skillCode).name}.` };
  });
}

/** Sets an attribute's total by adjusting the staff part (not the player's points). */
function staffSetAttribute(characterId, attribute, value, byCharacterId) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    if (!state.progression) return { ok: false, message: 'They have not chosen their path yet (F3).' };
    const key = String(attribute || '').toLowerCase();
    if (!skills.ATTRIBUTES.includes(key)) return { ok: false, message: `Attribute must be one of: ${skills.ATTRIBUTES.join(', ')}.` };
    const v = Math.floor(Number(value));
    if (!Number.isInteger(v) || v < 0 || v > skills.ATTRIBUTE_CAP) return { ok: false, message: 'Value must be 0-100.' };
    const p = state.progression;
    p.staff[key] = v - p.base[key] - p.spent[key];
    await saveProgression(state);
    await audit(characterId, 'attributes', 'set', v, key, byCharacterId);
    refresh(characterId);
    return { ok: true, message: `${skills.ATTRIBUTE_NAMES[key]} set to ${v}.` };
  });
}

/** Wipes skills, nodes, attributes and soul level so the player can choose again. */
function staffReset(characterId, byCharacterId) {
  return _withLock(characterId, async () => {
    const { db } = deps();
    await db.query('DELETE FROM character_skill_nodes WHERE character_id = ?', [characterId]);
    await db.query('DELETE FROM character_skills WHERE character_id = ?', [characterId]);
    await db.query('DELETE FROM character_progression WHERE character_id = ?', [characterId]);
    const state = await loadState(characterId);
    state.progression = null;
    state.skills.clear();
    state.nodes.clear();
    await audit(characterId, 'all', 'reset', null, null, byCharacterId);
    refresh(characterId);
    sayTo(characterId, 'Your skills were reset by staff. Press F3 to choose again.');
    return { ok: true, message: 'Reset. They can choose again with F3.' };
  });
}

// ─── Mirrored mod forms (Mundus, Pilgrim, …) ─────────────────────────────

function storeModReport(characterId, report) {
  return _withLock(characterId, async () => {
    const state = await loadState(characterId);
    const diff = progressionForms.diffReport(_catalog.tracked, state.modForms, report || {});
    const { db } = deps();
    for (const f of diff.add) {
      await db.query('INSERT IGNORE INTO character_mod_forms (character_id, form_kind, form_desc) VALUES (?, ?, ?)', [characterId, f.kind, f.formDesc]);
      state.modForms.add(`${f.kind}|${f.formDesc}`);
    }
    for (const f of diff.remove) {
      await db.query('DELETE FROM character_mod_forms WHERE character_id = ? AND form_kind = ? AND form_desc = ?', [characterId, f.kind, f.formDesc]);
      state.modForms.delete(`${f.kind}|${f.formDesc}`);
    }
    if (diff.add.length || diff.remove.length) {
      deps().logger.log(`[skills] character ${characterId}: mod progression +${diff.add.length} -${diff.remove.length}`);
    }
    return diff;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: client reports, gameplay activity, soul events
// ─────────────────────────────────────────────────────────────────────────────

async function handleReport(actorId, report) {
  if (!report || typeof report !== 'object') return;
  const data = characterOf(actorId);
  if (!data) return;
  const characterId = data.characterId;
  switch (report.kind) {
    case 'mods':
      // Only after this session's progression was applied (sentAt present),
      // otherwise a fresh client would report "nothing" and wipe the record.
      if (!_synced.has(actorId) || !report.sentAt) return;
      await storeModReport(characterId, {
        perks: Array.isArray(report.perks) ? report.perks.slice(0, 2000) : [],
        spells: Array.isArray(report.spells) ? report.spells.slice(0, 2000) : [],
        unresolved: Array.isArray(report.unresolved) ? report.unresolved.slice(0, 2000) : []
      });
      return;
    case 'hit': {
      const amount = report.power ? EXP_RULES.powerHit : EXP_RULES.hit;
      const skill = skillForWeaponType(report.weaponType);
      if (skill) await _throttledAward(characterId, skill, amount, 'combat');
      if (report.dual) await _throttledAward(characterId, 'dual_wielding', amount, 'combat');
      return;
    }
    case 'struck': {
      const skill = skillForWeightClass(report.weightClass);
      if (skill) await _throttledAward(characterId, skill, EXP_RULES.struck, 'combat');
      return;
    }
    case 'cast': {
      const skill = skills.getSkill(String(report.school || '').toLowerCase());
      if (skill && skill.category === 'magic') await _throttledAward(characterId, skill.code, EXP_RULES.cast, 'magic');
      return;
    }
    default:
  }
}

function handleActivity(activity) {
  const characterId = Number(activity.characterId);
  const skillCode = activity.skill || PROFESSION_TO_SKILL[activity.professionCode];
  if (!skillCode || !skills.getSkill(skillCode)) return null;
  const amount = Number(activity.amount);
  if (!(amount > 0)) return null;
  return awardExp(characterId, skillCode, amount, { source: activity.source || 'activity' });
}

const _soulHandlers = [];

function subscribeSoul() {
  let soulService;
  try { soulService = require('./soul-service'); } catch { return; }
  if (typeof soulService.onSoulEvent !== 'function') return;
  for (const [event, amount] of Object.entries(SOUL_EXP)) {
    const handler = (payload) => {
      if (!payload || !Number.isInteger(payload.characterId)) return;
      awardSoulExp(payload.characterId, amount, { source: event }).catch(err =>
        deps().logger.error('[skills] soul EXP failed:', err.message));
    };
    soulService.onSoulEvent(event, handler);
    _soulHandlers.push([soulService, event, handler]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gameplay gates (for mining, harvesting, crafting code)
// ─────────────────────────────────────────────────────────────────────────────

/** Effective level (with attribute modifier) of an owned skill, 0 if not owned. */
async function skillLevel(characterId, skillCode) {
  const state = await loadState(characterId);
  const row = state.skills.get(skillCode);
  if (!row) return 0;
  const attributes = attributesOf(state);
  return attributes ? skills.effectiveLevel(skillCode, row, attributes) : skills.levelOfRow(row);
}

/** Does the character own this tree node (bought, or Master of the skill)? */
async function hasUnlock(characterId, skillCode, nodeCode) {
  const state = await loadState(characterId);
  const row = state.skills.get(skillCode);
  if (!row) return false;
  return trees.ownedNodes(skillCode, skills.levelOfRow(row), nodesBought(state, skillCode)).includes(nodeCode);
}

async function canMine(characterId, ore) {
  return skills.canMine(ore, await skillLevel(characterId, 'prospector'));
}

async function canHarvestCreature(characterId, creature) {
  return skills.canHarvestCreature(creature, await skillLevel(characterId, 'hunter'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

function formatSkillLine(s) {
  const mod = s.modifier ? ` (${s.modifier > 0 ? '+' : ''}${s.modifier} ${skills.ATTRIBUTE_NAMES[s.attribute]})` : '';
  const exp = s.legendary ? 'Legendary' : (s.needed ? `${s.into}/${s.needed} EXP` : `max for ${s.slot}`);
  const points = s.wholeTree ? 'whole tree' : `${s.pointsFree} point(s)`;
  const slot = s.slot === 'secondary' ? ', trained' : '';
  return `${s.name}${slot} — ${s.tier} ${s.level}${mod} · ${exp} · ${points}`;
}

function profileLines(profile) {
  if (!profile.chosen) return ['You have not chosen your path yet. Press F3.'];
  const lines = [`Character level ${profile.characterLevel} · ${profile.attributePoints} attribute point(s) to spend · Soul: ${profile.soul.tier} ${profile.soul.level}`];
  for (const s of profile.skills) lines.push(formatSkillLine(s));
  if (!profile.magicUnlocked) lines.push('Magic: not yet learned.');
  return lines;
}

function isStaffWith(actorId) {
  const { admin } = deps();
  return Boolean(admin && typeof admin.hasPermission === 'function' && admin.hasPermission(actorId, PERMISSION));
}

function parseTarget(args) {
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  const actorId = Number(parts[0]);
  return { actorId: Number.isFinite(actorId) ? actorId : null, rest: parts.slice(1) };
}

/** Skill or soul code from a typed name. */
function skillOrSoul(text) {
  if (String(text || '').toLowerCase() === skills.SOUL_CODE) return skills.SOUL_CODE;
  const s = skills.findSkill(text);
  return s ? s.code : null;
}

async function cmdSkills(actorId) {
  const data = characterOf(actorId);
  if (!data) return say(actorId, 'No active character.');
  const state = await loadState(data.characterId);
  for (const line of profileLines(buildProfile(state))) say(actorId, line);
}

async function cmdAttributes(actorId) {
  const data = characterOf(actorId);
  if (!data) return say(actorId, 'No active character.');
  const profile = buildProfile(await loadState(data.characterId));
  if (!profile.chosen) return say(actorId, 'You have not chosen your path yet. Press F3.');
  say(actorId, profile.attributes.map(a => `${a.name} ${a.value}${a.modifier ? ` (${a.modifier > 0 ? '+' : ''}${a.modifier})` : ''}`).join(' · '));
  say(actorId, `${profile.attributePoints} point(s) to spend — use the F3 menu.`);
}

function cmdMenu(actorId) {
  const data = characterOf(actorId);
  if (!data) return say(actorId, 'No active character.');
  return openPanel(actorId);
}

async function cmdTrain(actorId, args) {
  const teacher = characterOf(actorId);
  if (!teacher) return say(actorId, 'No active character.');
  const { actorId: targetActor, rest } = parseTarget(args);
  const student = targetActor ? characterOf(targetActor) : null;
  const skill = skills.findSkill(rest.join(' '));
  if (!student || !skill) return say(actorId, 'Usage: /train <player#> <skill>');
  const staff = isStaffWith(actorId);
  const r = await trainSecondary({ teacherCharacterId: teacher.characterId, studentCharacterId: student.characterId, skillCode: skill.code, isStaff: false });
  if (!r.ok && staff) {
    const forced = await trainSecondary({ teacherCharacterId: teacher.characterId, studentCharacterId: student.characterId, skillCode: skill.code, isStaff: true });
    return say(actorId, forced.message);
  }
  say(actorId, r.message);
}

async function cmdTeachMagic(actorId, args) {
  const teacher = characterOf(actorId);
  if (!teacher) return say(actorId, 'No active character.');
  const { actorId: targetActor } = parseTarget(args);
  const student = targetActor ? characterOf(targetActor) : null;
  if (!student) return say(actorId, 'Usage: /teachmagic <player#>');
  const r = await unlockMagic({ teacherCharacterId: teacher.characterId, studentCharacterId: student.characterId, isStaff: isStaffWith(actorId) });
  say(actorId, r.message);
}

/** Wraps a staff command: permission, target, and the staff character id. */
function staffCommand(usage, fn) {
  return async (actorId, args) => {
    if (!isStaffWith(actorId)) return say(actorId, 'Staff only.');
    const { actorId: targetActor, rest } = parseTarget(args);
    const target = targetActor ? characterOf(targetActor) : null;
    if (!target) return say(actorId, `Usage: ${usage}`);
    const me = characterOf(actorId);
    const result = await fn({ actorId, target, rest, byCharacterId: me ? me.characterId : null });
    if (result && result.message) say(actorId, result.message);
  };
}

const cmdSkillExp = staffCommand('/skillexp <player#> <skill|soul> <amount>', async ({ target, rest, byCharacterId }) => {
  const amount = Math.floor(Number(rest[rest.length - 1]));
  const code = skillOrSoul(rest.slice(0, -1).join(' '));
  if (!code || !Number.isInteger(amount) || amount <= 0) return { message: 'Usage: /skillexp <player#> <skill|soul> <amount>' };
  const r = code === skills.SOUL_CODE
    ? await awardSoulExp(target.characterId, amount, { source: 'staff' })
    : await awardExp(target.characterId, code, amount, { source: 'staff' });
  if (!r.ok) return { message: r.code === 'not_owned' ? 'They do not know that skill.' : 'They have not chosen their path yet (F3).' };
  await audit(target.characterId, code, 'grant_exp', amount, null, byCharacterId);
  return { message: `Gave ${amount} EXP. Now level ${r.level}.` };
});

const cmdSkillSet = staffCommand('/skillset <player#> <skill|soul> <level 1-99>', async ({ target, rest, byCharacterId }) => {
  const code = skillOrSoul(rest.slice(0, -1).join(' '));
  if (!code) return { message: 'Usage: /skillset <player#> <skill|soul> <level 1-99>' };
  return staffSetLevel(target.characterId, code, rest[rest.length - 1], byCharacterId);
});

const cmdLegendary = staffCommand('/legendary <player#> <skill|soul> [bonus | off]', async ({ target, rest, byCharacterId }) => {
  // The skill name can be several words; the bonus text follows it.
  let code = null;
  let used = 0;
  for (let n = Math.min(3, rest.length); n >= 1; n--) {
    code = skillOrSoul(rest.slice(0, n).join(' '));
    if (code) { used = n; break; }
  }
  if (!code) return { message: 'Usage: /legendary <player#> <skill|soul> [bonus | off]' };
  const tail = rest.slice(used).join(' ').trim();
  if (tail.toLowerCase() === 'off') return staffSetLegendary(target.characterId, code, false, null, byCharacterId);
  return staffSetLegendary(target.characterId, code, true, tail || null, byCharacterId);
});

const cmdSkillGrant = staffCommand('/skillgrant <player#> <skill> <primary|secondary>', async ({ target, rest, byCharacterId }) => {
  const slot = String(rest[rest.length - 1] || '').toLowerCase();
  const skill = skills.findSkill(rest.slice(0, -1).join(' '));
  if (!skill || (slot !== 'primary' && slot !== 'secondary')) return { message: 'Usage: /skillgrant <player#> <skill> <primary|secondary>' };
  return staffGrantSkill(target.characterId, skill.code, slot, byCharacterId);
});

const cmdSkillRemove = staffCommand('/skillremove <player#> <skill>', async ({ target, rest, byCharacterId }) => {
  const skill = skills.findSkill(rest.join(' '));
  if (!skill) return { message: 'Usage: /skillremove <player#> <skill>' };
  return staffRemoveSkill(target.characterId, skill.code, byCharacterId);
});

const cmdMagicUnlock = staffCommand('/magicunlock <player#>', async ({ target, byCharacterId }) =>
  unlockMagic({ teacherCharacterId: byCharacterId, studentCharacterId: target.characterId, isStaff: true }));

const cmdAttrSet = staffCommand('/attrset <player#> <attribute> <value>', async ({ target, rest, byCharacterId }) =>
  staffSetAttribute(target.characterId, rest[0], rest[1], byCharacterId));

const cmdSkillsOf = staffCommand('/skillsof <player#>', async ({ actorId, target }) => {
  const profile = buildProfile(await loadState(target.characterId));
  for (const line of profileLines(profile)) say(actorId, line);
  if (profile.chosen) say(actorId, profile.attributes.map(a => `${a.name} ${a.value}`).join(' · '));
  return null;
});

const cmdSkillReset = staffCommand('/skillreset <player#> confirm', async ({ target, rest, byCharacterId }) => {
  if (String(rest[0] || '').toLowerCase() !== 'confirm') return { message: 'This wipes all their skills, attributes and soul level. Type: /skillreset <player#> confirm' };
  return staffReset(target.characterId, byCharacterId);
});

function commandDefs() {
  const wrap = (fn) => (actorId, args) => Promise.resolve(fn(actorId, args)).catch((err) => {
    deps().logger.error('[skills] command failed:', err.message);
    say(actorId, 'Could not complete that. Check the server log.');
  });
  return [
    { name: '/skills', handler: wrap(cmdSkills), description: 'Your skills, levels and soul', usage: '/skills' },
    { name: '/attributes', handler: wrap(cmdAttributes), description: 'Your attributes', usage: '/attributes' },
    { name: '/skillmenu', handler: wrap(cmdMenu), description: 'Open the skills menu (also F3)', usage: '/skillmenu' },
    { name: '/train', handler: wrap(cmdTrain), description: 'As a Master, train someone in your skill (up to Adept)', usage: '/train <player#> <skill>' },
    { name: '/teachmagic', handler: wrap(cmdTeachMagic), description: 'As a magic Master, teach someone the basics of spellcasting', usage: '/teachmagic <player#>' },
    { name: '/skillexp', handler: wrap(cmdSkillExp), description: '[Staff] Give skill or soul EXP', usage: '/skillexp <player#> <skill|soul> <amount>' },
    { name: '/skillset', handler: wrap(cmdSkillSet), description: '[Staff] Set a skill or soul level (1-99)', usage: '/skillset <player#> <skill|soul> <level>' },
    { name: '/legendary', handler: wrap(cmdLegendary), description: '[Staff] Make a skill or soul Legendary (100), with an RP bonus', usage: '/legendary <player#> <skill|soul> [bonus | off]' },
    { name: '/skillgrant', handler: wrap(cmdSkillGrant), description: '[Staff] Give a skill', usage: '/skillgrant <player#> <skill> <primary|secondary>' },
    { name: '/skillremove', handler: wrap(cmdSkillRemove), description: '[Staff] Take a skill away', usage: '/skillremove <player#> <skill>' },
    { name: '/magicunlock', handler: wrap(cmdMagicUnlock), description: '[Staff] Unlock magic for a character', usage: '/magicunlock <player#>' },
    { name: '/attrset', handler: wrap(cmdAttrSet), description: '[Staff] Set an attribute', usage: '/attrset <player#> <attribute> <value>' },
    { name: '/skillsof', handler: wrap(cmdSkillsOf), description: '[Staff] See a character\'s skills', usage: '/skillsof <player#>' },
    { name: '/skillreset', handler: wrap(cmdSkillReset), description: '[Staff] Wipe a character\'s skills so they choose again', usage: '/skillreset <player#> confirm' }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// F3 menu (UI events, namespace `skills:`)
// ─────────────────────────────────────────────────────────────────────────────

async function openPanel(actorId, extra = {}) {
  const data = characterOf(actorId);
  if (!data) return;
  sendPanel(actorId, await loadState(data.characterId), extra);
}

async function handleUiEvent(actorId, uiEvent) {
  if (!uiEvent || typeof uiEvent.type !== 'string' || !uiEvent.type.startsWith('skills:')) return false;
  const data = characterOf(actorId);
  if (!data) return true;
  const d = uiEvent.data || {};
  let result = null;
  switch (uiEvent.type) {
    case 'skills:open':
      await openPanel(actorId);
      return true;
    case 'skills:close':
      return true;
    case 'skills:choose':
      result = await chooseStart(data.characterId, actorId, { profession: d.profession, combat: d.combat, armor: d.armor });
      break;
    case 'skills:chooseMagic':
      result = await chooseMagic(data.characterId, d.school);
      break;
    case 'skills:buyNode':
      result = await buyNode(data.characterId, String(d.skill || ''), String(d.node || ''));
      break;
    case 'skills:spendAttributes':
      result = await spendAttributes(data.characterId, d.spend || {});
      break;
    default:
      return false;
  }
  await openPanel(actorId, { result: result ? { ok: Boolean(result.ok), message: result.message || '' } : null });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let _timer = null;
let _unsubscribeActivity = null;

async function initialize(overrides = {}) {
  configure(overrides);
  const d = deps();
  const api = d.mp();
  if (api) {
    if (typeof api.makeProperty === 'function') {
      api.makeProperty(PROPERTY, { isVisibleByOwner: true, isVisibleByNeighbors: false, updateOwner: UPDATE_OWNER_SNIPPET, updateNeighbor: '' });
      api.makeProperty(PANEL_PROPERTY, { isVisibleByOwner: true, isVisibleByNeighbors: false, updateOwner: PANEL_UPDATE_OWNER_SNIPPET, updateNeighbor: '' });
    }
    if (typeof api.makeEventSource === 'function') {
      api.makeEventSource(REPORT_EVENT, REPORT_SNIPPET);
      api[REPORT_EVENT] = (pcFormId, report) => {
        handleReport(pcFormId, report).catch(err => d.logger.error('[skills] report failed:', err.message));
      };
    }
  }
  // Built in the background: reading the plugins takes a few seconds and the
  // first sync waits for nothing but the database.
  loadCatalog().then(() => {
    // Players synced before the catalog was ready get their perks now.
    for (const [actorId, characterId] of _synced) {
      const state = _states.get(characterId);
      if (state) pushToClient(actorId, state);
    }
  }).catch(err => d.logger.error('[skills] Could not read the plugins for perks/spells:', err.message));

  loadUiBundle();
  _unsubscribeActivity = skillActivity.subscribe(handleActivity);
  subscribeSoul();
  _timer = setInterval(() => { tick().catch(err => d.logger.error('[skills] tick failed:', err.message)); }, 2000);
  if (typeof _timer.unref === 'function') _timer.unref();
}

function shutdown() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (_unsubscribeActivity) _unsubscribeActivity();
  _unsubscribeActivity = null;
  for (const [svc, event, handler] of _soulHandlers.splice(0)) {
    if (typeof svc.offSoulEvent === 'function') svc.offSoulEvent(event, handler);
  }
  const api = deps().mp();
  if (api && api[REPORT_EVENT]) api[REPORT_EVENT] = undefined;
}

function _resetForTest() {
  _states.clear();
  _locks.clear();
  _lastAward.clear();
  _synced.clear();
  _sentPerks.clear();
  _uiSent.clear();
  _uiBundle = null;
  _loading = new Set();
  _deps = null;
  setCatalog(EMPTY_CATALOG);
}

module.exports = {
  MODULE_ID,
  FLAG,
  PROPERTY,
  PANEL_PROPERTY,
  REPORT_EVENT,
  PERMISSION,
  EXP_RULES,
  SOUL_EXP,
  PROFESSION_TO_SKILL,
  UPDATE_OWNER_SNIPPET,
  REPORT_SNIPPET,
  PANEL_UPDATE_OWNER_SNIPPET,
  skillForWeaponType,
  skillForWeightClass,
  CEF_INJECTOR,
  configure,
  setCatalog,
  loadUiBundle,
  loadState,
  buildProfile,
  buildClientPayload,
  chooseStart,
  chooseMagic,
  awardExp,
  awardSoulExp,
  buyNode,
  spendAttributes,
  trainSecondary,
  unlockMagic,
  staffSetLevel,
  staffSetLegendary,
  staffGrantSkill,
  staffRemoveSkill,
  staffSetAttribute,
  staffReset,
  storeModReport,
  handleReport,
  handleActivity,
  handleUiEvent,
  skillLevel,
  hasUnlock,
  canMine,
  canHarvestCreature,
  tick,
  commandDefs,
  initialize,
  shutdown,
  _resetForTest
};
