/**
 * core/skill-trees.js — Skill tree nodes (domain layer, pure)
 *
 * Every skill has a tree split into paths that can be mixed and matched.
 * A node costs 1 skill point (core/skills.js: 1 point per 5 levels), needs a
 * minimum skill level, and may require earlier nodes. Reaching Master (80)
 * owns the whole tree. Legendary adds a staff-awarded bonus, not a node.
 *
 * Two kinds of node:
 *   - `perk`: a vanilla Skyrim.esm PERK, by editor id. SkyMP does not save
 *             perks, so the server stores the node and re-applies the perk on
 *             the player's client at every login (skills-service.js).
 *   - `unlock`: an OATHBOUND server unlock, read by gameplay code through
 *             skills-service `hasUnlock()`. Nodes whose gameplay is not built
 *             yet say so in `effect` — they are still bought and saved.
 */

'use strict';

const { getSkill, LEGENDARY_LEVEL } = require('./skills');

const NODE_COST = 1;

/** Short builders keep the catalog readable. */
function perk(code, name, path, minLevel, editorId, requires = [], effect = null) {
  return Object.freeze({ code, name, path, minLevel, requires: Object.freeze(requires), perk: editorId, unlock: null, effect, cost: NODE_COST });
}
function unlock(code, name, path, minLevel, effect, requires = []) {
  return Object.freeze({ code, name, path, minLevel, requires: Object.freeze(requires), perk: null, unlock: code, effect, cost: NODE_COST });
}

/** A five-rank vanilla line (e.g. Armsman00..Armsman80) on the tier boundaries. */
function ranks(prefix, name, path, editorPrefix, suffixes = ['00', '20', '40', '60', '80']) {
  const mins = [1, 20, 40, 60, 80];
  return suffixes.map((suffix, i) => perk(
    `${prefix}_${i + 1}`, `${name} ${['I', 'II', 'III', 'IV', 'V'][i]}`, path, mins[i],
    `${editorPrefix}${suffix}`, i === 0 ? [] : [`${prefix}_${i}`]
  ));
}

/** Novice/Apprentice/Adept/Expert/Master cost-reduction line of a school. */
function schoolRanks(school) {
  const S = school[0].toUpperCase() + school.slice(1);
  const steps = [['Novice', 'Novice00', 1], ['Apprentice', 'Apprentice25', 20], ['Adept', 'Adept50', 40], ['Expert', 'Expert75', 60], ['Master', 'Master100', 80]];
  return steps.map(([label, suffix, min], i) => perk(
    `${school}_${label.toLowerCase()}`, `${label} ${S}`, 'Mastery', min, `${S}${suffix}`,
    i === 0 ? [] : [`${school}_${steps[i - 1][0].toLowerCase()}`]
  ));
}

