#!/usr/bin/env node
/**
 * Builds Oathbound_Armor.esp (light plugin): the material tier perks, every
 * forge/smelter/tanning/tempering recipe in the load order gated by the
 * crafter's profession tier, a recipe for every playable armor piece of the
 * hosted mods that had none, and Eastmarch names for Stormcloak gear. Also
 * writes skymp/gamemode/data/gear-tiers.json for the server's equip gate.
 *
 * SkyMP crafts from COBJ records server-side (CraftService) and treats
 * HasPerk as true there; the client hides a recipe until the tier perk is
 * owned, and skills-service.js grants the tier perks from skill levels.
 *
 * How each recipe is chosen, in order:
 *   1. sibling: another armor with the same name (colour suffix " - X"
 *      dropped), weight class and slot already has a forge/tanning recipe in
 *      some plugin -> same inputs, bench and perk conditions (e.g. every
 *      painted Immersive Armors shield copies the plain one);
 *   2. vanilla: the vanilla forge recipe of the same material keyword, slot
 *      and weight class, closest in armor rating; else the same slot and
 *      weight class at the closest armor rating (comparable tier);
 *   3. design: cloth at the tanning rack (linen wrap, leather, leather
 *      strips), cloaks like Cloaks of Skyrim's own recipes, jewelry at the
 *      forge with a gold ingot and the gem it is named after.
 *
 * Skipped (never crafted): non-playable records, race/NPC skins, enchanted
 * template variants (TNAM) and other enchanted copies or uniques (craft the
 * plain piece and enchant it), unnamed records, test items, worn "Aged"
 * loot copies of vanilla pieces, child clothing, and quest/rank outfits.
 *
 * Usage: node tools/crafting/build-armor-recipes.js [--no-install]
 *   writes tools/crafting/dist/Oathbound_Armor.esp,
 *   tools/crafting/armor-recipes-report.md, and copies the plugin into
 *   skymp/client-mods unless --no-install.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scan, VANILLA, CLIENT_MODS } = require('./scan');

const PLUGIN = 'Oathbound_Armor.esp';
const GEAR_FILE = path.join(__dirname, '..', '..', 'skymp', 'gamemode', 'data', 'gear-tiers.json');
const gearTiers = require('../../skymp/gamemode/core/gear-tiers');
const GATED_BENCHES = new Set(['CraftingSmithingForge', 'CraftingSmithingSkyforge', 'DLC1CraftingDawnguard', 'DLC1LD_CraftingForgeAetherium',
  'CraftingTanningRack', 'CraftingSmelter', 'CraftingSmithingArmorTable', 'CraftingSmithingSharpeningWheel', 'CoSWheelCrafting']);
const DIST = path.join(__dirname, 'dist');
const REPORT = path.join(__dirname, 'armor-recipes-report.md');
const FIRST_LOCAL_ID = 0x800;
const LAST_LOCAL_ID = 0xfff;
const FORM_VERSION = 44;
const FLAG_LIGHT = 0x200;

const FN_HAS_PERK = 448;
const TEMPER_BENCHES = new Set(['CraftingSmithingArmorTable', 'CraftingSmithingSharpeningWheel']);
/** Benches that exist as furniture in the world; mod-only benches are not reused. */
const KNOWN_BENCHES = new Set(['CraftingSmithingForge', 'CraftingTanningRack', 'CraftingSmithingSkyforge', 'DLC1CraftingDawnguard']);
const VANILLA_MASTERS = ['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'];

/** Quest, rank and joke outfits: no recipe in vanilla either. */
const QUEST_ITEMS = [
  /^CWIMGBootsArchmage$/, /^CWIArchmagesGloves$/, /^ClothesCWIMGRobesArchMageHood$/,
  /^MAG_Emperors/, /HeldJournal/i
];

// ── Classification ──────────────────────────────────────────────────────────

function has(a, ...edids) { return edids.some((e) => a.kwEdids.includes(e)); }

/** Worn over the armor: slot 46, or named like one (but "Stormcloak" is a faction). */
function isCloak(a) {
  return (a.slots & 0x10000) !== 0 || /\bcloak\b|\bcape\b|mantle|shroud|tribal wrap/i.test(a.name || '');
}

const MATERIAL_KW = /ArmorMateri[ae]l/;
/** Colour suffixes that make a variant of the same piece ("Bandana - Black"). */
const COLOUR = /^(black|blue|green|red|white|yellow|magenta|brown|grey|gray|orange|purple|pink|crimson)$/i;

