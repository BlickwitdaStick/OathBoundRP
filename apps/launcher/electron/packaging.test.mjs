import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcherDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(launcherDir, 'electron-builder.json'), 'utf8'));

test('the package includes the CEF UI as a launcher resource', () => {
  assert.ok(config.extraResources.some((entry) => entry.from === '../../skymp/ui' && entry.to === 'skymp-ui'));
});

test('the package includes voice-helper.exe as a vendor resource (optional)', () => {
  const entry = config.extraResources.find((e) => e.to === 'vendor');
  assert.ok(entry, 'the extraResources entry for vendor/ is missing');
  assert.equal(entry.from, 'build-resources');
  assert.deepEqual(entry.filter, ['voice-helper.exe']);

  // The `from` must exist under version control, or electron-builder fails
  // before anything else — even when the (unversioned) exe wasn't staged.
  const stagingDir = path.join(launcherDir, entry.from);
  assert.ok(fs.existsSync(stagingDir), `${entry.from}/ has to exist in the repo`);
});

test('the package ships 7za.exe for Nexus archives', () => {
  const entry = config.extraResources.find((e) => e.to === 'vendor' && e.filter.includes('7za.exe'));
  assert.ok(entry, 'missing extraResources entry for 7za.exe');
  assert.ok(fs.existsSync(path.join(launcherDir, entry.from, '7za.exe')), `${entry.from}/7za.exe must exist (npm install)`);
});

test('the build stages the voice-helper before packaging', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(launcherDir, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /stage-voice-helper\.mjs.*electron-builder/s);
});

test('the package does not recursively include its own output folder', () => {
  assert.ok(config.files.includes('dist-electron/main.mjs'));
  assert.ok(config.files.includes('dist-electron/preload.mjs'));
  assert.ok(!config.files.includes('dist-electron/**/*'));
});
