'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const forms = require('./progression-forms');

test('parseTrackedPlugins: default list, or a comma-separated override', () => {
  assert.deepEqual(forms.parseTrackedPlugins(undefined), [...forms.DEFAULT_TRACKED_PLUGINS]);
  assert.deepEqual(forms.parseTrackedPlugins(' Mundus.esp , Apprentice.esp '), ['Mundus.esp', 'Apprentice.esp']);
});

test('buildCatalog: tree perks from Skyrim.esm, every PERK/SPEL of tracked plugins', async () => {
  const files = [
    { name: 'Skyrim.esm', path: 'a' },
    { name: 'Other.esp', path: 'b' },
    { name: 'Mundus.esp', path: 'c' }
  ];
  const parsed = [];
  const parseFile = async (path, name, loadIndex, types) => {
    parsed.push(name);
    assert.ok(types.has('PERK') && types.has('SPEL'));
    if (name === 'Skyrim.esm') {
      return [
        { id: 0xbabe4, type: 'PERK', editorId: 'Armsman00', origin: 'Skyrim.esm', localId: 0xbabe4 },
        { id: 0x1, type: 'PERK', editorId: 'Unwanted', origin: 'Skyrim.esm', localId: 1 }
      ];
    }
    return [
      { id: 0xe5f4c, type: 'SPEL', editorId: 'MAG_WarriorDoomStoneSpell01', origin: 'Skyrim.esm', localId: 0xe5f4c },
      { id: 0x0200080d, type: 'PERK', editorId: 'MAG_WarriorDoomStonePerk01', origin: 'Mundus.esp', localId: 0x80d }
    ];
  };
  const c = await forms.buildCatalog(files, {
    trackedPlugins: ['Mundus.esp', 'Pilgrim.esp'],
    perkEditorIds: ['Armsman00', 'Missing00'],
    parseFile,
    isLight: async () => false
  });
  assert.deepEqual(parsed, ['Skyrim.esm', 'Mundus.esp'], 'untracked plugins are not read');
  assert.equal(c.perkByEditorId.get('Armsman00'), 0xbabe4);
  assert.deepEqual(c.missingPerks, ['Missing00']);
  assert.deepEqual(c.missingPlugins, ['Pilgrim.esp']);
  assert.deepEqual(c.tracked.get(0x0200080d), { kind: 'perk', formDesc: '0x80d:Mundus.esp', editorId: 'MAG_WarriorDoomStonePerk01', plugin: 'Mundus.esp' });
  assert.equal(c.tracked.get(0xe5f4c).formDesc, '0xe5f4c:Skyrim.esm', 'overrides keep the origin plugin');
  assert.equal(c.globalByDesc.get('0x80d:mundus.esp'), 0x0200080d);
});

test('diffReport: only tracked forms, unresolved ones are not deleted', () => {
  const tracked = new Map([
    [1, { kind: 'perk', formDesc: '0x1:A.esp' }],
    [2, { kind: 'spell', formDesc: '0x2:A.esp' }],
    [3, { kind: 'spell', formDesc: '0x3:A.esp' }]
  ]);
  const stored = new Set(['spell|0x2:A.esp', 'spell|0x3:A.esp']);
  const d = forms.diffReport(tracked, stored, { perks: [1, 999], spells: [], unresolved: [3] });
  assert.deepEqual(d.add, [{ kind: 'perk', formDesc: '0x1:A.esp' }]);
  assert.deepEqual(d.remove, [{ kind: 'spell', formDesc: '0x2:A.esp' }]);
});
