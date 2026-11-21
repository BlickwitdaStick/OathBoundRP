'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachNexusSources } = require('./nexusSources');

const H = (c) => c.repeat(64);
const manifest = {
  files: [
    { path: 'SkyUI_SE.esp', size: 3, sha256: H('a') },
    { path: 'SkyUI_SE.bsa', size: 8, sha256: H('b') }
  ]
};

test('keeps entries that match the manifest, without their hashes', () => {
  const { sources, dropped } = attachNexusSources({
    game: 'skyrimspecialedition',
    sources: [{ id: 'skyui', name: 'SkyUI', modId: 12604, fileId: 749043, version: '6.11', fileName: 'SkyUI.zip', size: 10,
      provides: [{ src: 'SkyUI_SE.esp', path: 'SkyUI_SE.esp', sha256: H('a') }, { src: 'SkyUI_SE.bsa', path: 'SkyUI_SE.bsa', sha256: H('b') }] }]
  }, manifest);
  assert.deepEqual(dropped, []);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].game, 'skyrimspecialedition');
  assert.deepEqual(sources[0].provides, [{ src: 'SkyUI_SE.esp', path: 'SkyUI_SE.esp' }, { src: 'SkyUI_SE.bsa', path: 'SkyUI_SE.bsa' }]);
});

test('drops files that changed or left client-mods, and entries left empty', () => {
  const { sources, dropped } = attachNexusSources({
    sources: [
      { id: 'a', modId: 1, fileId: 2, fileName: 'a.7z', size: 0,
        provides: [{ src: 'x', path: 'SkyUI_SE.esp', sha256: H('c') }, { src: 'y', path: 'SkyUI_SE.bsa', sha256: H('b') }] },
      { id: 'gone', modId: 1, fileId: 3, fileName: 'b.7z', size: 5, provides: [{ src: 'z', path: 'Gone.esp', sha256: H('d') }] }
    ]
  }, manifest);
  assert.deepEqual(sources.map(s => s.id), ['a']);
  assert.deepEqual(sources[0].provides.map(p => p.path), ['SkyUI_SE.bsa']);
  assert.equal(dropped.length, 2);
});

test('refuses unsafe or malformed entries', () => {
  const bad = (over) => attachNexusSources({ sources: [{ id: 'x', modId: 1, fileId: 2, fileName: 'a.7z', size: 1,
    provides: [{ src: 'SkyUI_SE.esp', path: 'SkyUI_SE.esp', sha256: H('a') }], ...over }] }, manifest).sources.length;
  assert.equal(bad({}), 1);
  assert.equal(bad({ fileName: '../a.7z' }), 0);
  assert.equal(bad({ modId: 0 }), 0);
  assert.equal(bad({ size: -1 }), 0);
  assert.equal(bad({ provides: [{ src: '../../x', path: 'SkyUI_SE.esp', sha256: H('a') }] }), 0);
  assert.deepEqual(attachNexusSources(null, manifest), { sources: [], dropped: [] });
});