function slotClass(a) {
  if (has(a, 'ClothingPouch')) return 'pouch';
  if (has(a, 'ArmorShield') || (a.slots & 0x200)) return 'shield';
  if (has(a, 'ArmorJewelry')) {
    if (has(a, 'ClothingRing') || (a.slots & 0x40)) return 'ring';
    if (has(a, 'ClothingCirclet') || (a.slots & 0x1000)) return 'circlet';
    return 'necklace';
  }
  if (has(a, 'ArmorCuirass', 'ClothingBody')) return 'body';
  if (has(a, 'ArmorHelmet', 'ClothingHead', 'ClothingCirclet')) return 'head';
  if (has(a, 'ArmorGauntlets', 'ClothingHands')) return 'hands';
  if (has(a, 'ArmorBoots', 'ClothingFeet')) return 'feet';
  if (isCloak(a)) return 'cloak';
  if (a.slots & 0x4) return 'body';
  if (a.slots & 0x1003) return 'head';
  if (a.slots & 0x8) return 'hands';
  if (a.slots & 0x80) return 'feet';
  if (has(a, 'ClothingNecklace') || (a.slots & 0x20)) return 'necklace';
  return 'other';
}

function skipReason(a, skins) {
  if (a.recFlags & 0x4 || a.bodyFlags & 0x10) return 'non-playable';
  if (skins.has(a.key)) return 'race/NPC skin';
  if (a.template) return 'enchanted or leveled variant of another armor (TNAM)';
  if (!a.name) return 'no name (not an inventory item)';
  if (/\btest\b|TEMP/i.test(`${a.edid} ${a.name}`)) return 'test item';
  if (QUEST_ITEMS.some((re) => re.test(a.edid))) return 'quest or rank outfit';
  if (/child/i.test(a.edid)) return 'child clothing';
  if (a.enchanted && !has(a, 'ClothingPouch')) return 'enchanted (unique, or an enchanted copy of a plain piece)';
  if (/^Aged /.test(a.name)) return 'worn "Aged" loot copy of a vanilla piece that has a recipe';
  return null;
}

/** Name with a colour suffix dropped; other suffixes ("Cloak - Riften Linen") are different pieces. */
function normName(n) {
  const m = /^(.*?)\s+-\s+(\S+)$/.exec(n);
  return (m && COLOUR.test(m[2]) ? m[1] : n).toLowerCase().trim();
}

const NAME_MATERIALS = [
  [/leather/i, 'ArmorMaterialLeather'], [/\b(hide|fur)\b/i, 'ArmorMaterialHide'],
  [/\bsteel\b/i, 'ArmorMaterialSteel'], [/\biron\b/i, 'ArmorMaterialIron']
];

/** Vanilla pieces a tier fallback may copy: common forge materials, no dragon/daedric/Creation Club. */
const TIER_TEMPLATES = /^Armor(Hide|Leather|Studded|Elven|Scaled|Glass|Iron|IronBanded|Steel|SteelPlate|Dwarven|Orcish|Ebony)(Cuirass|Helmet|Gauntlets|Boots|Shield)$/;

// ── Recipe sources ──────────────────────────────────────────────────────────

