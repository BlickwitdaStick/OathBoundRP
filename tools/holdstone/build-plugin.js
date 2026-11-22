#!/usr/bin/env node
/**
 * Writes Oathbound_Holdstone.esp: one activator per holdstone listed in
 * skymp/gamemode/data/holdstones.json ("Whiterun Holdstone", "High Hrothgar
 * Holdstone"...), all using meshes/oathbound/holdstone.nif, plus the old
 * generic "Holdstone" (800) so stones already in the world keep working.
 * ESL-flagged (no full plugin slot used); the patched server reads light
 * plugins (patches/skymp/light-plugins.patch).
 *
 * The activators have no Papyrus script on purpose: the server sees every
 * activation through mp.onActivate, and holdstone-service.js knows which
 * organization a stone belongs to from its activator (base record), so a
 * stone placed in the Creation Kit needs nothing in game.
 *
 * Usage: node build-plugin.js <out.esp>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STONES_FILE = path.join(__dirname, '..', '..', 'skymp', 'gamemode', 'data', 'holdstones.json');
const STONES = JSON.parse(fs.readFileSync(STONES_FILE, 'utf8'));
const PLUGIN = STONES.plugin;
/** Own records start at 0x800 (required for light plugins); index 01 = after the one master. */
const HOLDSTONE_FORM_ID = 0x01000800;
const EDITOR_ID = 'OBHoldstone';
const NAME = 'Holdstone';

/** Every activator: the generic one, then one per stone (formId from holdstones.json). */
function activators() {
  const list = [{ formId: HOLDSTONE_FORM_ID, editorId: EDITOR_ID, name: NAME }];
  const seen = new Set([0x800]);
  for (const stone of STONES.stones) {
    const local = parseInt(stone.formId, 16);
    if (!(local > 0x800 && local <= 0xfff) || seen.has(local)) {
      throw new Error(`holdstones.json: ${stone.id} has a bad or repeated formId ${stone.formId}`);
    }
    seen.add(local);
    list.push({ formId: 0x01000000 | local, editorId: stone.editorId, name: `${stone.name} Holdstone` });
  }
  return list;
}
const MODEL = 'oathbound\\holdstone.nif';
/** Bounds of the mesh in game units: plinth 152 wide, top of the stone at 204. */
const BOUNDS = [-76, -76, -14, 76, 76, 204];

const FLAG_MASTER_LIGHT = 0x200;
const FORM_VERSION = 44;

function zstring(s) {
  return Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);
}

function field(type, data) {
  const head = Buffer.alloc(6);
  head.write(type, 0, 'latin1');
  head.writeUInt16LE(data.length, 4);
  return Buffer.concat([head, data]);
}

function record(type, flags, formId, fields) {
  const data = Buffer.concat(fields);
  const head = Buffer.alloc(24);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  head.writeUInt32LE(flags, 8);
  head.writeUInt32LE(formId, 12);
  head.writeUInt16LE(FORM_VERSION, 20);
  return Buffer.concat([head, data]);
}

function group(label, records) {
  const data = Buffer.concat(records);
  const head = Buffer.alloc(24);
  head.write('GRUP', 0, 'latin1');
  head.writeUInt32LE(24 + data.length, 4);
  head.write(label, 8, 'latin1');
  head.writeUInt32LE(0, 12); // top-level group
  return Buffer.concat([head, data]);
}

function build() {
  const hedr = Buffer.alloc(12);
  hedr.writeFloatLE(1.71, 0);
  const all = activators();
  const maxLocal = Math.max(...all.map((a) => a.formId & 0xfff));
  hedr.writeUInt32LE(all.length, 4);   // records in the plugin
  hedr.writeUInt32LE(maxLocal + 1, 8); // next object id
  const tes4 = record('TES4', FLAG_MASTER_LIGHT, 0, [
    field('HEDR', hedr),
    field('CNAM', zstring('OATHBOUND')),
    field('SNAM', zstring('Holdstone activators for the OATHBOUND holdstone system, one per stone.')),
    field('MAST', zstring('Skyrim.esm')),
    field('DATA', Buffer.alloc(8))
  ]);

  const obnd = Buffer.alloc(12);
  BOUNDS.forEach((v, i) => obnd.writeInt16LE(v, i * 2));
  const records = all.map((a) => record('ACTI', 0, a.formId, [
    field('EDID', zstring(a.editorId)),
    field('OBND', obnd),
    field('FULL', zstring(a.name)),
    field('MODL', zstring(MODEL)),
    field('RNAM', zstring('Open'))
  ]));

  return Buffer.concat([tes4, group('ACTI', records)]);
}

module.exports = { build, activators, PLUGIN, HOLDSTONE_FORM_ID, EDITOR_ID, MODEL };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'dist', PLUGIN);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build());
  console.log(`wrote ${out}`);
}
