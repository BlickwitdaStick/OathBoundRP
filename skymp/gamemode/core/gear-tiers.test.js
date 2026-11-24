const { describe, it } = require('node:test');
const assert = require('node:assert');
const gearTiers = require('./gear-tiers');
const skills = require('./skills');

const tierOf = (item) => gearTiers.classify(item).tier;

describe('gear tiers: classify', () => {
  it('vanilla material keywords', () => {
    assert.equal(tierOf({ keywords: ['ArmorMaterialIron'] }), 'novice');
    assert.equal(tierOf({ keywords: ['ArmorMaterialLeather'] }), 'novice');
    assert.equal(tierOf({ keywords: ['ArmorMaterialSteel'] }), 'apprentice');
    assert.equal(tierOf({ keywords: ['DLC2ArmorMaterialBonemoldHeavy'] }), 'apprentice');
    assert.equal(tierOf({ keywords: ['ArmorMaterialElven'] }), 'adept');
    assert.equal(tierOf({ keywords: ['DLC2ArmorMaterialChitinLight'] }), 'adept');
    assert.equal(tierOf({ keywords: ['WeapMaterialDwarven'] }), 'adept');
    assert.equal(tierOf({ keywords: ['ArmorMaterialOrcish'] }), 'expert');
    assert.equal(tierOf({ keywords: ['ArmorMaterialGlass'] }), 'master');
    assert.equal(tierOf({ keywords: ['WeapMaterialEbony'] }), 'master');
    assert.equal(tierOf({ keywords: ['ArmorMaterialDragonplate'] }), 'master');
  });

  it('steel plate is Expert, not Apprentice', () => {
    assert.equal(tierOf({ keywords: ['ArmorMaterialSteelPlate'] }), 'expert');
    assert.equal(tierOf({ name: 'Steel Plate Boots', keywords: ['ArmorMaterialSteel'] }), 'expert');
  });

  it('every guard and Stormcloak/Eastmarch piece is Apprentice', () => {
    assert.equal(tierOf({ name: "Guard of Whiterun's Armor", keywords: ['ArmorMaterialIronBanded'] }), 'apprentice');
    assert.equal(tierOf({ edid: 'ArmorGuardCuirassWhiterun', keywords: ['ArmorMaterialHide'] }), 'apprentice');
    assert.equal(tierOf({ name: 'Eastmarch Officer Armor', keywords: ['ArmorMaterialSteelPlate'] }), 'apprentice');
    assert.equal(tierOf({ name: "Guardian's Longsword", keywords: ['WeapMaterialGlass'] }), 'master');
  });

  it('the original material keyword wins over WACCF additions', () => {
    assert.equal(tierOf({ keywords: ['WeapMaterialDraugr', 'WAF_MaterialNordic'] }), 'novice');
    assert.equal(tierOf({ keywords: ['WAF_MaterialNordic'] }), 'adept');
  });

  it('modded gear without a keyword falls back to its name, then its recipe', () => {
    assert.equal(tierOf({ name: 'Vvardenfell Glass Helmet' }), 'master');
    assert.equal(tierOf({ name: 'Highwayman Mail', ingredients: ['IngotCorundum', 'LeatherStrips'] }), 'apprentice');
    assert.equal(tierOf({ name: 'Mystery Plate', ingredients: ['IngotQuicksilver'] }), 'expert');
    assert.equal(tierOf({ name: 'Mystery Plate' }), null);
  });

  it('smelting follows the ore', () => {
    assert.equal(gearTiers.smeltTier('IngotIron'), 'novice');
    assert.equal(gearTiers.smeltTier('IngotCorundum'), 'apprentice');
    assert.equal(gearTiers.smeltTier('IngotIMoonstone'), 'adept');
    assert.equal(gearTiers.smeltTier('IngotOrichalcum'), 'expert');
    assert.equal(gearTiers.smeltTier('IngotEbony'), 'master');
    assert.equal(gearTiers.smeltTier('IngotSteel', ['IngotIron', 'OreCorundum']), 'apprentice');
  });
});

describe('gear tiers: perks and use', () => {
  it('a crafter owns every tier perk up to their own', () => {
    assert.deepEqual(gearTiers.tierPerksFor('metal_worker', 0), ['OB_Metalworking_Novice']);
    assert.deepEqual(gearTiers.tierPerksFor('outfitter', 2), ['OB_Outfitting_Novice', 'OB_Outfitting_Apprentice', 'OB_Outfitting_Adept']);
    assert.equal(gearTiers.tierPerksFor('outfitter', 5).length, 5, 'Legendary owns all five');
    assert.deepEqual(gearTiers.tierPerksFor('hunter', 4), []);
    assert.equal(gearTiers.allTierPerks().length, 10);
  });

  it('a Novice wears Iron only; no skill means nothing of that kind', () => {
    const steel = { skill: 'heavy_armor', tier: 1 };
    const iron = { skill: 'heavy_armor', tier: 0 };
    assert.equal(gearTiers.canUse(iron, () => 10, skills.tierIndex).ok, true);
    const no = gearTiers.canUse(steel, () => 10, skills.tierIndex);
    assert.deepEqual(no, { ok: false, skill: 'heavy_armor', required: 'Apprentice', have: 'Novice' });
    assert.equal(gearTiers.canUse(steel, () => 20, skills.tierIndex).ok, true);
    assert.deepEqual(gearTiers.canUse(iron, () => 0, skills.tierIndex), { ok: false, skill: 'heavy_armor', required: 'Novice', have: null });
    assert.equal(gearTiers.canUse({ skill: 'heavy_armor', tier: 4 }, () => 100, skills.tierIndex).ok, true);
  });

  it('looks items up by FormDesc, whatever the case or 0x prefix', () => {
    gearTiers.setTable({ '12eb7:Skyrim.esm': { skill: 'one_handed', tier: 0 } });
    assert.deepEqual(gearTiers.lookup('0x12EB7:skyrim.esm'), { skill: 'one_handed', tier: 0 });
    assert.equal(gearTiers.lookup('1:Skyrim.esm'), null);
  });
});
