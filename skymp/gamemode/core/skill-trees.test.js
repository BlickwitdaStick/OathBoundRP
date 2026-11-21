'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const trees = require('./skill-trees');
const skills = require('./skills');

test('every skill has a tree and every node is well formed', () => {
  for (const skill of skills.SKILLS) {
    const nodes = trees.treeOf(skill.code);
    assert.ok(nodes.length >= 5, `${skill.code} has a tree`);
    const codes = new Set();
    for (const n of nodes) {
      assert.ok(!codes.has(n.code), `${skill.code}.${n.code} is unique`);
      codes.add(n.code);
      assert.ok(n.minLevel >= 1 && n.minLevel <= 80, `${n.code} minLevel`);
      assert.ok(Boolean(n.perk) !== Boolean(n.unlock), `${n.code} is a perk or an unlock`);
      assert.ok(n.path, `${n.code} has a path`);
    }
    for (const n of nodes) for (const r of n.requires) assert.ok(codes.has(r), `${skill.code}.${n.code} requires ${r}`);
  }
});

test('a node never requires something with a higher minimum level', () => {
  for (const [code, nodes] of Object.entries(trees.TREES)) {
    for (const n of nodes) {
      for (const r of n.requires) {
        assert.ok(trees.findNode(code, r).minLevel <= n.minLevel, `${code}.${n.code} <- ${r}`);
      }
    }
  }
});

test('trees use only Skyrim perks known to exist', () => {
  const ids = trees.allPerkEditorIds();
  assert.ok(ids.includes('Armsman00'));
  assert.ok(ids.includes('MageArmor30'));
  assert.ok(ids.every(id => /^[A-Za-z][A-Za-z0-9]+$/.test(id)));
});

test('canBuy: level, prerequisites (any one), points and Master', () => {
  const base = { skillCode: 'one_handed', bought: [], pointsSpent: 0 };
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_1', level: 4 }).code, 'points', 'no point before level 5');
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_1', level: 5 }).ok, true);
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_2', level: 25 }).code, 'requires');
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_2', level: 19, bought: ['armsman_1'], pointsSpent: 1 }).code, 'level');
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_2', level: 20, bought: ['armsman_1'], pointsSpent: 1 }).ok, true);
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_2', level: 20, bought: ['armsman_1'], pointsSpent: 4 }).code, 'points');
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_1', level: 10, bought: ['armsman_1'], pointsSpent: 1 }).code, 'owned');
  assert.equal(trees.canBuy({ ...base, nodeCode: 'armsman_1', level: 80 }).code, 'master');
  assert.equal(trees.canBuy({ ...base, nodeCode: 'nope', level: 50 }).code, 'unknown_node');
  // Any one prerequisite is enough (Master of the Mind: Rage OR Kindred Mage).
  assert.equal(trees.canBuy({ skillCode: 'illusion', nodeCode: 'master_of_the_mind', level: 80 - 1, bought: ['kindred_mage'], pointsSpent: 3 }).code, 'level');
});

test('ownedNodes: Master owns the whole tree', () => {
  assert.deepEqual(trees.ownedNodes('archery', 30, ['overdraw_1', 'eagle_eye', 'bogus']), ['overdraw_1', 'eagle_eye']);
  assert.equal(trees.ownedNodes('archery', 80, []).length, trees.treeOf('archery').length);
});
