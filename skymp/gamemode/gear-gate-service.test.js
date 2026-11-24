const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const gearTiers = require('./core/gear-tiers');
const gate = require('./gear-gate-service');

const ACTOR = 0xff000001;
const STEEL_SWORD = 0x13989;
const IRON_SWORD = 0x12eb7;
const STEEL_ARMOR = 0x13952;

describe('gear gate', () => {
  let worn, unequipped, notices, levels, numChanges;

  beforeEach(() => {
    gearTiers.setTable({
      '13989:Skyrim.esm': { skill: 'one_handed', tier: 1 },
      '12eb7:Skyrim.esm': { skill: 'one_handed', tier: 0 },
      '13952:Skyrim.esm': { skill: 'heavy_armor', tier: 1 }
    });
    worn = [];
    unequipped = [];
    notices = [];
    levels = {};
    numChanges = 1;
    gate.configure({
      mp: () => ({
        get: (id, key) => (key === 'equipment' ? { numChanges, inv: { entries: worn } } : null),
        getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`
      }),
      listActive: () => [ACTOR],
      characterOf: () => ({ characterId: 7 }),
      skillLevel: async (_c, skill) => levels[skill] || 0,
      notify: (id, text) => notices.push(text),
      unequip: (id, baseId) => unequipped.push(baseId),
      now: () => 1000,
      logger: { log() {}, error() {} }
    });
    gate.recheck(ACTOR);
  });

  it('a Novice swordsman keeps an iron sword and loses a steel one', async () => {
    levels.one_handed = 12;
    worn = [{ baseId: IRON_SWORD, count: 1, worn: true }, { baseId: STEEL_SWORD, count: 1, worn: true }];
    assert.deepEqual(await gate.checkActor(ACTOR), [STEEL_SWORD]);
    assert.deepEqual(unequipped, [STEEL_SWORD]);
    assert.match(notices[0], /One-Handed Apprentice \(you are Novice\)/);
  });

  it('no Heavy Armor skill: heavy armor comes off', async () => {
    worn = [{ baseId: STEEL_ARMOR, count: 1, worn: true }];
    assert.deepEqual(await gate.checkActor(ACTOR), [STEEL_ARMOR]);
    assert.match(notices[0], /needs the Heavy Armor skill at Apprentice/);
  });

  it('an Apprentice keeps steel; unknown items are never touched', async () => {
    levels.heavy_armor = 25;
    worn = [{ baseId: STEEL_ARMOR, count: 1, worn: true }, { baseId: 0xabcdef, count: 1, worn: true }];
    assert.deepEqual(await gate.checkActor(ACTOR), []);
    assert.deepEqual(unequipped, []);
  });

  it('unchanged equipment is not checked again until a recheck', async () => {
    levels.one_handed = 5;
    worn = [{ baseId: IRON_SWORD, count: 1, worn: true }];
    await gate.checkActor(ACTOR);
    worn = [{ baseId: STEEL_SWORD, count: 1, worn: true }];
    assert.deepEqual(await gate.checkActor(ACTOR), [], 'same numChanges: skipped');
    gate.recheck(ACTOR);
    assert.deepEqual(await gate.checkActor(ACTOR), [STEEL_SWORD]);
  });

  it('items in the bag, not worn, are ignored', async () => {
    worn = [{ baseId: STEEL_SWORD, count: 1 }];
    assert.deepEqual(await gate.checkActor(ACTOR), []);
  });
});