function main() {
  const install = !process.argv.includes('--no-install');
  const s = scan({ exclude: [PLUGIN, 'Oathbound_Armor.esp'] });
  const kw = (k) => s.keywords.get(k) || '';
  const vanillaMisc = (edid) => {
    const k = s.misc.get(edid);
    if (!k || !VANILLA_MASTERS.includes(k.split('|')[0])) throw new Error(`vanilla item ${edid} not found`);
    return k;
  };
  const vanillaKw = (edid) => {
    const k = s.kwByEdid.get(edid);
    if (!k) throw new Error(`keyword ${edid} not found`);
    return k;
  };
  const M = {
    linen: vanillaMisc('RuinsLinenPile01'),
    leather: vanillaMisc('Leather01'),
    strips: vanillaMisc('LeatherStrips'),
    iron: vanillaMisc('IngotIron'),
    gold: vanillaMisc('IngotGold'),
    silver: vanillaMisc('ingotSilver'),
    dwarven: vanillaMisc('IngotDwarven')
  };
  const GEMS = { ruby: 'GemRuby', sapphire: 'GemSapphire', emerald: 'GemEmerald', diamond: 'GemDiamond', garnet: 'GemGarnet', amethyst: 'GemAmethyst' };
  const FORGE = vanillaKw('CraftingSmithingForge');
  const TANNING = vanillaKw('CraftingTanningRack');

  // Outputs that already have a (non-temper) recipe somewhere.
  const making = s.cobjs.filter((c) => c.bench && !TEMPER_BENCHES.has(kw(c.bench)));
  const crafted = new Map();
  for (const c of making) if (!crafted.has(c.out)) crafted.set(c.out, c);

  // Sibling index: normalized name + type + slot -> recipe (only benches that exist in the world).
  const siblings = new Map();
  for (const c of making) {
    const a = s.armors.get(c.out);
    if (!a || !a.name || !KNOWN_BENCHES.has(kw(c.bench))) continue;
    const id = `${normName(a.name)}|${a.armorType}|${slotClass(a)}`;
    const list = siblings.get(id) || [];
    list.push({ cobj: c, armor: a });
    siblings.set(id, list);
  }

  // Vanilla forge recipes for vanilla armor, by material keyword and by type/slot.
  const vanillaByMat = new Map();
  const vanillaByType = new Map();
  for (const c of making) {
    if (kw(c.bench) !== 'CraftingSmithingForge') continue;
    const a = s.armors.get(c.out);
    if (!a || !VANILLA.has(a.origin) || !VANILLA.has(c.key.split('|')[0]) || a.armorType === 2) continue;
    const sc = slotClass(a);
    const entry = { cobj: c, armor: a };
    const t = `${a.armorType}|${sc}`;
    if (TIER_TEMPLATES.test(a.edid)) (vanillaByType.get(t) || vanillaByType.set(t, []).get(t)).push(entry);
    for (const k of a.kwEdids) {
      if (!MATERIAL_KW.test(k)) continue;
      const id = `${k}|${a.armorType}|${sc}`;
      (vanillaByMat.get(id) || vanillaByMat.set(id, []).get(id)).push(entry);
    }
  }
  const closest = (list, rating) => list.slice().sort((x, y) => Math.abs(x.armor.rating - rating) - Math.abs(y.armor.rating - rating))[0];

  const perkConds = (c) => c.conds.filter((x) => x.fn === FN_HAS_PERK && !x.useGlobal);

  function designRecipe(a, sc) {
    const text = `${a.name} ${a.edid}`;
    const gem = Object.keys(GEMS).find((g) => new RegExp(g, 'i').test(text));
    const items = [];
    const add = (item, count) => items.push({ item, count });
    if (sc === 'ring' || sc === 'necklace' && has(a, 'ArmorJewelry') || sc === 'circlet') {
      add(/gold/i.test(a.name) ? M.gold : /silver/i.test(a.name) ? M.silver : /dwemer|dwarven|siege|boiler/i.test(text) ? M.dwarven : M.gold, 1);
      if (gem) add(vanillaMisc(GEMS[gem]), 1);
      return { bench: FORGE, items, conds: [], how: 'design: jewelry at the forge' };
    }
    const fur = /hide|fur|pelt|blanket|bear|wolf|leather/i.test(text) && !/linen/i.test(text) || has(a, 'ArmorMaterialHide') && !/linen/i.test(text);
    if (sc === 'cloak') {
      if (/collar|scarf/i.test(text)) {
        add(fur ? M.leather : M.linen, 1); add(M.strips, 1);
        return { bench: TANNING, items, conds: [], how: 'design: collar at the tanning rack' };
      }
      if (fur) { add(M.leather, 4); add(M.strips, 2); }
      else { add(M.linen, 3); add(M.strips, 1); }
      if (/gold/i.test(text)) add(M.gold, 1);
      else if (/silver/i.test(text)) add(M.silver, 1);
      return { bench: TANNING, items, conds: [], how: `design: ${fur ? 'hide' : 'cloth'} cloak at the tanning rack` };
    }
    if (sc === 'pouch') { add(M.leather, 1); add(M.strips, 2); return { bench: TANNING, items, conds: [], how: 'design: leather pouch at the tanning rack' }; }
    const rich = has(a, 'ClothingRich') || /noble|jarl|fine|ornate|embroidered|embellished/i.test(text);
    switch (sc) {
      case 'body': add(M.linen, rich ? 4 : 3); add(M.strips, 1); break;
      case 'feet': add(M.leather, 1); add(M.strips, 1); break;
      case 'head':
      case 'hands':
      case 'necklace':
      default:
        add(fur ? M.leather : M.linen, 1); add(M.strips, 1);
    }
    if (rich) add(M.gold, 1);
    return { bench: TANNING, items, conds: [], how: `design: ${rich ? 'fine ' : ''}clothing at the tanning rack` };
  }

  function chooseRecipe(a) {
    const sc = slotClass(a);
    const sib = siblings.get(`${normName(a.name)}|${a.armorType}|${sc}`);
    if (sib && sib.length) {
      const pick = sib.find((x) => x.armor.origin === a.origin) || sib[0];
      return { bench: pick.cobj.bench, items: pick.cobj.items, conds: perkConds(pick.cobj), count: pick.cobj.count, how: `sibling: ${pick.armor.name} (${pick.cobj.plugin})` };
    }
    if (a.armorType === 0 || a.armorType === 1) {
      for (const k of a.kwEdids) {
        if (!MATERIAL_KW.test(k)) continue;
        const list = vanillaByMat.get(`${k}|${a.armorType}|${sc}`);
        if (list) {
          const v = closest(list, a.rating);
          return { bench: v.cobj.bench, items: v.cobj.items, conds: perkConds(v.cobj), how: `vanilla material: ${v.armor.edid}` };
        }
      }
      // No material keyword with a vanilla recipe: the name often says it ("Corsair Leather Boots").
      const hint = NAME_MATERIALS.find(([re]) => re.test(a.name));
      const hinted = hint && vanillaByMat.get(`${hint[1]}|${a.armorType}|${sc}`);
      if (hinted) {
        const v = closest(hinted, a.rating);
        return { bench: v.cobj.bench, items: v.cobj.items, conds: perkConds(v.cobj), how: `vanilla material (from the name): ${v.armor.edid}` };
      }
      const list = vanillaByType.get(`${a.armorType}|${sc}`);
      if (list) {
        const v = closest(list, a.rating);
        return { bench: v.cobj.bench, items: v.cobj.items, conds: perkConds(v.cobj), how: `vanilla tier: ${v.armor.edid} (rating ${v.armor.rating} vs ${a.rating})` };
      }
    }
    return designRecipe(a, sc);
  }

  // ── Walk the mod armors ───────────────────────────────────────────────────
  const perMod = new Map();
  const added = [];
  const skipped = [];
  for (const a of s.armors.values()) {
    if (VANILLA.has(a.origin)) continue;
    const m = perMod.get(a.origin) || { plugin: a.origin, total: 0, had: 0, added: 0, skipped: 0, reasons: {} };
    perMod.set(a.origin, m);
    m.total++;
    if (crafted.has(a.key)) { m.had++; continue; }
    const why = skipReason(a, s.skins);
    if (why) {
      m.skipped++; m.reasons[why] = (m.reasons[why] || 0) + 1;
      skipped.push({ a, why });
      continue;
    }
    const r = chooseRecipe(a);
    m.added++;
    added.push({ a, r });
  }

  // ── Tiers ─────────────────────────────────────────────────────────────────
  const edidOfKey = new Map([...s.misc].map(([e, k]) => [k, e]));
  const recipeOf = new Map();
  for (const c of making) if (!recipeOf.has(c.out)) recipeOf.set(c.out, c.items);
  for (const { a, r } of added) recipeOf.set(a.key, r.items);
  const ingredientsOf = (key) => (recipeOf.get(key) || []).map((i) => edidOfKey.get(i.item)).filter(Boolean);

  const vanillaArmorTiers = [];
  for (const a of s.armors.values()) {
    if (!VANILLA.has(a.origin) || a.armorType > 1 || !TIER_TEMPLATES.test(a.edid)) continue;
    const t = gearTiers.classify({ keywords: a.kwEdids, name: a.name, edid: a.edid });
    if (t.tier) vanillaArmorTiers.push({ armorType: a.armorType, slot: slotClass(a), rating: a.rating, tier: t.tier });
  }
  const vanillaWeaponTiers = [];
  for (const w of s.weapons.values()) {
    if (!VANILLA.has(w.origin) || w.template || !/^(Iron|Steel|Elven|Dwarven|Orcish|Glass|Ebony|Daedric)/.test(w.edid)) continue;
    const t = gearTiers.classify({ keywords: w.kwEdids, name: w.name, edid: w.edid });
    if (t.tier) vanillaWeaponTiers.push({ anim: w.anim, damage: w.damage, tier: t.tier });
  }
  const nearest = (list, value) => list.slice().sort((x, y) => Math.abs(x.value - value) - Math.abs(y.value - value))[0];

  const tierOf = new Map();
  const tierCounts = {};
  function armorTier(a) {
    if (tierOf.has(a.key)) return tierOf.get(a.key);
    tierOf.set(a.key, 'novice');
    let t = gearTiers.classify({ keywords: a.kwEdids, name: a.name, edid: a.edid, ingredients: ingredientsOf(a.key) });
    if (!t.tier && a.template && s.armors.has(a.template)) t = { tier: armorTier(s.armors.get(a.template)), by: 'template' };
    if (!t.tier && a.armorType <= 1) {
      const list = vanillaArmorTiers.filter((v) => v.armorType === a.armorType && v.slot === slotClass(a)).map((v) => ({ ...v, value: v.rating }));
      const v = list.length ? nearest(list, a.rating) : null;
      if (v) t = { tier: v.tier, by: 'rating' };
    }
    if (!t.tier) t = { tier: 'novice', by: 'default' };
    tierCounts[t.by] = (tierCounts[t.by] || 0) + 1;
    tierOf.set(a.key, t.tier);
    return t.tier;
  }
  function weaponTier(w) {
    if (tierOf.has(w.key)) return tierOf.get(w.key);
    tierOf.set(w.key, 'novice');
    let t = gearTiers.classify({ keywords: w.kwEdids, name: w.name, edid: w.edid, ingredients: ingredientsOf(w.key) });
    if (!t.tier && w.template && s.weapons.has(w.template)) t = { tier: weaponTier(s.weapons.get(w.template)), by: 'template' };
    if (!t.tier) {
      const list = vanillaWeaponTiers.filter((v) => v.anim === w.anim).map((v) => ({ ...v, value: v.damage }));
      const v = list.length ? nearest(list, w.damage) : null;
      if (v) t = { tier: v.tier, by: 'rating' };
    }
    if (!t.tier) t = { tier: 'novice', by: 'default' };
    tierCounts[t.by] = (tierCounts[t.by] || 0) + 1;
    tierOf.set(w.key, t.tier);
    return t.tier;
  }

  // Equip gate data for the server.
  const gear = {};
  const descOfKey = (key) => {
    const [owner, local] = key.split('|');
    const plugin = s.order.find((n) => n.toLowerCase() === owner) || owner;
    return `${local}:${plugin}`;
  };
  for (const a of s.armors.values()) {
    const skill = gearTiers.armorSkill(a.armorType);
    if (!skill || a.recFlags & 0x4 || s.skins.has(a.key) || has(a, 'ArmorJewelry')) continue;
    gear[descOfKey(a.key)] = [skill, gearTiers.tierIndexOf(armorTier(a))];
  }
  for (const w of s.weapons.values()) {
    const skill = gearTiers.WEAPON_SKILL_BY_ANIM[w.anim];
    if (!skill || w.recFlags & 0x4) continue;
    gear[descOfKey(w.key)] = [skill, gearTiers.tierIndexOf(weaponTier(w))];
  }

  // ── Which recipes are gated, and by what ──────────────────────────────────
  const SMITHING_PERKS = new Set(Object.keys(PERK_NAMES).filter((k) => k !== 'skyrim.esm|5218e'));
  function gateOf(outKey, benchEdid, items) {
    const a = s.armors.get(outKey);
    if (a) {
      const heavy = a.armorType === 1 || (has(a, 'ArmorJewelry') && benchEdid !== 'CraftingTanningRack' && benchEdid !== 'CoSWheelCrafting');
      return { skill: heavy ? 'metal_worker' : 'outfitter', tier: armorTier(a) };
    }
    const w = s.weapons.get(outKey);
    if (w) return { skill: 'metal_worker', tier: weaponTier(w) };
    const inputs = items.map((i) => edidOfKey.get(i.item)).filter(Boolean);
    if (benchEdid === 'CraftingSmelter') return { skill: 'metal_worker', tier: gearTiers.smeltTier(edidOfKey.get(outKey) || '', inputs) };
    if (benchEdid === 'CraftingTanningRack' || benchEdid === 'CoSWheelCrafting') return { skill: 'outfitter', tier: 'novice' };
    const t = gearTiers.classify({ edid: edidOfKey.get(outKey) || '', ingredients: inputs });
    return { skill: 'metal_worker', tier: t.tier || 'novice' };
  }

  const overrides = s.cobjs.filter((c) => c.bench && GATED_BENCHES.has(kw(c.bench)));

  // ── Masters ───────────────────────────────────────────────────────────────
  const TIER_PERK_IDS = new Map();
  const perkSpecs = [];
  Object.keys(gearTiers.CRAFT_SKILLS).forEach((skill) => gearTiers.TIER_KEYS.forEach((tier) => {
    const edid = gearTiers.tierPerk(skill, tier);
    perkSpecs.push({ edid, local: FIRST_LOCAL_ID + perkSpecs.length, name: `${gearTiers.CRAFT_SKILLS[skill]} ${gearTiers.TIER_NAMES[gearTiers.tierIndexOf(tier)]}` });
    TIER_PERK_IDS.set(`${skill}|${tier}`, edid);
  }));
  const firstRecipeLocal = FIRST_LOCAL_ID + 0x10;

  const renames = [...s.armors.values(), ...s.weapons.values()]
    .filter((x) => x.name && /stormcloak/i.test(x.name) && !x.raw.some((f) => f.type === 'VMAD'));

  const refs = new Set();
  for (const { a, r } of added) { refs.add(a.key); refs.add(r.bench); r.items.forEach((i) => refs.add(i.item)); }
  const keyIn = (mastersOf, self) => {
    const owners = mastersOf.map((m) => m.toLowerCase());
    return (id) => { const hi = id >>> 24; return `${hi < owners.length ? owners[hi] : self.toLowerCase()}|${(id & 0xffffff).toString(16)}`; };
  };
  const FORM_FNS = new Set([47, 59, 71, 72, 74, 182, 359, 448, 543, 560, 629]);
  const isFormParam = (fn, v) => v !== 0 && (FORM_FNS.has(fn) || (v & 0xffffff) >= 0x800);
  for (const c of overrides) {
    const ref = keyIn(c.masters, c.plugin);
    refs.add(c.key);
    for (const f of c.raw) {
      if (f.type === 'CNTO' || f.type === 'CNAM' || f.type === 'BNAM') refs.add(ref(f.data.readUInt32LE(0)));
      if (f.type === 'CTDA') {
        const op = f.data.readUInt8(0); const fn = f.data.readUInt16LE(8);
        if (op & 0x04) refs.add(ref(f.data.readUInt32LE(4)));
        for (const at of [12, 16]) { const v = f.data.readUInt32LE(at); if (isFormParam(fn, v)) refs.add(ref(v)); }
        if (f.data.readUInt32LE(20) === 2) refs.add(ref(f.data.readUInt32LE(24)));
      }
    }
  }
  const ARMO_FORM_FIELDS = new Set(['EITM', 'YNAM', 'ZNAM', 'ETYP', 'BIDS', 'BAMT', 'RNAM', 'MODL', 'TNAM']);
  const WEAP_FORM_FIELDS = new Set(['EITM', 'ETYP', 'BIDS', 'BAMT', 'INAM', 'WNAM', 'SNAM', 'XNAM', 'NAM7', 'TNAM', 'NAM9', 'NAM8', 'UNAM', 'CNAM']);
  const formFieldsOf = (x) => (s.armors.has(x.key) ? ARMO_FORM_FIELDS : WEAP_FORM_FIELDS);
  for (const x of renames) {
    const ref = keyIn(x.masters, x.plugin);
    refs.add(x.key);
    for (const f of x.raw) {
      if (formFieldsOf(x).has(f.type) && f.data.length === 4) refs.add(ref(f.data.readUInt32LE(0)));
      if (f.type === 'KWDA') for (let o = 0; o + 4 <= f.data.length; o += 4) refs.add(ref(f.data.readUInt32LE(o)));
    }
  }
  const selfKey = PLUGIN.toLowerCase();
  const owners = new Set([...refs].map((k) => k.split('|')[0]).filter((o) => o !== selfKey));
  owners.add('skyrim.esm');
  const masters = s.order.filter((n) => owners.has(n.toLowerCase()));
  const missing = [...owners].filter((o) => !masters.some((m) => m.toLowerCase() === o));
  if (missing.length) throw new Error(`forms from plugins outside the load order: ${missing.join(', ')}`);
  if (masters[0].toLowerCase() !== 'skyrim.esm') throw new Error('Skyrim.esm must be the first master');
  const masterIdx = new Map(masters.map((m, i) => [m.toLowerCase(), i]));
  masterIdx.set(selfKey, masters.length);
  const fid = (key) => {
    const [owner, local] = key.split('|');
    if (!masterIdx.has(owner)) throw new Error(`no master for ${key}`);
    return ((masterIdx.get(owner) << 24) | parseInt(local, 16)) >>> 0;
  };
  const selfId = (local) => ((masters.length << 24) | local) >>> 0;
  const tierCtda = (skill, tier) => {
    const perkLocal = perkSpecs.find((p) => p.edid === TIER_PERK_IDS.get(`${skill}|${tier}`)).local;
    const b = Buffer.alloc(32);
    b.writeUInt8(0, 0); b.writeFloatLE(1, 4); b.writeUInt16LE(FN_HAS_PERK, 8);
    b.writeUInt32LE(selfId(perkLocal), 12); b.writeInt32LE(-1, 28);
    return field('CTDA', b);
  };

  // ── Records ───────────────────────────────────────────────────────────────
  const perkRecords = perkSpecs.map((p) => record('PERK', 0, selfId(p.local), [
    field('EDID', zstring(p.edid)), field('FULL', zstring(p.name)), field('DESC', zstring('')), field('DATA', Buffer.from([0, 0, 1, 0, 1]))
  ]));

  const cobjRecords = [];
  const gateCounts = {};
  const countGate = (g) => { const k = `${g.skill} ${g.tier}`; gateCounts[k] = (gateCounts[k] || 0) + 1; };
  for (const c of overrides) {
    const ref = keyIn(c.masters, c.plugin);
    const remap = (v) => fid(ref(v));
    const g = gateOf(c.out, kw(c.bench), c.items);
    countGate(g);
    const outFields = [];
    let inserted = false;
    let skipCis = false;
    for (const f of c.raw) {
      if (f.type === 'CIS1' || f.type === 'CIS2') { if (!skipCis) outFields.push(field(f.type, f.data)); continue; }
      skipCis = false;
      if (f.type === 'COED') continue;
      if (f.type === 'CTDA') {
        if (!inserted) { outFields.push(tierCtda(g.skill, g.tier)); inserted = true; }
        const d = Buffer.from(f.data);
        const op = d.readUInt8(0); const fn = d.readUInt16LE(8);
        if (fn === FN_HAS_PERK && SMITHING_PERKS.has(ref(d.readUInt32LE(12)))) { skipCis = true; continue; }
        if (op & 0x04) d.writeUInt32LE(remap(d.readUInt32LE(4)), 4);
        for (const at of [12, 16]) { const v = d.readUInt32LE(at); if (isFormParam(fn, v)) d.writeUInt32LE(remap(v), at); }
        if (d.readUInt32LE(20) === 2) d.writeUInt32LE(remap(d.readUInt32LE(24)), 24);
        outFields.push(field('CTDA', d));
        continue;
      }
      if (f.type === 'CNAM' && !inserted) { outFields.push(tierCtda(g.skill, g.tier)); inserted = true; }
      if (f.type === 'CNTO') { const d = Buffer.from(f.data); d.writeUInt32LE(remap(d.readUInt32LE(0)), 0); outFields.push(field('CNTO', d)); continue; }
      if (f.type === 'CNAM' || f.type === 'BNAM') { outFields.push(field(f.type, u32(remap(f.data.readUInt32LE(0))))); continue; }
      outFields.push(field(f.type, f.data));
    }
    if (!inserted) outFields.push(tierCtda(g.skill, g.tier));
    cobjRecords.push(record('COBJ', 0, fid(c.key), outFields));
  }

  if (added.length > LAST_LOCAL_ID - firstRecipeLocal + 1) throw new Error(`${added.length} recipes do not fit a light plugin`);
  const usedEdids = new Set();
  added.sort((x, y) => (x.a.origin + x.a.edid).localeCompare(y.a.origin + y.a.edid));
  added.forEach(({ a, r }, i) => {
    const formId = selfId(firstRecipeLocal + i);
    let edid = `OBRecipe_${a.edid.replace(/[^A-Za-z0-9_]/g, '')}`;
    while (usedEdids.has(edid)) edid += '_';
    usedEdids.add(edid);
    r.edid = edid;
    r.formId = formId;
    const g = gateOf(a.key, kw(r.bench), r.items);
    r.gate = g;
    countGate(g);
    const fields = [field('EDID', zstring(edid)), field('COCT', u32(r.items.length))];
    for (const it of r.items) {
      const b = Buffer.alloc(8); b.writeUInt32LE(fid(it.item), 0); b.writeInt32LE(it.count, 4);
      fields.push(field('CNTO', b));
    }
    fields.push(tierCtda(g.skill, g.tier));
    fields.push(field('CNAM', u32(fid(a.key))));
    fields.push(field('BNAM', u32(fid(r.bench))));
    const n1 = Buffer.alloc(2); n1.writeUInt16LE(r.count || 1, 0);
    fields.push(field('NAM1', n1));
    cobjRecords.push(record('COBJ', 0, formId, fields));
  });

  const armoRecords = [];
  const weapRecords = [];
  for (const x of renames) {
    const ref = keyIn(x.masters, x.plugin);
    const ff = formFieldsOf(x);
    const isArmor = s.armors.has(x.key);
    const outFields = [];
    for (const f of x.raw) {
      if (f.type === 'FULL') { outFields.push(field('FULL', zstring(x.name.replace(/Stormcloak/g, 'Eastmarch').replace(/STORMCLOAK/g, 'EASTMARCH').replace(/stormcloak/g, 'eastmarch')))); continue; }
      if (f.type === 'DESC') continue;
      if (ff.has(f.type) && f.data.length === 4) { outFields.push(field(f.type, u32(fid(ref(f.data.readUInt32LE(0)))))); continue; }
      if (f.type === 'KWDA') { const d = Buffer.from(f.data); for (let o = 0; o + 4 <= d.length; o += 4) d.writeUInt32LE(fid(ref(d.readUInt32LE(o))), o); outFields.push(field('KWDA', d)); continue; }
      outFields.push(field(f.type, f.data));
    }
    (isArmor ? armoRecords : weapRecords).push(record(isArmor ? 'ARMO' : 'WEAP', x.recFlags & ~0x40000, fid(x.key), outFields));
  }

  const total = perkRecords.length + cobjRecords.length + armoRecords.length + weapRecords.length;
  const hedr = Buffer.alloc(12);
  hedr.writeFloatLE(1.71, 0);
  hedr.writeUInt32LE(total, 4);
  hedr.writeUInt32LE(firstRecipeLocal + added.length, 8);
  const head = [field('HEDR', hedr), field('CNAM', zstring('OATHBOUND')),
    field('SNAM', zstring('OATHBOUND armor and weapon tiers, crafting recipes and Eastmarch names.'))];
  for (const m of masters) { head.push(field('MAST', zstring(m))); head.push(field('DATA', Buffer.alloc(8))); }
  const tes4 = record('TES4', FLAG_LIGHT, 0, head);
  const groups = [group('PERK', perkRecords), group('COBJ', cobjRecords)];
  if (armoRecords.length) groups.push(group('ARMO', armoRecords));
  if (weapRecords.length) groups.push(group('WEAP', weapRecords));
  const out = Buffer.concat([tes4, ...groups]);

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, PLUGIN), out);
  if (install) fs.copyFileSync(path.join(DIST, PLUGIN), path.join(CLIENT_MODS, PLUGIN));
  fs.writeFileSync(GEAR_FILE, `${JSON.stringify({ generatedBy: 'tools/crafting/build-armor-recipes.js', items: gear })}\n`);

  writeReport({ perMod, added, skipped, masters, kw, s, size: out.length });
  console.log(`[armor-recipes] ${perkRecords.length} tier perks, ${overrides.length} recipe overrides, ${added.length} new recipes, ${armoRecords.length + weapRecords.length} renames, ${masters.length} masters, ${out.length} bytes -> ${path.join(DIST, PLUGIN)}${install ? ' (+ client-mods)' : ''}`);
  console.log(`[armor-recipes] ${Object.keys(gear).length} gear tiers -> ${GEAR_FILE}`, tierCounts);
  console.log('[armor-recipes] recipes by gate:', gateCounts);
}

