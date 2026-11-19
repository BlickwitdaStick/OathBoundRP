'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { normalizeLoadOrder, verifyRuntimeCompatibility } = require('./runtime-compatibility');

function mock(expected, actual) {
  return {
    getServerSettings: () => ({ loadOrder: expected }),
    getEspmLoadOrder: () => actual
  };
}

describe('runtime compatibility gate', () => {
  test('aprova a load order realmente carregada', () => {
    const result = verifyRuntimeCompatibility(mock(
      ['Skyrim.esm', 'Update.esm'],
      ['skyrim.esm', 'UPDATE.ESM']
    ));
    assert.deepEqual(result.loadOrder, ['skyrim.esm', 'update.esm']);
  });

  test('reprova ordem divergente', () => {
    assert.throws(
      () => verifyRuntimeCompatibility(mock(['Skyrim.esm', 'Update.esm'], ['Update.esm', 'Skyrim.esm'])),
      /effective load order differs/
    );
  });

  test('reprova plugin ausente ou extra', () => {
    assert.throws(() => verifyRuntimeCompatibility(mock(['Skyrim.esm'], ['Skyrim.esm', 'Extra.esm'])), /differs/);
    assert.throws(() => verifyRuntimeCompatibility(mock(['Skyrim.esm', 'Update.esm'], ['Skyrim.esm'])), /differs/);
  });

  test('reprova API e configuração ausentes', () => {
    assert.throws(() => verifyRuntimeCompatibility({}), /getServerSettings/);
    assert.throws(() => verifyRuntimeCompatibility({ getServerSettings: () => ({ loadOrder: [] }) }), /getEspmLoadOrder/);
    assert.throws(() => verifyRuntimeCompatibility(mock([], [])), /no valid loadOrder/);
  });
});

test('normalização rejeita não-array', () => {
  assert.equal(normalizeLoadOrder(null), null);
});
