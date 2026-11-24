/**
 * core/gear-tiers.js — material tiers for armor and weapons
 *
 * One table drives both sides: tools/crafting/build-armor-recipes.js uses it to
 * gate every crafting recipe in Oathbound_Armor.esp behind the crafter's
 * profession tier, and the server uses the generated data/gear-tiers.json to
 * keep players from equipping gear above their tier in the matching skill.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TIER_KEYS = Object.freeze(['novice', 'apprentice', 'adept', 'expert', 'master']);
const TIER_NAMES = Object.freeze(['Novice', 'Apprentice', 'Adept', 'Expert', 'Master']);

/** First match wins, so the more specific materials come first. */
const MATERIAL_RULES = Object.freeze([
  [/guard(?!ian)/i, 'apprentice'],
  [/stormcloak|eastmarch/i, 'apprentice'],
  [/steel\s*plate|steelplate/i, 'expert'],
  [/dragon\s*(plate|scale|bone)|dragonplate|dragonscale|dragonbone|daedric|daedra|ebony|glass|stalhrim|malachite/i, 'master'],
  [/orcish|orichalcum|quicksilver|elven\s*gilded|elvengilded/i, 'expert'],
  [/elven|moonstone|dwarven|dwemer|chitin|falmer|nordic|silver|gold|vampire|nightingale|thievesguild|thieves guild|darkbrotherhood|dark brotherhood|blades|moragtong|morag tong/i, 'adept'],
  [/steel|corundum|bonemold|scaled|imperial|dawnguard|hunter|penitus/i, 'apprentice'],
  [/iron|hide|leather|studded|\bfur\b|forsworn|draugr|ancient\s*nord|\bwood/i, 'novice']
]);

/** Crafting materials by editor id. */
const INGREDIENT_RULES = Object.freeze([
  [/^(IngotEbony|ingotMalachite|DragonBone|DragonScales|DaedraHeart|DLC2OreStalhrim)$/i, 'master'],
  [/^(IngotQuicksilver|IngotOrichalcum)$/i, 'expert'],
  [/^(ingotSilver|IngotGold|IngotIMoonstone|IngotDwarven|DLC2ChitinPlate|ChaurusChitin)$/i, 'adept'],
  [/^(IngotSteel|IngotCorundum|DLC2NetchLeather|DLC2BoneMold.*)$/i, 'apprentice'],
  [/^(IngotIron|Leather01|LeatherStrips|Hide.*|Pelt.*|Firewood01)$/i, 'novice']
]);

/** Ore and the ingot it smelts into share a tier (same as core/skills.js ORE_TIERS). */
const ORE_RULES = Object.freeze([
  [/ebony|malachite|stalhrim/i, 'master'],
  [/quicksilver|orichalcum/i, 'expert'],
  [/moonstone|silver|gold|dwarven|dwemer/i, 'adept'],
  [/corundum|steel/i, 'apprentice'],
  [/iron/i, 'novice']
]);

function tierIndexOf(key) {
  return TIER_KEYS.indexOf(key);
}

function firstMatch(rules, text) {
  if (!text) return null;
  for (const [re, tier] of rules) if (re.test(text)) return tier;
  return null;
}

function highest(tiers) {
  let best = -1;
  for (const t of tiers) best = Math.max(best, tierIndexOf(t));
  return best >= 0 ? TIER_KEYS[best] : null;
}

/**
 * Tier of a piece of gear.
 * @param {{keywords?: string[], name?: string, edid?: string, ingredients?: string[]}} item
 * @returns {{tier: string|null, by: string}}
 */
function classify(item) {
  const label = `${item.name || ''} ${item.edid || ''}`;
  if (/guard(?!ian)/i.test(label)) return { tier: 'apprentice', by: 'guard' };
  if (/stormcloak|eastmarch/i.test(label)) return { tier: 'apprentice', by: 'name' };
  if (/steel\s*plate|steelplate/i.test(label)) return { tier: 'expert', by: 'name' };
  const materials = (item.keywords || []).filter((k) => /material/i.test(k));
  const own = materials.filter((k) => !/^WAF_/i.test(k));
  const byKeyword = highest((own.length ? own : materials).map((k) => firstMatch(MATERIAL_RULES, k)).filter(Boolean));
  if (byKeyword) return { tier: byKeyword, by: 'keyword' };
  const byName = firstMatch(MATERIAL_RULES, label);
  if (byName) return { tier: byName, by: 'name' };
  const byIngredient = highest((item.ingredients || []).map((e) => firstMatch(INGREDIENT_RULES, e)).filter(Boolean));
  if (byIngredient) return { tier: byIngredient, by: 'ingredients' };
  return { tier: null, by: 'unknown' };
}