function writeReport({ perMod, added, skipped, masters, kw, s, size }) {
  const nameOf = (k) => { const a = s.armors.get(k); if (a) return a.name || a.edid; for (const [e, key] of s.misc) if (key === k) return e; return k.replace('|', ':'); };
  const lines = [];
  lines.push('# Armor recipes (generated)', '');
  lines.push(`Generated by \`tools/crafting/build-armor-recipes.js\` into \`Oathbound_Armor.esp\` (${added.length} COBJ records, ${size} bytes, light plugin, ${masters.length} masters). Re-run it after changing the hosted armor mods.`, '');
  lines.push('| Plugin | Armors | Had a recipe | Added | Skipped |', '|---|---:|---:|---:|---:|');
  const tot = { total: 0, had: 0, added: 0, skipped: 0 };
  for (const m of perMod.values()) {
    lines.push(`| ${m.plugin} | ${m.total} | ${m.had} | ${m.added} | ${m.skipped} |`);
    for (const k of Object.keys(tot)) tot[k] += m[k];
  }
  lines.push(`| **Total** | ${tot.total} | ${tot.had} | ${tot.added} | ${tot.skipped} |`, '');
  lines.push('## Why pieces were skipped', '');
  for (const m of perMod.values()) {
    const r = Object.entries(m.reasons);
    if (!r.length) continue;
    lines.push(`- **${m.plugin}**: ${r.map(([why, n]) => `${n} ${why}`).join('; ')}`);
  }
  lines.push('', '## Recipes added', '', '| Plugin | Item | Bench | Inputs | Perk | Based on |', '|---|---|---|---|---|---|');
  for (const { a, r } of added) {
    const perks = r.conds.map((c) => nameOfPerk(c.param1, s)).join(', ');
    lines.push(`| ${a.origin} | ${a.name} (\`${a.edid}\`) | ${kw(r.bench)} | ${r.items.map((i) => `${nameOf(i.item)} x${i.count}`).join(', ')} | ${perks} | ${r.how} |`);
  }
  lines.push('', '## Skipped pieces', '', '| Plugin | Item | Reason |', '|---|---|---|');
  for (const { a, why } of skipped.sort((x, y) => (x.a.origin + x.why).localeCompare(y.a.origin + y.why))) {
    lines.push(`| ${a.origin} | ${a.name || '(no name)'} (\`${a.edid}\`) | ${why} |`);
  }
  fs.writeFileSync(REPORT, `${lines.join('\n')}\n`);
}

