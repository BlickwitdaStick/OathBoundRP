/**
 * The arrest teleport must send the prison cell as "id:plugin". SkyMP reads a
 * bare '0x162e2' as a nonexistent server-generated cell and freezes the
 * prisoner there (same bug as the login teleport, core/position-persistence.js).
 */
const assert = require('node:assert/strict');
const { describe, it, after } = require('node:test');
const Module = require('module');

let cityRows = [];
const fakeDb = { query: async (sql) => (/FROM cities/i.test(sql) ? cityRows : []) };

const originalLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith('/database') || request === './database') return fakeDb;
  return originalLoad.apply(this, arguments);
};
const governance = require('./governance-service');
Module._load = originalLoad;

after(() => { delete global.mp; });

describe('prison cell for the arrest teleport', () => {
  it('no city prison configured: the default, as id:plugin', async () => {
    cityRows = [];
    assert.deepEqual(await governance._getDefaultPrison(), { cellId: '162e2:Skyrim.esm', pos: [35, -165, -189] });
  });

  it('a hand-typed bare id is resolved to id:plugin', async () => {
    cityRows = [{ prison_cell_id: '0x1a26f', prison_pos_x: 10, prison_pos_y: 20, prison_pos_z: 30 }];
    assert.deepEqual(await governance._getDefaultPrison(), { cellId: '1a26f:Skyrim.esm', pos: [10, 20, 30] });
  });

  it('a bare id from another plugin is resolved through mp.getDescFromId', async () => {
    global.mp = { getDescFromId: (id) => `${(id & 0xffffff).toString(16)}:Dawnguard.esm` };
    try {
      cityRows = [{ prison_cell_id: '0x0201a26f', prison_pos_x: 1, prison_pos_y: 2, prison_pos_z: 3 }];
      assert.equal((await governance._getDefaultPrison()).cellId, '1a26f:Dawnguard.esm');
    } finally {
      delete global.mp;
    }
  });

  it('an unusable value falls back to the default prison instead of freezing the prisoner', async () => {
    cityRows = [{ prison_cell_id: 'Whiterun jail', prison_pos_x: 10, prison_pos_y: 20, prison_pos_z: 30 }];
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      assert.deepEqual(await governance._getDefaultPrison(), { cellId: '162e2:Skyrim.esm', pos: [35, -165, -189] });
    } finally {
      console.error = origError;
    }
    assert.ok(errors.some((e) => /prison_cell_id 'Whiterun jail'/.test(e)));
  });
});
