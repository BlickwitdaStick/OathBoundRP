'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const skills = require('./skills');

test('tiers: boundaries match the owner spec', () => {
  const at = (l) => skills.tierOf(l).name;
  assert.equal(at(1), 'Novice');
  assert.equal(at(19), 'Novice');
  assert.equal(at(20), 'Apprentice');
  assert.equal(at(39), 'Apprentice');
  assert.equal(at(40), 'Adept');
  assert.equal(at(59), 'Adept');
  assert.equal(at(60), 'Expert');
  assert.equal(at(79), 'Expert');
  assert.equal(at(80), 'Master');
  assert.equal(at(99), 'Master');
  assert.equal(at(100), 'Legendary');
});

test('EXP curve: 100 at level 1, steep near the top, monotonic', () => {
  assert.equal(skills.expToNext(1), 100);
  assert.equal(skills.expToNext(30), 999);
  assert.ok(skills.expToNext(98) > 9000);
  assert.equal(skills.expToNext(99), 0, 'no earned level past 99');
  assert.equal(skills.expForLevel(1), 0);
  assert.equal(skills.expForLevel(2), 100);
  for (let l = 2; l <= 99; l++) {
    assert.equal(skills.expForLevel(l), skills.expForLevel(l - 1) + skills.expToNext(l - 1));
  }
});

test('levelFromExp: inverse of expForLevel and capped at 99', () => {
  for (const l of [1, 2, 19, 20, 59, 80, 99]) {
    assert.equal(skills.levelFromExp(skills.expForLevel(l)), l);
    if (l > 1) assert.equal(skills.levelFromExp(skills.expForLevel(l) - 1), l - 1);
  }
  assert.equal(skills.levelFromExp(1e12), 99, 'EXP never reaches Legendary');
  assert.equal(skills.levelFromExp(1e12, 59), 59);
  assert.equal(skills.levelFromExp(-5), 1);
});

test('addExp: primary caps at 99, secondary at 59, legendary stays 100', () => {
  const primary = skills.addExp({ exp: 0, slot: 'primary' }, 1e9);
  assert.equal(primary.levelAfter, 99);
  assert.equal(primary.exp, skills.expForLevel(99));
  assert.equal(primary.capped, true);

  const secondary = skills.addExp({ exp: 0, slot: 'secondary' }, 1e9);
  assert.equal(secondary.levelAfter, 59);
  assert.equal(secondary.tierAfter, 'Adept');

  const legendary = skills.addExp({ exp: 5, slot: 'primary', legendary: true }, 100);
  assert.equal(legendary.levelAfter, 100);
  assert.equal(legendary.exp, 105);

  const tierUp = skills.addExp({ exp: skills.expForLevel(19), slot: 'primary' }, skills.expToNext(19));
  assert.equal(tierUp.tierBefore, 'Novice');
  assert.equal(tierUp.tierAfter, 'Apprentice');
});

test('addExp: soul bonus adds a percentage', () => {
  const r = skills.addExp({ exp: 0, slot: 'primary' }, 100, { bonusPct: 10 });
  assert.equal(r.gained, 110);
});

test('attribute table: every race has both sexes with all eight attributes', () => {
  assert.equal(Object.keys(skills.RACES).length, 10);
  for (const [key, race] of Object.entries(skills.RACES)) {
    for (const sex of ['male', 'female']) {
      for (const a of skills.ATTRIBUTES) {
        assert.ok(Number.isInteger(race[sex][a]), `${key}.${sex}.${a}`);
      }
      assert.equal(race[sex].luck, 50, 'Luck is 50 for everyone in the table');
    }
  }
  assert.deepEqual(skills.baseAttributes('orc', true), {
    agility: 35, endurance: 50, intelligence: 40, luck: 50, personality: 25, speed: 30, strength: 45, willpower: 45
  });
  assert.equal(skills.baseAttributes('nord', false).strength, 50);
  assert.equal(skills.baseAttributes('breton', false).willpower, 50);
});

test('raceKeyFromRaceId: playable and vampire races', () => {
  assert.equal(skills.raceKeyFromRaceId(0x13746), 'nord');
  assert.equal(skills.raceKeyFromRaceId(0x88794), 'nord');
  assert.equal(skills.raceKeyFromRaceId(0x13740), 'argonian');
  assert.equal(skills.raceKeyFromRaceId(0x13745), 'khajiit');
  assert.equal(skills.raceKeyFromRaceId(0xa82b9), 'orc');
  assert.equal(skills.raceKeyFromRaceId(0x12345), null);
});