const PERK_NAMES = { 'skyrim.esm|cb40d': 'Steel Smithing', 'skyrim.esm|cb40e': 'Dwarven Smithing', 'skyrim.esm|cb40f': 'Elven Smithing',
  'skyrim.esm|cb410': 'Orcish Smithing', 'skyrim.esm|cb411': 'Glass Smithing', 'skyrim.esm|cb412': 'Ebony Smithing',
  'skyrim.esm|cb413': 'Daedric Smithing', 'skyrim.esm|cb414': 'Advanced Armors', 'skyrim.esm|52190': 'Dragon Armor', 'skyrim.esm|5218e': 'Arcane Blacksmith' };
function nameOfPerk(k) { return PERK_NAMES[k] || k.replace('|', ':'); }

// ── Binary helpers ──────────────────────────────────────────────────────────

function zstring(str) { return Buffer.concat([Buffer.from(str, 'latin1'), Buffer.from([0])]); }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }
function field(type, data) {
  const h = Buffer.alloc(6); h.write(type, 0, 'latin1'); h.writeUInt16LE(data.length, 4);
  return Buffer.concat([h, data]);
}
function record(type, flags, formId, fields) {
  const data = Buffer.concat(fields);
  const h = Buffer.alloc(24);
  h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); h.writeUInt32LE(flags, 8);
  h.writeUInt32LE(formId >>> 0, 12); h.writeUInt16LE(FORM_VERSION, 20);
  return Buffer.concat([h, data]);
}
function group(label, recs) {
  const data = Buffer.concat(recs);
  const h = Buffer.alloc(24);
  h.write('GRUP', 0, 'latin1'); h.writeUInt32LE(24 + data.length, 4); h.write(label, 8, 'latin1');
  return Buffer.concat([h, data]);
}
/** CTDA with the comparison and function kept; perk form remapped to this plugin's masters. */
function ctda(c, fid) {
  const b = Buffer.alloc(32);
  b.writeUInt8(c.op & ~0x04, 0);
  b.writeFloatLE(typeof c.comp === 'number' ? c.comp : 1, 4);
  b.writeUInt16LE(c.fn, 8);
  b.writeUInt32LE(typeof c.param1 === 'string' ? fid(c.param1) : c.param1, 12);
  b.writeUInt32LE(c.param2, 16);
  b.writeUInt32LE(c.runOn, 20);
  b.writeUInt32LE(0, 24);
  b.writeInt32LE(-1, 28);
  return b;
}

main();
