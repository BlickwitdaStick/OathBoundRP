#!/usr/bin/env node
/**
 * Builds OathboundArmorRecipes.esp: a light (ESL-flagged) plugin of COBJ
 * records so every playable armor, clothing, cloak and bag piece added by our
 * hosted mods can be made at a forge or tanning rack.
 *
 * Why a plugin: SkyMP crafts from COBJ records server-side
 * (skymp5-server CraftService: the client sends the inputs, the server finds
 * the matching COBJ in the loaded plugins, removes the inputs and adds the
 * output). The client shows the same records in the vanilla crafting menu, so
 * one plugin covers both sides. Condition functions the server does not
 * implement (HasPerk) evaluate to true there; the client still hides the
 * recipe until the perk is owned, and skills-service re-applies tree perks at
 * every login, so the vanilla smithing perks are the skill gate.
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
 *   writes tools/crafting/dist/OathboundArmorRecipes.esp,
 *   tools/crafting/armor-recipes-report.md, and copies the plugin into
 *   skymp/client-mods unless --no-install.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scan, VANILLA, CLIENT_MODS } = require('./scan');

const PLUGIN = 'OathboundArmorRecipes.esp';
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
  const s = scan({ exclude: [PLUGIN] });
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

  // ── Write the plugin ──────────────────────────────────────────────────────
  if (added.length > LAST_LOCAL_ID - FIRST_LOCAL_ID + 1) throw new Error(`${added.length} recipes do not fit a light plugin`);
  const refs = new Set();
  for (const { a, r } of added) {
    refs.add(a.key); refs.add(r.bench);
    r.items.forEach((i) => refs.add(i.item));
    r.conds.forEach((c) => refs.add(c.param1));
  }
  const owners = new Set([...refs].map((k) => k.split('|')[0]));
  const masters = s.order.filter((n) => owners.has(n.toLowerCase()));
  const missing = [...owners].filter((o) => !masters.some((m) => m.toLowerCase() === o));
  if (missing.length) throw new Error(`forms from plugins outside the load order: ${missing.join(', ')}`);
  const masterIdx = new Map(masters.map((m, i) => [m.toLowerCase(), i]));
  const fid = (key) => {
    const [owner, local] = key.split('|');
    return ((masterIdx.get(owner) << 24) | parseInt(local, 16)) >>> 0;
  };

  const records = [];
  const usedEdids = new Set();
  added.sort((x, y) => (x.a.origin + x.a.edid).localeCompare(y.a.origin + y.a.edid));
  added.forEach(({ a, r }, i) => {
    const formId = ((masters.length << 24) | (FIRST_LOCAL_ID + i)) >>> 0;
    let edid = `OBRecipe_${a.edid.replace(/[^A-Za-z0-9_]/g, '')}`;
    while (usedEdids.has(edid)) edid += '_';
    usedEdids.add(edid);
    r.edid = edid;
    r.formId = formId;
    const fields = [field('EDID', zstring(edid)), field('COCT', u32(r.items.length))];
    for (const it of r.items) {
      const b = Buffer.alloc(8); b.writeUInt32LE(fid(it.item), 0); b.writeInt32LE(it.count, 4);
      fields.push(field('CNTO', b));
    }
    for (const c of r.conds) fields.push(field('CTDA', ctda(c, fid)));
    fields.push(field('CNAM', u32(fid(a.key))));
    fields.push(field('BNAM', u32(fid(r.bench))));
    const n1 = Buffer.alloc(2); n1.writeUInt16LE(r.count || 1, 0);
    fields.push(field('NAM1', n1));
    records.push(record('COBJ', 0, formId, fields));
  });

  const hedr = Buffer.alloc(12);
  hedr.writeFloatLE(1.71, 0);
  hedr.writeUInt32LE(records.length, 4);
  hedr.writeUInt32LE(FIRST_LOCAL_ID + records.length, 8);
  const head = [field('HEDR', hedr), field('CNAM', zstring('OATHBOUND')),
    field('SNAM', zstring('Crafting recipes for the armor and clothing of the OATHBOUND hosted mods. Generated by tools/crafting/build-armor-recipes.js.'))];
  for (const m of masters) { head.push(field('MAST', zstring(m))); head.push(field('DATA', Buffer.alloc(8))); }
  const tes4 = record('TES4', FLAG_LIGHT, 0, head);
  const out = Buffer.concat([tes4, group('COBJ', records)]);

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, PLUGIN), out);
  if (install) fs.copyFileSync(path.join(DIST, PLUGIN), path.join(CLIENT_MODS, PLUGIN));

  writeReport({ perMod, added, skipped, masters, kw, s, size: out.length });
  console.log(`[armor-recipes] ${records.length} recipes, ${masters.length} masters, ${out.length} bytes -> ${path.join(DIST, PLUGIN)}${install ? ' (+ client-mods)' : ''}`);
  for (const m of perMod.values()) console.log(`  ${m.plugin}: ${m.total} armors, ${m.had} had recipes, ${m.added} added, ${m.skipped} skipped`);
}

function writeReport({ perMod, added, skipped, masters, kw, s, size }) {
  const nameOf = (k) => { const a = s.armors.get(k); if (a) return a.name || a.edid; for (const [e, key] of s.misc) if (key === k) return e; return k.replace('|', ':'); };
  const lines = [];
  lines.push('# Armor recipes (generated)', '');
  lines.push(`Generated by \`tools/crafting/build-armor-recipes.js\` into \`OathboundArmorRecipes.esp\` (${added.length} COBJ records, ${size} bytes, light plugin, ${masters.length} masters). Re-run it after changing the hosted armor mods.`, '');
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