test('attributeModifier: 50 neutral, full steps of 5 either way', () => {
  assert.equal(skills.attributeModifier(50), 0);
  assert.equal(skills.attributeModifier(54), 0);
  assert.equal(skills.attributeModifier(55), 1);
  assert.equal(skills.attributeModifier(59), 1);
  assert.equal(skills.attributeModifier(60), 2);
  assert.equal(skills.attributeModifier(46), 0);
  assert.equal(skills.attributeModifier(45), -1);
  assert.equal(skills.attributeModifier(41), -1);
  assert.equal(skills.attributeModifier(40), -2);
  assert.equal(skills.attributeModifier(25), -5);
  assert.equal(skills.attributeModifier(100), 10);
});

test('effectiveLevel applies the governing attribute and stays in 1..100', () => {
  const row = { exp: skills.expForLevel(30), slot: 'primary' };
  assert.equal(skills.effectiveLevel('two_handed', row, { strength: 45 }), 29);
  assert.equal(skills.effectiveLevel('two_handed', row, { strength: 55 }), 31);
  assert.equal(skills.effectiveLevel('prospector', { exp: 0, slot: 'primary' }, { strength: 20 }), 1);
  assert.equal(skills.effectiveLevel('illusion', { exp: 0, slot: 'primary', legendary: true }, { personality: 100 }), 100);
});

test('catalog: 9 professions, 5 combat, 3 armor, 5 magic, every attribute but Luck used', () => {
  const count = (c) => skills.skillsInCategory(c).length;
  assert.equal(count('profession'), 9);
  assert.equal(count('combat'), 5);
  assert.equal(count('armor'), 3);
  assert.equal(count('magic'), 5);
  const used = new Set(skills.SKILLS.map(s => s.attribute));
  for (const a of skills.ATTRIBUTES) {
    if (a === 'luck') assert.ok(!used.has(a));
    else assert.ok(used.has(a), a);
  }
  assert.equal(skills.getSkill('outfitter').name, 'Outfitting');
});

test('findSkill accepts code, name and practitioner', () => {
  assert.equal(skills.findSkill('Prospector').code, 'prospector');
  assert.equal(skills.findSkill('metal worker').code, 'metal_worker');
  assert.equal(skills.findSkill('One-Handed').code, 'one_handed');
  assert.equal(skills.findSkill('outfitting').code, 'outfitter');
  assert.equal(skills.findSkill('nope'), null);
});

test('canTake: one primary per category, secondary needs a primary, magic locked', () => {
  const owned = [{ skill_code: 'prospector', slot: 'primary' }];
  assert.equal(skills.canTake(owned, 'farmer', 'primary').code, 'primary_taken');
  assert.equal(skills.canTake(owned, 'farmer', 'secondary').ok, true);
  assert.equal(skills.canTake(owned, 'prospector', 'secondary').code, 'already_owned');
  assert.equal(skills.canTake(owned, 'archery', 'secondary').code, 'no_primary');
  assert.equal(skills.canTake(owned, 'archery', 'primary').ok, true);
  assert.equal(skills.canTake(owned, 'destruction', 'primary').code, 'magic_locked');
  assert.equal(skills.canTake(owned, 'destruction', 'primary', { magicUnlocked: true }).ok, true);
  const two = [...owned, { skill_code: 'farmer', slot: 'secondary' }];
  assert.equal(skills.canTake(two, 'hunter', 'secondary').code, 'secondary_taken');
});

test('validateStartChoice needs a profession, a combat and an armor skill', () => {
  assert.deepEqual(
    skills.validateStartChoice({ profession: 'hunter', combat: 'archery', armor: 'light_armor' }),
    { ok: true, skills: ['hunter', 'archery', 'light_armor'] }
  );
  assert.equal(skills.validateStartChoice({ profession: 'archery', combat: 'archery', armor: 'light_armor' }).ok, false);
  assert.equal(skills.validateStartChoice({ profession: 'hunter', combat: 'archery' }).ok, false);
});