/** Tier of an ingot or other smelter output, from its own name or its ore. */
function smeltTier(outputEdid, inputEdids = []) {
  return firstMatch(ORE_RULES, outputEdid) || highest(inputEdids.map((e) => firstMatch(ORE_RULES, e)).filter(Boolean)) || 'novice';
}

/** Skill a weapon trains, from its DNAM animation type. */
const WEAPON_SKILL_BY_ANIM = Object.freeze({ 1: 'one_handed', 2: 'one_handed', 3: 'one_handed', 4: 'one_handed', 5: 'two_handed', 6: 'two_handed', 7: 'archery', 9: 'archery' });

/** Skill an armor piece needs, from its armor type (0 light, 1 heavy, 2 clothing). */
function armorSkill(armorType) {
  if (armorType === 1) return 'heavy_armor';
  if (armorType === 0) return 'light_armor';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier perks (Oathbound_Armor.esp): crafting recipes require them
// ─────────────────────────────────────────────────────────────────────────────

const CRAFT_SKILLS = Object.freeze({ metal_worker: 'Metalworking', outfitter: 'Outfitting' });

function tierPerk(skill, tierKey) {
  return `OB_${CRAFT_SKILLS[skill]}_${TIER_NAMES[tierIndexOf(tierKey)]}`;
}

/** Perks a crafter owns: one per tier up to their own. */
function tierPerksFor(skill, tierIdx) {
  if (!CRAFT_SKILLS[skill] || !(tierIdx >= 0)) return [];
  return TIER_KEYS.slice(0, Math.min(tierIdx, TIER_KEYS.length - 1) + 1).map((t) => tierPerk(skill, t));
}

function allTierPerks() {
  return Object.keys(CRAFT_SKILLS).flatMap((s) => TIER_KEYS.map((t) => tierPerk(s, t)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime lookup (server)
// ─────────────────────────────────────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, '..', 'data', 'gear-tiers.json');
let _table = null;

function normalizeDesc(desc) {
  const m = /^(?:0x)?0*([0-9a-f]+):(.+)$/i.exec(String(desc || '').trim());
  return m ? `${m[1].toLowerCase()}:${m[2].toLowerCase()}` : null;
}

function load(file = DATA_FILE) {
  _table = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [desc, entry] of Object.entries(raw.items || {})) {
      const key = normalizeDesc(desc);
      if (key && Array.isArray(entry)) _table.set(key, { skill: entry[0], tier: entry[1] });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[gear-tiers] Could not read', file, err.message);
  }
  return _table.size;
}

function setTable(entries) {
  _table = new Map();
  for (const [desc, entry] of Object.entries(entries)) _table.set(normalizeDesc(desc), entry);
}

/** @returns {{skill: string, tier: number}|null} tier is an index into TIER_KEYS */
function lookup(desc) {
  if (!_table) load();
  return _table.get(normalizeDesc(desc)) || null;
}

/**
 * Can a character with these skill levels use the item?
 * @param {{skill: string, tier: number}} entry
 * @param {(skill: string) => number} levelOf effective level, 0 when the skill is not owned
 * @param {(level: number) => number} tierIndexOfLevel core/skills.js tierIndex
 */
function canUse(entry, levelOf, tierIndexOfLevel) {
  if (!entry) return { ok: true };
  const level = Number(levelOf(entry.skill)) || 0;
  if (level <= 0) return { ok: false, skill: entry.skill, required: TIER_NAMES[entry.tier], have: null };
  const have = tierIndexOfLevel(level);
  return { ok: have >= entry.tier, skill: entry.skill, required: TIER_NAMES[entry.tier], have: TIER_NAMES[have] };
}

module.exports = {
  TIER_KEYS,
  TIER_NAMES,
  MATERIAL_RULES,
  INGREDIENT_RULES,
  WEAPON_SKILL_BY_ANIM,
  CRAFT_SKILLS,
  tierPerk,
  tierPerksFor,
  allTierPerks,
  DATA_FILE,
  tierIndexOf,
  classify,
  smeltTier,
  armorSkill,
  normalizeDesc,
  load,
  setTable,
  lookup,
  canUse
};
