#!/usr/bin/env node
/**
 * Writes OathboundHoldstone.esp: one activator, "Holdstone", using
 * meshes/oathbound/holdstone.nif. ESL-flagged (no full plugin slot used);
 * the patched server reads light plugins (patches/skymp/light-plugins.patch).
 *
 * The activator has no Papyrus script on purpose: the server sees every
 * activation through mp.onActivate, and holdstone-service.js opens the hold
 * menu for any reference registered as a holdstone.
 *
 * Usage: node build-plugin.js <out.esp>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN = 'OathboundHoldstone.esp';
/** Own records start at 0x800 (required for light plugins); index 01 = after the one master. */
const HOLDSTONE_FORM_ID = 0x01000800;
const EDITOR_ID = 'OBHoldstone';
const NAME = 'Holdstone';
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
  hedr.writeUInt32LE(1, 4);                              // records in the plugin
  hedr.writeUInt32LE((HOLDSTONE_FORM_ID & 0xfff) + 1, 8); // next object id
  const tes4 = record('TES4', FLAG_MASTER_LIGHT, 0, [
    field('HEDR', hedr),
    field('CNAM', zstring('OATHBOUND')),
    field('SNAM', zstring('Holdstone activator for the OATHBOUND holdstone system.')),
    field('MAST', zstring('Skyrim.esm')),
    field('DATA', Buffer.alloc(8))
  ]);

  const obnd = Buffer.alloc(12);
  BOUNDS.forEach((v, i) => obnd.writeInt16LE(v, i * 2));
  const acti = record('ACTI', 0, HOLDSTONE_FORM_ID, [
    field('EDID', zstring(EDITOR_ID)),
    field('OBND', obnd),
    field('FULL', zstring(NAME)),
    field('MODL', zstring(MODEL)),
    field('RNAM', zstring('Open'))
  ]);

  return Buffer.concat([tes4, group('ACTI', [acti])]);
}

module.exports = { build, PLUGIN, HOLDSTONE_FORM_ID, EDITOR_ID, MODEL };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'dist', PLUGIN);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build());
  console.log(`wrote ${out}`);
}
