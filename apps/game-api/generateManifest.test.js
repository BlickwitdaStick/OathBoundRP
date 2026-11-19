/**
 * generateManifest.test.js
 *
 * The `mods.json` generator had no tests — and it decides the FormID contract,
 * which is the thing that, when it goes wrong, produces no error at all: it
 * produces a chest with something else inside (`MODS_AND_GAMEMODE_CONTRACT.md` §3).
 *
 * What these tests lock down:
 *
 *   1. **`--only-load-order` restricts the manifest.** Without the flag,
 *      generating from a working `Data/` produces a manifest that demands the
 *      generator's machine — `compareMods` fails every manifest file the
 *      client doesn't have, so a tester with a clean install gets blocked by a
 *      mod that is not part of anything.
 *   2. **Load-order validation must not agree with itself.** With the flag,
 *      `entries` is derived from the load order itself; if the "plugin that
 *      doesn't exist in Data/" check used `entries` as its reference, it would
 *      start approving anything.
 *   3. **A load order without `--plugins-txt` is still refused** as a
 *      trustworthy source (alphabetical order is not load order).
 *
 * Run with: node --test generateManifest.test.js
 */

const assert = require('assert');
const { describe, it, before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GENERATOR = path.join(__dirname, 'scripts', 'generate-mods-manifest.js');

let tmp, dataDir;

/** Synthetic plugin — the generator only reads bytes to hash, it doesn't parse TES4. */
function writePlugin(name, content) {
  fs.writeFileSync(path.join(dataDir, name), content);
}

/**
 * `spawnSync` rather than `execFileSync` because the generator writes to both
 * streams: progress goes to stdout and warnings go to stderr (`console.warn`).
 * A helper that only reads stdout on the success path would leave the warning
 * test green forever, without ever seeing the warning.
 */
function run(args) {
  const r = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  dataDir = path.join(tmp, 'Data');
  fs.mkdirSync(dataDir);

  // Three "from the modpack" and two that only exist on this machine.
  writePlugin('Skyrim.esm', 'base');
  writePlugin('Update.esm', 'update');
  writePlugin('Patch.esp', 'patch');
  writePlugin('LocalMod.esp', 'only on this machine');
  writePlugin('Textures.bsa', 'local bsa');

  fs.writeFileSync(path.join(tmp, 'plugins.txt'), '*Skyrim.esm\n*Update.esm\n*Patch.esp\n');
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('--only-load-order restricts the manifest to the load order', () => {
  it('without the flag, the manifest includes all of Data', () => {
    const out = path.join(tmp, 'full.json');
    const r = run([dataDir, '--plugins-txt', path.join(tmp, 'plugins.txt'), '--out', out]);
    assert.ok(r.ok, r.output);

    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(m.mods.length, 5, 'without the flag, every plugin or BSA goes in');
    assert.equal(m.loadOrder.length, 3);
    assert.ok(
      m.mods.some(x => x.filename === 'LocalMod.esp'),
      'this is exactly why the flag exists: the local mod would demand the generator\'s machine'
    );
  });

  it('with the flag, only load-order plugins go in', () => {
    const out = path.join(tmp, 'lean.json');
    const r = run([dataDir, '--plugins-txt', path.join(tmp, 'plugins.txt'), '--out', out, '--only-load-order']);
    assert.ok(r.ok, r.output);

    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(m.mods.length, 3);
    assert.deepEqual(m.mods.map(x => x.filename).sort(), ['Patch.esp', 'Skyrim.esm', 'Update.esm']);
    assert.ok(
      !m.mods.some(x => x.filename === 'LocalMod.esp'),
      'a mod that is not in the load order must not be required of the client'
    );
  });

  it('every manifest file appears in the load order', () => {
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'lean.json'), 'utf8'));
    const order = new Set(m.loadOrder.map(p => p.toLowerCase()));
    for (const mod of m.mods) {
      assert.ok(order.has(mod.filename.toLowerCase()), `${mod.filename} is in the manifest but not in the order`);
    }
  });

  it('the flag requires --plugins-txt', () => {
    const r = run([dataDir, '--only-load-order', '--out', path.join(tmp, 'x.json')]);
    assert.equal(r.ok, false, 'without a load order there is nothing to restrict to');
    assert.match(r.output, /requires --plugins-txt/);
  });
});

describe('load-order validation does not agree with itself', () => {
  it('a plugin in the order that does not exist in Data/ fails, even with the flag', () => {
    // The specific regression: with `--only-load-order`, `entries` is derived
    // from the load order. If the check compared the two, every phantom plugin
    // would pass — and the manifest would ship a plugin nobody has.
    const badPlugins = path.join(tmp, 'plugins-phantom.txt');
    fs.writeFileSync(badPlugins, '*Skyrim.esm\n*DoesNotExist.esp\n');

    const r = run([dataDir, '--plugins-txt', badPlugins, '--out', path.join(tmp, 'bad.json'), '--only-load-order']);

    assert.equal(r.ok, false, 'should refuse');
    assert.match(r.output, /do not exist in Data\/: DoesNotExist\.esp/);
    assert.equal(fs.existsSync(path.join(tmp, 'bad.json')), false, 'must not write an invalid manifest');
  });
});

describe('a load order without plugins.txt is marked untrustworthy', () => {
  it('warns and records the provenance in the manifest', () => {
    const out = path.join(tmp, 'no-order.json');
    const r = run([dataDir, '--out', out]);
    assert.ok(r.ok, r.output);

    assert.match(r.output, /WARNING/);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.match(
      m.loadOrderSource, /UNRELIABLE/,
      'whoever reads the manifest later needs to know the order was inferred from file names'
    );
  });
});
