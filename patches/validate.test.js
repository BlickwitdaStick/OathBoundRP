const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateManifest } = require('./validate');

// Every file exists, unless the test says otherwise.
const allFilesExist = { fileExists: () => true };

/** The test manifest's pin. The patches below point to a prefix of it. */
const PIN = 'd85f18d808f877401c4e20484d2c2f6f73cf9caa';

function patch(overrides = {}) {
  return {
    id: 'valid-example',
    target: 'skymp',
    file: 'skymp/example.patch',
    upstream_commit: 'd85f18d',
    reason: 'Without this the gamemode does not decide the spawn.',
    files_touched: ['skymp5-server/src/systems/spawn.ts'],
    impact: 'None when the hook is not exposed.',
    test: 'skymp/gamemode/spawn.test.js',
    loss_condition: 'A SkyMP reclone overwrites the file.',
    removal_strategy: 'Delete once the upstream PR lands.',
    upstream_pr: 'https://github.com/skyrim-multiplayer/skymp/pull/1',
    added: '2026-08-13',
    ...overrides
  };
}

function validate(patches, opts = allFilesExist) {
  return validateManifest({ version: 1, upstream: { pin: PIN }, patches }, opts);
}

describe('empty manifest', () => {
  test('an empty list is valid — having no patch is the preferred state', () => {
    const res = validate([]);
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
  });

  test('the repository manifest.json is valid', () => {
    const dir = __dirname;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const res = validateManifest(manifest, {
      fileExists: (rel) => fs.existsSync(path.join(dir, rel))
    });
    assert.equal(res.ok, true, `repository manifest.json is invalid: ${res.errors.join('; ')}`);
  });
});

describe('well-formed patch', () => {
  test('passes', () => {
    const res = validate([patch()]);
    assert.equal(res.ok, true, res.errors.join('; '));
  });
});

describe('required fields', () => {
  for (const field of [
    'id', 'target', 'file', 'upstream_commit', 'reason',
    'impact', 'loss_condition', 'removal_strategy', 'added'
  ]) {
    test(`missing "${field}" fails`, () => {
      const p = patch();
      delete p[field];
      const res = validate([p]);
      assert.equal(res.ok, false);
      assert.ok(
        res.errors.some((e) => e.includes(`"${field}"`)),
        `expected an error naming ${field}, got: ${res.errors.join('; ')}`
      );
    });

    test(`empty or whitespace-only "${field}" fails`, () => {
      const res = validate([patch({ [field]: '   ' })]);
      assert.equal(res.ok, false);
    });
  }
});

describe('loss_condition — the field that justifies this validator', () => {
  test('null fails', () => {
    const res = validate([patch({ loss_condition: null })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('loss_condition')));
  });

  test('there is no escape hatch: not even filled-in notes help', () => {
    const res = validate([patch({ loss_condition: '', notes: 'not sure' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('loss_condition')));
  });
});

describe('test and upstream_pr accept null, but require a justification', () => {
  test('null test without notes fails', () => {
    const res = validate([patch({ test: null })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('test is null')));
  });

  test('null test with notes passes', () => {
    const res = validate([patch({ test: null, notes: 'Build change; covered by the CI build itself.' })]);
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  test('missing upstream_pr fails', () => {
    const p = patch();
    delete p.upstream_pr;
    const res = validate([p]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('upstream_pr')));
  });

  test('null upstream_pr without notes fails', () => {
    const res = validate([patch({ upstream_pr: null })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('upstream_pr is null')));
  });

  test('null upstream_pr with notes passes', () => {
    const res = validate([patch({ upstream_pr: null, notes: 'Specific to our modpack; of no use upstream.' })]);
    assert.equal(res.ok, true, res.errors.join('; '));
  });
});

describe('registry integrity', () => {
  test('duplicate id fails', () => {
    const res = validate([patch(), patch()]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('duplicate')));
  });

  test('id not in kebab-case fails', () => {
    const res = validate([patch({ id: 'Spawn_Hook' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('kebab-case')));
  });

  test('unknown target fails', () => {
    const res = validate([patch({ target: 'skyrim' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('target')));
  });

  test('missing .patch file fails', () => {
    const res = validate([patch()], { fileExists: () => false });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('does not exist')));
  });

  test('empty files_touched fails', () => {
    const res = validate([patch({ files_touched: [] })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('files_touched')));
  });

  test('added in a non-ISO format fails', () => {
    const res = validate([patch({ added: '13/08/2026' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('ISO')));
  });

  test('accumulates errors from several patches instead of stopping at the first', () => {
    const res = validate([patch({ id: 'A_Bad_One' }), patch({ id: 'another', target: 'x' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.length >= 2, `expected several errors, got: ${res.errors.join('; ')}`);
  });
});

describe('pin — the commit all patches apply against', () => {
  test('an empty manifest does not need a pin', () => {
    const res = validateManifest({ version: 1, patches: [] }, allFilesExist);
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  test('a patch without a declared pin fails', () => {
    const res = validateManifest({ version: 1, patches: [patch()] }, allFilesExist);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('upstream.pin')), res.errors.join('; '));
  });

  test('an abbreviated pin fails — full SHA or nothing', () => {
    const res = validateManifest({ version: 1, upstream: { pin: 'd85f18d' }, patches: [patch()] }, allFilesExist);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('upstream.pin')));
  });

  test('an upstream_commit that is not a prefix of the pin fails', () => {
    const res = validate([patch({ upstream_commit: 'abc1234' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('does not match upstream.pin')), res.errors.join('; '));
  });

  test('a full upstream_commit equal to the pin passes', () => {
    const res = validate([patch({ upstream_commit: PIN })]);
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  test('the comparison is case-insensitive', () => {
    const res = validate([patch({ upstream_commit: 'D85F18D' })]);
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  test('a too-short upstream_commit fails before being compared with the pin', () => {
    const res = validate([patch({ upstream_commit: 'd85' })]);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('does not look like a SHA')), res.errors.join('; '));
  });

  test('an invalid pin fails even without any patch', () => {
    const res = validateManifest({ version: 1, upstream: { pin: 'not-a-sha' }, patches: [] }, allFilesExist);
    assert.equal(res.ok, false);
  });
});

describe('malformed manifest', () => {
  test('wrong version fails', () => {
    const res = validateManifest({ version: 2, patches: [] }, allFilesExist);
    assert.equal(res.ok, false);
  });

  test('non-list patches fails', () => {
    const res = validateManifest({ version: 1, patches: {} }, allFilesExist);
    assert.equal(res.ok, false);
  });

  test('a null manifest fails without throwing', () => {
    const res = validateManifest(null, allFilesExist);
    assert.equal(res.ok, false);
  });
});
