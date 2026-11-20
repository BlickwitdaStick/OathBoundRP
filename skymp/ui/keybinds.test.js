'use strict';

/**
 * ui/keybinds.js must agree with the server (gamemode/core/keybinds.js):
 * same action ids in the same order, and every key the UI can produce must
 * be one the server accepts. Also covers the rebind conflict rule.
 */

const assert = require('assert');
const { test } = require('node:test');
const ui = require('./keybinds.js');
const server = require('../gamemode/core/keybinds.js');

test('UI actions match the server actions (ids and order)', () => {
  assert.deepStrictEqual(ui.ACTIONS.map(a => a.id), [...server.ACTION_IDS]);
});

test('every key the UI can capture is bindable on the server, and vice versa', () => {
  const uiCodes = new Set(Object.values(ui.DOM_KEYS).map(([code]) => code));
  for (const code of uiCodes) assert.ok(server.BINDABLE_CODES.has(code), `server refuses UI code ${code}`);
  for (const code of server.BINDABLE_CODES) assert.ok(uiCodes.has(code), `UI cannot capture server code ${code}`);
});

test('Escape and the console key cannot be captured', () => {
  assert.strictEqual(ui.scanCodeFromDomCode('Escape'), null);
  assert.strictEqual(ui.scanCodeFromDomCode('Backquote'), null);
});

test('labels for the defaults read naturally', () => {
  const d = server.defaultBindings();
  assert.strictEqual(ui.keyLabel(d['panel.open']), 'F2');
  assert.strictEqual(ui.keyLabel(d['voice.pushToTalk']), 'V');
  assert.strictEqual(ui.keyLabel(d['voice.cycleMode']), 'F11');
  assert.strictEqual(ui.keyLabel(d['voice.toggleMute']), 'Unbound');
});

test('browser key codes map to the DxScanCode the game reports', () => {
  assert.strictEqual(ui.scanCodeFromDomCode('KeyV'), 47);
  assert.strictEqual(ui.scanCodeFromDomCode('F11'), 87);
  assert.strictEqual(ui.scanCodeFromDomCode('F2'), 60);
  assert.strictEqual(ui.scanCodeFromDomCode('NumpadEnter'), 156);
  assert.strictEqual(ui.scanCodeFromDomCode('ArrowUp'), 200);
  assert.strictEqual(ui.scanCodeFromDomCode('NotAKey'), null);
});

test('assignKey moves a key off the action that had it (server rejects duplicates)', () => {
  const draft = server.defaultBindings();
  const { draft: next, movedFrom } = ui.assignKey(draft, 'voice.toggleMute', 47);
  assert.strictEqual(next['voice.toggleMute'], 47);
  assert.strictEqual(next['voice.pushToTalk'], null);
  assert.strictEqual(movedFrom, 'voice.pushToTalk');
  assert.deepStrictEqual(server.validateBindings(next), next, 'result is always savable');
  assert.strictEqual(draft['voice.pushToTalk'], 47, 'original draft untouched');
});

test('sameBindings compares every action', () => {
  const a = server.defaultBindings();
  assert.ok(ui.sameBindings(a, { ...a }));
  assert.ok(!ui.sameBindings(a, { ...a, 'panel.open': 59 }));
  assert.ok(!ui.sameBindings(a, null));
});

test('UI fallback defaults equal the server defaults', () => {
  assert.deepStrictEqual(ui.DEFAULT_BINDINGS, server.defaultBindings());
});