test('canTeach: only Masters (or staff)', () => {
  assert.equal(skills.canTeach(79), false);
  assert.equal(skills.canTeach(80), true);
  assert.equal(skills.canTeach(1, { isStaff: true }), true);
});

test('character level: every 5 skill levels gained, capped at 99', () => {
  assert.equal(skills.characterLevel([1, 1, 1]), 1);
  assert.equal(skills.characterLevel([3, 3, 2]), 2);
  assert.equal(skills.characterLevel([21, 1, 1]), 5);
  assert.equal(skills.characterLevel(new Array(10).fill(99)), 99);
});

test('attribute points: 3 per level above 1 plus one per soul tier', () => {
  assert.equal(skills.attributePointsAvailable({ characterLevel: 1 }), 0);
  assert.equal(skills.attributePointsAvailable({ characterLevel: 2 }), 3);
  assert.equal(skills.attributePointsAvailable({ characterLevel: 2, soulLevel: 40 }), 5);
  assert.equal(skills.attributePointsAvailable({ characterLevel: 3, spent: 4 }), 2);
  assert.equal(skills.soulAttributeBonus(100), 5);
  assert.equal(skills.soulExpBonusPct(1), 0);
  assert.equal(skills.soulExpBonusPct(55), 5);
});

test('spendAttributePoints: enforces available points and the cap', () => {
  const base = skills.baseAttributes('nord', false);
  const ok = skills.spendAttributePoints({ base, added: {}, available: 3, spend: { strength: 2, endurance: 1 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.used, 3);
  assert.equal(ok.added.strength, 2);
  assert.equal(skills.spendAttributePoints({ base, added: {}, available: 2, spend: { strength: 3 } }).code, 'not_enough');
  assert.equal(skills.spendAttributePoints({ base, added: { strength: 49 }, available: 5, spend: { strength: 2 } }).code, 'over_cap');
  assert.equal(skills.spendAttributePoints({ base, added: {}, available: 5, spend: { strength: -1 } }).code, 'negative');
  assert.equal(skills.spendAttributePoints({ base, added: {}, available: 5, spend: {} }).code, 'nothing');
});

test('derivedStats: all-50 is vanilla, low Endurance lowers health', () => {
  const fifty = Object.fromEntries(skills.ATTRIBUTES.map(a => [a, 50]));
  assert.deepEqual(skills.derivedStats(fifty), { Health: 100, Magicka: 100, Stamina: 100, CarryWeight: 300, SpeedMult: 100 });
  const breton = skills.derivedStats(skills.baseAttributes('breton', false));
  assert.ok(breton.Health < 100);
  assert.ok(breton.Magicka > breton.Health);
});

test('vanillaSkillValues: unowned skills are 0, shared AV takes the higher skill', () => {
  const values = skills.vanillaSkillValues({
    outfitter: { exp: skills.expForLevel(25), slot: 'primary' },
    metal_worker: { exp: skills.expForLevel(40), slot: 'secondary' }
  }, { agility: 50, endurance: 50 });
  assert.equal(values.Smithing, 40);
  assert.equal(values.OneHanded, 0);
  assert.equal(values.Destruction, 0);
});

test('profession gates: ores and creatures by tier', () => {
  assert.equal(skills.canMine('iron', 1).ok, true);
  assert.equal(skills.canMine('corundum', 19).ok, false);
  assert.equal(skills.canMine('corundum', 20).ok, true);
  assert.equal(skills.canMine('moonstone', 40).ok, true);
  assert.equal(skills.canMine('orichalcum', 59).required, 'Expert');
  assert.equal(skills.canMine('ebony', 79).ok, false);
  assert.equal(skills.canMine('quicksilver', 80).ok, true);
  assert.equal(skills.canMine('malachite', 79).required, 'Master');
  assert.equal(skills.canHarvestCreature('troll', 19).ok, false, 'a novice cannot skin a troll');
  assert.equal(skills.canHarvestCreature('troll', 40).ok, true, 'an adept can');
  assert.equal(skills.canHarvestCreature('deer', 1).ok, true);
});

test('luck bonus: none at or below 50', () => {
  assert.equal(skills.luckBonusChance(50), 0);
  assert.equal(skills.luckBonusChance(30), 0);
  assert.ok(Math.abs(skills.luckBonusChance(60) - 0.02) < 1e-9);
});