const TREES = Object.freeze({
  // ── Combat ───────────────────────────────────────────────────────────────
  one_handed: [
    ...ranks('armsman', 'Armsman', 'Power', 'Armsman'),
    perk('fighting_stance', 'Fighting Stance', 'Technique', 20, 'FightingStance', ['armsman_1']),
    perk('savage_strike', 'Savage Strike', 'Technique', 40, 'SavageStrike', ['fighting_stance']),
    perk('critical_charge', 'Critical Charge', 'Technique', 40, 'CriticalCharge', ['fighting_stance']),
    perk('paralyzing_strike', 'Paralyzing Strike', 'Technique', 80, 'ParalyzingStrike', ['savage_strike', 'critical_charge']),
    perk('hack_and_slash', 'Hack and Slash', 'Weapons', 20, 'HackAndSlash30', ['armsman_1']),
    perk('bone_breaker', 'Bone Breaker', 'Weapons', 20, 'BoneBreaker30', ['armsman_1']),
    perk('bladesman', 'Bladesman', 'Weapons', 20, 'Bladesman30', ['armsman_1'])
  ],
  two_handed: [
    ...ranks('barbarian', 'Barbarian', 'Power', 'Barbarian'),
    perk('champions_stance', "Champion's Stance", 'Technique', 20, 'ChampionsStance', ['barbarian_1']),
    perk('devastating_blow', 'Devastating Blow', 'Technique', 40, 'DevastatingBlow', ['champions_stance']),
    perk('great_critical_charge', 'Great Critical Charge', 'Technique', 40, 'GreatCriticalCharge', ['champions_stance']),
    perk('sweep', 'Sweep', 'Technique', 60, 'Sweep', ['devastating_blow', 'great_critical_charge']),
    perk('warmaster', 'Warmaster', 'Technique', 80, 'Warmaster', ['sweep']),
    perk('limbsplitter', 'Limbsplitter', 'Weapons', 20, 'Limbsplitter30', ['barbarian_1']),
    perk('deep_wounds', 'Deep Wounds', 'Weapons', 20, 'DeepWounds30', ['barbarian_1']),
    perk('skullcrusher', 'Skullcrusher', 'Weapons', 20, 'Skullcrusher30', ['barbarian_1'])
  ],
  archery: [
    ...ranks('overdraw', 'Overdraw', 'Power', 'Overdraw'),
    perk('eagle_eye', 'Eagle Eye', 'Precision', 20, 'EagleEye30', ['overdraw_1']),
    perk('steady_hand', 'Steady Hand', 'Precision', 40, 'SteadyHand40', ['eagle_eye']),
    perk('power_shot', 'Power Shot', 'Precision', 40, 'PowerShot', ['eagle_eye']),
    perk('bullseye', 'Bullseye', 'Precision', 80, 'Bullseye', ['power_shot']),
    perk('critical_shot', 'Critical Shot', 'Field', 20, 'CriticalShot30', ['overdraw_1']),
    perk('hunters_discipline', "Hunter's Discipline", 'Field', 40, 'HuntersDiscipline', ['critical_shot']),
    perk('ranger', 'Ranger', 'Field', 60, 'Ranger', ['hunters_discipline']),
    perk('quick_shot', 'Quick Shot', 'Field', 60, 'QuickShot', ['ranger'])
  ],
  dual_wielding: [
    perk('dual_flurry_1', 'Dual Flurry I', 'Speed', 20, 'DualFlurry30'),
    perk('dual_flurry_2', 'Dual Flurry II', 'Speed', 40, 'DualFlurry50', ['dual_flurry_1']),
    perk('dual_savagery', 'Dual Savagery', 'Power', 60, 'DualSavagery'),
    unlock('twin_guard', 'Twin Guard', 'Defense', 40, 'Parry with the off-hand weapon (gameplay not built yet).'),
    unlock('whirlwind_blades', 'Whirlwind Blades', 'Power', 80, 'Dual power attacks hit all around you (gameplay not built yet).', ['dual_savagery'])
  ],
  unarmed: [
    perk('fists_of_steel', 'Fists of Steel', 'Brawling', 1, 'FistsOfSteel', [], 'Gauntlets add their armor rating to punches.'),
    unlock('hardened_knuckles', 'Hardened Knuckles', 'Brawling', 20, 'Punches deal more damage (gameplay not built yet).', ['fists_of_steel']),
    unlock('haymaker', 'Haymaker', 'Brawling', 40, 'Power punches can stagger (gameplay not built yet).', ['hardened_knuckles']),
    unlock('iron_chin', 'Iron Chin', 'Footwork', 20, 'Take less stamina damage in a brawl (gameplay not built yet).'),
    unlock('brawler_footwork', "Brawler's Footwork", 'Footwork', 60, 'Dodge-step while unarmed (gameplay not built yet).', ['iron_chin'])
  ],

  // ── Armor ────────────────────────────────────────────────────────────────
  heavy_armor: [
    ...ranks('juggernaut', 'Juggernaut', 'Protection', 'Juggernaut'),
    perk('well_fitted', 'Well Fitted', 'Fit', 20, 'WellFitted', ['juggernaut_1']),
    perk('tower_of_strength', 'Tower of Strength', 'Fit', 40, 'TowerOfStrength', ['well_fitted']),
    perk('matching_set_heavy', 'Matching Set', 'Fit', 60, 'MatchingSetHeavy', ['tower_of_strength']),
    perk('reflect_blows', 'Reflect Blows', 'Fit', 80, 'ReflectBlows', ['matching_set_heavy']),
    perk('cushioned', 'Cushioned', 'Endurance', 40, 'Cushioned', ['juggernaut_1']),
    perk('conditioning', 'Conditioning', 'Endurance', 60, 'Conditioning', ['cushioned'])
  ],
  light_armor: [
    ...ranks('agile_defender', 'Agile Defender', 'Protection', 'AgileDefender'),
    perk('custom_fit', 'Custom Fit', 'Fit', 20, 'CustomFit', ['agile_defender_1']),
    perk('unhindered', 'Unhindered', 'Fit', 40, 'Unhindered', ['custom_fit']),
    perk('wind_walker', 'Wind Walker', 'Fit', 60, 'WindWalker', ['unhindered']),
    perk('matching_set_light', 'Matching Set', 'Fit', 60, 'MatchingSet', ['custom_fit']),
    perk('deft_movement', 'Deft Movement', 'Fit', 80, 'DeftMovement', ['wind_walker', 'matching_set_light'])
  ],
  mage_armor: [
    perk('mage_armor_1', 'Mage Armor I', 'Wards', 20, 'MageArmor30'),
    perk('mage_armor_2', 'Mage Armor II', 'Wards', 40, 'MageArmor50', ['mage_armor_1']),
    perk('mage_armor_3', 'Mage Armor III', 'Wards', 60, 'MageArmor70', ['mage_armor_2']),
    perk('magic_resistance_1', 'Magic Resistance I', 'Resistance', 20, 'MagicResistance30'),
    perk('magic_resistance_2', 'Magic Resistance II', 'Resistance', 40, 'MagicResistance50', ['magic_resistance_1']),
    perk('magic_resistance_3', 'Magic Resistance III', 'Resistance', 60, 'MagicResistance70', ['magic_resistance_2']),
    unlock('robed_poise', 'Robed Poise', 'Wards', 1, 'Robes never slow you down (gameplay not built yet).')
  ],

  // ── Magic ────────────────────────────────────────────────────────────────
  alteration: [
    ...schoolRanks('alteration'),
    perk('alteration_dual_casting', 'Alteration Dual Casting', 'Craft', 20, 'AlterationDualCasting', ['alteration_novice']),
    perk('stability', 'Stability', 'Craft', 60, 'Stability', ['alteration_dual_casting']),
    perk('atronach', 'Atronach', 'Craft', 80, 'atronach', ['stability'])
  ],
  restoration: [
    ...schoolRanks('restoration'),
    perk('restoration_dual_casting', 'Restoration Dual Casting', 'Healing', 20, 'RestorationDualCasting', ['restoration_novice']),
    perk('regeneration', 'Regeneration', 'Healing', 20, 'Regeneration', ['restoration_novice']),
    perk('respite', 'Respite', 'Healing', 40, 'Respite', ['regeneration']),
    perk('recovery_1', 'Recovery I', 'Life', 20, 'Recovery30', ['restoration_novice']),
    perk('recovery_2', 'Recovery II', 'Life', 40, 'Recovery50', ['recovery_1']),
    perk('ward_absorb', 'Ward Absorb', 'Life', 60, 'wardAbsorb', ['recovery_2']),
    perk('necromage', 'Necromage', 'Life', 60, 'Necromage', ['regeneration']),
    perk('avoid_death', 'Avoid Death', 'Life', 80, 'AvoidDeath', ['ward_absorb'])
  ],
  destruction: [
    ...schoolRanks('destruction'),
    perk('destruction_dual_casting', 'Destruction Dual Casting', 'Force', 20, 'DestructionDualCasting', ['destruction_novice']),
    perk('impact', 'Impact', 'Force', 40, 'Impact', ['destruction_dual_casting']),
    perk('rune_master', 'Rune Master', 'Force', 40, 'RuneMaster', ['destruction_novice']),
    perk('augmented_flames', 'Augmented Flames', 'Fire', 20, 'AugmentedFlames', ['destruction_novice']),
    perk('intense_flames', 'Intense Flames', 'Fire', 60, 'IntenseFlames', ['augmented_flames']),
    perk('augmented_frost', 'Augmented Frost', 'Frost', 20, 'AugmentedFrost', ['destruction_novice']),
    perk('deep_freeze', 'Deep Freeze', 'Frost', 60, 'DeepFreeze', ['augmented_frost']),
    perk('augmented_shock', 'Augmented Shock', 'Shock', 20, 'AugmentedShock', ['destruction_novice']),
    perk('disintegrate', 'Disintegrate', 'Shock', 60, 'Disintegrate', ['augmented_shock'])
  ],
  illusion: [
    ...schoolRanks('illusion'),
    perk('illusion_dual_casting', 'Illusion Dual Casting', 'Mind', 20, 'IllusionDualCasting', ['illusion_novice']),
    perk('animage', 'Animage', 'Mind', 20, 'Animage', ['illusion_novice']),
    perk('kindred_mage', 'Kindred Mage', 'Mind', 40, 'KindredMage', ['animage']),
    perk('quiet_casting', 'Quiet Casting', 'Mind', 40, 'QuietCasting', ['animage']),
    perk('hypnotic_gaze', 'Hypnotic Gaze', 'Emotion', 20, 'HypnoticGaze', ['illusion_novice']),
    perk('aspect_of_terror', 'Aspect of Terror', 'Emotion', 40, 'AspectOfTerror', ['hypnotic_gaze']),
    perk('rage', 'Rage', 'Emotion', 60, 'Rage', ['aspect_of_terror']),
    perk('master_of_the_mind', 'Master of the Mind', 'Emotion', 80, 'MasterOfTheMind', ['rage', 'kindred_mage'])
  ],
  conjuration: [
    ...schoolRanks('conjuration'),
    perk('conjuration_dual_casting', 'Conjuration Dual Casting', 'Binding', 20, 'ConjurationDualCasting', ['conjuration_novice']),
    perk('mystic_binding', 'Mystic Binding', 'Binding', 20, 'MysticBinding', ['conjuration_novice']),
    perk('soul_stealer', 'Soul Stealer', 'Binding', 40, 'SoulStealer', ['mystic_binding']),
    perk('oblivion_binding', 'Oblivion Binding', 'Binding', 60, 'OblivionBinding', ['soul_stealer']),
    perk('necromancy', 'Necromancy', 'Necromancy', 20, 'Necromancy', ['conjuration_novice']),
    perk('dark_souls', 'Dark Souls', 'Necromancy', 60, 'DarkSouls', ['necromancy']),
    perk('summoner_1', 'Summoner I', 'Summoning', 20, 'Summoner30', ['conjuration_novice']),
    perk('atromancy', 'Atromancy', 'Summoning', 40, 'Atromancy', ['summoner_1']),
    perk('summoner_2', 'Summoner II', 'Summoning', 60, 'Summoner70', ['summoner_1']),
    perk('elemental_potency', 'Elemental Potency', 'Summoning', 60, 'ElementalPotency', ['atromancy']),
    perk('twin_souls', 'Twin Souls', 'Summoning', 80, 'TwinSouls', ['elemental_potency', 'dark_souls'])
  ],

  // ── Professions ──────────────────────────────────────────────────────────
  // The tier gates (which ore, which creature) come from the level itself
  // (core/skills.js ORE_TIERS / CREATURE_TIERS); nodes are extras on top.
  outfitter: [
    perk('elven_smithing', 'Elven Craft', 'Armor', 20, 'ElvenSmithing', [], 'Temper elven gear twice as well.'),
    perk('advanced_armors', 'Advanced Armors', 'Armor', 40, 'AdvancedArmors', ['elven_smithing'], 'Temper scaled and plate gear twice as well.'),
    perk('glass_smithing', 'Glass Craft', 'Armor', 60, 'GlassSmithing', ['advanced_armors'], 'Temper glass gear twice as well.'),
    unlock('tailoring', 'Tailoring', 'Cloth', 1, 'Sew clothes and robes.'),
    unlock('fine_tailoring', 'Fine Tailoring', 'Cloth', 40, 'Fine and noble clothing (gameplay not built yet).', ['tailoring']),
    unlock('leather_goods', 'Leather Goods', 'Leather', 1, 'Leather strips, belts and bags.'),
    unlock('packs_and_bandoliers', 'Packs and Bandoliers', 'Leather', 20, 'Backpacks, boxes and bandoliers (gameplay not built yet).', ['leather_goods'])
  ],
  metal_worker: [
    unlock('charcoal_smelting', 'Charcoal Smelting', 'Smelting', 1, 'Smelt ore with charcoal.'),
    unlock('efficient_smelting', 'Efficient Smelting', 'Smelting', 40, 'Extra ingot now and then (gameplay not built yet).', ['charcoal_smelting']),
    perk('steel_smithing', 'Steel Smithing', 'Forge', 1, 'SteelSmithing', [], 'Temper steel gear twice as well.'),
    perk('dwarven_smithing', 'Dwarven Smithing', 'Forge', 20, 'DwarvenSmithing', ['steel_smithing']),
    perk('orcish_smithing', 'Orcish Smithing', 'Forge', 40, 'OrcishSmithing', ['dwarven_smithing']),
    perk('ebony_smithing', 'Ebony Smithing', 'Forge', 60, 'EbonySmithing', ['orcish_smithing']),
    perk('daedric_smithing', 'Daedric Smithing', 'Forge', 80, 'DaedricSmithing', ['ebony_smithing']),
    perk('dragon_armor', 'Dragon Armor', 'Forge', 80, 'DragonArmor', ['ebony_smithing']),
    perk('arcane_blacksmith', 'Arcane Blacksmith', 'Temper', 60, 'ArcaneBlacksmith', ['steel_smithing'], 'Improve enchanted gear.')
  ],
  carpenter: [
    unlock('carpentry_bench', 'Carpentry Bench', 'Woodwork', 1, 'Work at a carpentry workbench.'),
    unlock('charcoal_burning', 'Charcoal Burning', 'Woodwork', 1, 'Turn wood into charcoal.'),
    unlock('practice_weapons', 'Practice Weapons', 'Woodwork', 20, 'Wooden practice weapons (gameplay not built yet).', ['carpentry_bench']),
    unlock('fletching', 'Fletching', 'Bowyer', 1, 'Make arrows and bolts.'),
    unlock('bowyer', 'Bowyer', 'Bowyer', 20, 'Make bows (gameplay not built yet).', ['fletching']),
    unlock('crossbows', 'Crossbows', 'Bowyer', 40, 'Make crossbows (gameplay not built yet).', ['bowyer']),
    unlock('fine_woodwork', 'Fine Woodwork', 'Woodwork', 60, 'Furniture and fine wood goods (gameplay not built yet).', ['practice_weapons'])
  ],
  alchemist: [
    perk('alchemist_1', 'Alchemist I', 'Potency', 1, 'Alchemist00'),
    perk('alchemist_2', 'Alchemist II', 'Potency', 20, 'Alchemist20', ['alchemist_1']),
    perk('alchemist_3', 'Alchemist III', 'Potency', 40, 'Alchemist40', ['alchemist_2']),
    perk('alchemist_4', 'Alchemist IV', 'Potency', 60, 'Alchemist60', ['alchemist_3']),
    perk('alchemist_5', 'Alchemist V', 'Potency', 80, 'Alchemist80', ['alchemist_4']),
    perk('physician', 'Physician', 'Remedies', 20, 'Physician', ['alchemist_1']),
    perk('benefactor', 'Benefactor', 'Remedies', 40, 'Benefactor', ['physician']),
    perk('purity', 'Purity', 'Remedies', 80, 'Purity', ['benefactor']),
    perk('poisoner', 'Poisoner', 'Poisons', 40, 'Poisoner', ['physician']),
    perk('concentrated_poison', 'Concentrated Poison', 'Poisons', 60, 'ConcentratedPoison', ['poisoner']),
    perk('green_thumb', 'Green Thumb', 'Herbalism', 40, 'GreenThumb', ['alchemist_1'], 'Gather two ingredients from plants.'),
    perk('experimenter', 'Experimenter', 'Herbalism', 40, 'Experimenter50', ['green_thumb'])
  ],
  enchanter: [
    perk('enchanter_1', 'Enchanter I', 'Power', 1, 'Enchanter00'),
    perk('enchanter_2', 'Enchanter II', 'Power', 20, 'Enchanter20', ['enchanter_1']),
    perk('enchanter_3', 'Enchanter III', 'Power', 40, 'Enchanter40', ['enchanter_2']),
    perk('enchanter_4', 'Enchanter IV', 'Power', 60, 'Enchanter60', ['enchanter_3']),
    perk('enchanter_5', 'Enchanter V', 'Power', 80, 'Enchanter80', ['enchanter_4']),
    perk('soul_squeezer', 'Soul Squeezer', 'Souls', 20, 'SoulSqueezer', ['enchanter_1']),
    perk('soul_siphon', 'Soul Siphon', 'Souls', 40, 'SoulSiphon', ['soul_squeezer']),
    perk('fire_enchanter', 'Fire Enchanter', 'Elements', 20, 'FireEnchanter', ['enchanter_1']),
    perk('frost_enchanter', 'Frost Enchanter', 'Elements', 40, 'FrostEnchanter', ['fire_enchanter']),
    perk('storm_enchanter', 'Storm Enchanter', 'Elements', 60, 'StormEnchanter', ['frost_enchanter']),
    perk('insightful_enchanter', 'Insightful Enchanter', 'Craft', 40, 'InsightfulEnchanter', ['enchanter_1']),
    perk('corpus_enchanter', 'Corpus Enchanter', 'Craft', 60, 'CorpusEnchanter', ['insightful_enchanter']),
    perk('extra_effect', 'Extra Effect', 'Craft', 80, 'ExtraEffect', ['corpus_enchanter', 'storm_enchanter'])
  ],
  farmer: [
    unlock('sowing', 'Sowing', 'Fields', 1, 'Plant and tend crops.'),
    unlock('good_harvest', 'Good Harvest', 'Fields', 20, 'Bigger harvests (gameplay not built yet).', ['sowing']),
    unlock('crop_rotation', 'Crop Rotation', 'Fields', 40, 'Crops grow faster (gameplay not built yet).', ['good_harvest']),
    unlock('milling', 'Milling', 'Goods', 1, 'Grind grain into flour.'),
    unlock('preserves', 'Preserves', 'Goods', 20, 'Jams, salted and dried goods (gameplay not built yet).', ['milling']),
    unlock('animal_husbandry', 'Animal Husbandry', 'Livestock', 40, 'Keep chickens, goats and cows (gameplay not built yet).')
  ],
  innkeeper: [
    unlock('cooking', 'Cooking', 'Kitchen', 1, 'Cook meals.'),
    unlock('hearty_meals', 'Hearty Meals', 'Kitchen', 20, 'Meals last longer (gameplay not built yet).', ['cooking']),
    unlock('feast', 'Feast', 'Kitchen', 60, 'Meals that feed a whole table (gameplay not built yet).', ['hearty_meals']),
    unlock('brewing', 'Brewing', 'Cellar', 1, 'Brew ale and mead.'),
    unlock('distilling', 'Distilling', 'Cellar', 40, 'Spirits and fine wines (gameplay not built yet).', ['brewing']),
    unlock('hospitality', 'Hospitality', 'Trade', 20, 'Better prices for rooms and meals (gameplay not built yet).')
  ],
  hunter: [
    unlock('field_dressing', 'Field Dressing', 'Harvest', 1, 'Skin and butcher animals you are skilled enough to harvest.'),
    unlock('clean_pelts', 'Clean Pelts', 'Harvest', 20, 'Pelts are worth more (gameplay not built yet).', ['field_dressing']),
    unlock('trophy_hunter', 'Trophy Hunter', 'Harvest', 60, 'Rare parts from large creatures (gameplay not built yet).', ['clean_pelts']),
    unlock('angling', 'Angling', 'Fishing', 1, 'Fish rivers and lakes.'),
    unlock('deep_water', 'Deep Water', 'Fishing', 40, 'Catch rarer fish (gameplay not built yet).', ['angling']),
    unlock('tracker', 'Tracker', 'Wilds', 20, 'Read animal tracks (gameplay not built yet).')
  ],
  prospector: [
    unlock('rich_veins', 'Rich Veins', 'Yield', 20, 'Extra ore now and then (gameplay not built yet).'),
    unlock('deep_veins', 'Deep Veins', 'Yield', 60, 'Veins last longer before running dry (gameplay not built yet).', ['rich_veins']),
    unlock('gem_finder', 'Gem Finder', 'Gems', 40, 'Chance to find gems while mining (gameplay not built yet).'),
    unlock('stone_reader', 'Stone Reader', 'Survey', 20, 'See which ore a vein holds before you swing (gameplay not built yet).'),
    unlock('iron_lungs', 'Iron Lungs', 'Survey', 40, 'Mining tires you less (gameplay not built yet).', ['stone_reader'])
  ]
});

