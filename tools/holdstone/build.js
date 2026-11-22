#!/usr/bin/env node
/**
 * Rebuilds the holdstone: model, textures and plugin, into tools/holdstone/dist/.
 *
 *   node tools/holdstone/build.js             build into dist/
 *   node tools/holdstone/build.js --install   build, then copy dist/ into skymp/client-mods/
 *                                             (the launcher sends it to players; the
 *                                             server picks the plugin up on its next start)
 *
 * Needs Blender (5.x) with the PyNifly add-on, and the Skyrim SE Data folder
 * (vanilla textures and two vanilla NIFs are read from its BSAs; nothing in
 * Data is changed). Paths can be overridden with BLENDER and SKYRIM_DATA.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const WORK = path.join(HERE, '.work');
const DIST = path.join(HERE, 'dist');
const BLENDER = process.env.BLENDER || 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
const DATA = process.env.SKYRIM_DATA || 'E:\\SkyrimRP\\Skyrim Special Edition\\Data';
const CLIENT_MODS = path.join(REPO, 'skymp', 'client-mods');

/** Our own files, relative to Data/. Vanilla textures the model uses are not shipped. */
const SHIPPED = [
  require('./build-plugin').PLUGIN,
  'meshes/oathbound/holdstone.nif',
  'textures/oathbound/holdstone/holdstonerune.dds',
  'textures/oathbound/holdstone/holdstonerune_g.dds',
  'textures/oathbound/holdstone/holdstonerune_n.dds'
];

function run(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.map((a) => path.basename(a)).join(' ')}`);
  // PyNifly logs to stderr, so both streams are returned together.
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exited with ${r.status}:\n${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

function node(script, ...args) {
  process.stdout.write(run(process.execPath, [path.join(HERE, script), ...args]));
}

function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  const vanilla = path.join(WORK, 'vanilla');
  const build = path.join(WORK, 'build');

  // 1. Vanilla scaffolding NIFs (root, collision, glow shader) and the stone textures.
  for (const bsa of ['Skyrim - Meshes0.bsa', 'Skyrim - Meshes1.bsa']) {
    node('bsa.js', 'extract', path.join(DATA, bsa), 'dlc2standingstonesun\\.nif|tg08standingstone\\.nif', vanilla);
  }
  for (const bsa of fs.readdirSync(DATA).filter((f) => /^Skyrim - Textures\d+\.bsa$/i.test(f))) {
    node('bsa.js', 'extract', path.join(DATA, bsa), 'whstoneroughsurface|whtrimstone1', build);
  }
  // 2. Rune textures.
  node('make_dds.js', build);

  // 3. Model.
  const nif = path.join(DIST, 'meshes', 'oathbound', 'holdstone.nif');
  fs.mkdirSync(path.dirname(nif), { recursive: true });
  const out = run(BLENDER, ['-b', '--factory-startup', '-P', path.join(HERE, 'build_holdstone.py'), '--',
    WORK, nif, path.join(HERE, 'preview.png')]);
  if (!/EXPORT of .* completed SUCCESSFULLY/.test(out) || !fs.existsSync(nif)) {
    console.error(out.split('\n').filter((l) => /error|traceback|warning/i.test(l)).join('\n'));
    throw new Error('Blender export failed');
  }
  node('set_glow.js', nif);

  // 4. Textures and plugin.
  const texOut = path.join(DIST, 'textures', 'oathbound', 'holdstone');
  fs.mkdirSync(texOut, { recursive: true });
  for (const f of fs.readdirSync(path.join(build, 'textures', 'oathbound', 'holdstone')).filter((f) => f.endsWith('.dds'))) {
    fs.copyFileSync(path.join(build, 'textures', 'oathbound', 'holdstone', f), path.join(texOut, f));
  }
  node('build-plugin.js', path.join(DIST, require('./build-plugin').PLUGIN));

  if (process.argv.includes('--install')) {
    for (const rel of SHIPPED) {
      const dst = path.join(CLIENT_MODS, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(DIST, rel), dst);
      console.log(`installed ${rel}`);
    }
    console.log('Restart the server to publish it (it runs apps/game-api/scripts/sync-client-mods.js).');
  }
}

main();
