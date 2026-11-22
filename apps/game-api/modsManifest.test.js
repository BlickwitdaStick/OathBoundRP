const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createManifestLoader, isValidManifest } = require('./modsManifest');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-manifest-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

describe('manifest shape validation', () => {
  test('accepts a well-formed manifest', () => {
    assert.equal(isValidManifest({
      hashAlgorithm: 'sha256',
      mods: [{ filename: 'Skyrim.esm', hash: HASH_A }],
      loadOrder: ['Skyrim.esm']
    }), true);
  });

  test('rejects an empty manifest', () => {
    assert.equal(isValidManifest({ hashAlgorithm: 'sha256', mods: [], loadOrder: [] }), false);
  });

  test('rejects a missing or legacy algorithm', () => {
    const base = { mods: [{ filename: 'Skyrim.esm', hash: HASH_A }], loadOrder: ['Skyrim.esm'] };
    assert.equal(isValidManifest(base), false);
    assert.equal(isValidManifest({ ...base, hashAlgorithm: 'md5' }), false);
  });

  test('rejects a hash that is not hex SHA-256', () => {
    assert.equal(isValidManifest({
      hashAlgorithm: 'sha256',
      mods: [{ filename: 'Skyrim.esm', hash: 'abc' }],
      loadOrder: ['Skyrim.esm']
    }), false);
  });

  test('rejects a mod without a hash', () => {
    assert.equal(isValidManifest({ hashAlgorithm: 'sha256', mods: [{ filename: 'a.esp' }], loadOrder: ['a.esp'] }), false);
  });

  test('rejects a mod without a filename', () => {
    assert.equal(isValidManifest({ hashAlgorithm: 'sha256', mods: [{ hash: HASH_A }], loadOrder: ['a.esp'] }), false);
  });

  test('rejects a missing loadOrder', () => {
    assert.equal(isValidManifest({ hashAlgorithm: 'sha256', mods: [{ filename: 'a.esp', hash: HASH_A }] }), false);
  });

  test('rejects a non-object', () => {
    assert.equal(isValidManifest(null), false);
    assert.equal(isValidManifest('{}'), false);
  });
});

describe('loader', () => {
  test('a missing manifest reports an error instead of an empty list', () => {
    // This is the crux: an empty list would pass the launcher's parity check
    // and let any modpack in.
    const loader = createManifestLoader(path.join(tmpDir, 'does-not-exist.json'));
    const result = loader.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_missing');
    assert.equal(result.manifest, undefined);
  });

  test('corrupt JSON reports an error', () => {
    const p = writeManifest('corrupt.json', '{ this is not json');
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_invalid_json');
  });

  test('an invalid shape reports an error', () => {
    const p = writeManifest('wrong-shape.json', { hashAlgorithm: 'sha256', mods: [{ filename: 'a.esp' }], loadOrder: ['a.esp'] });
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_invalid_shape');
  });

  test('loads a valid manifest', () => {
    const p = writeManifest('valid.json', {
      hashAlgorithm: 'sha256',
      mods: [{ filename: 'Skyrim.esm', hash: HASH_A }, { filename: 'HeavyRP.esm', hash: HASH_B }],
      loadOrder: ['Skyrim.esm', 'HeavyRP.esm']
    });
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, true);
    assert.equal(result.manifest.mods.length, 2);
    assert.deepEqual(result.manifest.loadOrder, ['Skyrim.esm', 'HeavyRP.esm']);
  });

  test('reloads when the file changes on disk', () => {
    const p = writeManifest('cache.json', { hashAlgorithm: 'sha256', mods: [{ filename: 'a.esp', hash: HASH_A }], loadOrder: ['a.esp'] });
    const loader = createManifestLoader(p);

    assert.equal(loader.load().manifest.mods.length, 1);

    // mtime has ms granularity on some systems; we force a distinct value so
    // the test exercises invalidation rather than luck.
    fs.writeFileSync(p, JSON.stringify({
      hashAlgorithm: 'sha256',
      mods: [{ filename: 'a.esp', hash: HASH_A }, { filename: 'b.esp', hash: HASH_B }],
      loadOrder: ['a.esp', 'b.esp']
    }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);

    assert.equal(loader.load().manifest.mods.length, 2, 'the cache should have been invalidated by the mtime');
  });
});