/** @returns {ReadonlyArray<object>} the nodes of a skill's tree ([] if none). */
function treeOf(skillCode) {
  return TREES[skillCode] || [];
}

function findNode(skillCode, nodeCode) {
  return treeOf(skillCode).find(n => n.code === nodeCode) || null;
}

/**
 * Nodes the character effectively owns: everything at Master, otherwise the
 * bought ones.
 * @param {string} skillCode
 * @param {number} level
 * @param {string[]} bought
 */
function ownedNodes(skillCode, level, bought) {
  const tree = treeOf(skillCode);
  if (level >= 80) return tree.map(n => n.code);
  const set = new Set(bought || []);
  return tree.filter(n => set.has(n.code)).map(n => n.code);
}

/**
 * Can this node be bought now?
 * @returns {{ok: true, node} | {ok: false, code, message}}
 */
function canBuy({ skillCode, nodeCode, level, bought, pointsSpent }) {
  const skill = getSkill(skillCode);
  if (!skill) return { ok: false, code: 'unknown_skill', message: 'Unknown skill.' };
  const node = findNode(skill.code, nodeCode);
  if (!node) return { ok: false, code: 'unknown_node', message: `${skill.name} has no such node.` };
  if (level >= 80) return { ok: false, code: 'master', message: `As a ${skill.name} Master you already have the whole tree.` };
  const owned = new Set(bought || []);
  if (owned.has(node.code)) return { ok: false, code: 'owned', message: `You already have ${node.name}.` };
  if (level < node.minLevel) return { ok: false, code: 'level', message: `${node.name} needs ${skill.name} level ${node.minLevel}.` };
  // Like Skyrim's perk trees: any ONE of the listed nodes opens the way.
  if (node.requires.length && !node.requires.some(r => owned.has(r))) {
    const names = node.requires.map(r => (findNode(skill.code, r) || { name: r }).name);
    return { ok: false, code: 'requires', message: `${node.name} needs ${names.join(' or ')} first.` };
  }
  const available = Math.floor(Math.min(LEGENDARY_LEVEL, level) / 5) - (pointsSpent || 0);
  if (available < node.cost) return { ok: false, code: 'points', message: 'You have no skill points left in this tree.' };
  return { ok: true, node };
}

/** Every vanilla perk editor id used by any tree (resolved once at boot). */
function allPerkEditorIds() {
  const out = new Set();
  for (const nodes of Object.values(TREES)) for (const n of nodes) if (n.perk) out.add(n.perk);
  return [...out];
}

module.exports = {
  TREES,
  NODE_COST,
  treeOf,
  findNode,
  ownedNodes,
  canBuy,
  allPerkEditorIds
};
