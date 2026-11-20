/**
 * core/keybinds.test.js
 *
 * Validation, tolerant reload and persistence of per-account keybinds, plus
 * the shape of migration-v30-account-keybinds.sql (the queries here must
 * match the table it creates).
 *
 * Executa com: node --test core/keybinds.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const keybinds = require('./keybinds');

const MIGRATION_PATH = path.resolve(__dirname, '..', '..', 'packages', 'database', 'migration-v30-account-keybinds.sql');

const valid = () => ({
  'panel.open': 60,
  'voice.pushToTalk': 47,
  'voice.cycleMode': 87,
  'voice.toggleMute': null,
  'chat.open': 28,
  'admin.open': 66
});

describe('keybinds: defaults', () => {
  it('F2 panel, V push-to-talk, F11 voice mode, mute unbound, Enter opens chat, F8 admin panel', () => {
    assert.deepStrictEqual(keybinds.defaultBindings(), valid());
  });

  it('defaults are themselves valid and bindable', () => {
    assert.deepStrictEqual(keybinds.validateBindings(keybinds.defaultBindings()), valid());
  });

  it('Escape and the console key are never bindable', () => {
    assert.ok(!keybinds.BINDABLE_CODES.has(1));
    assert.ok(!keybinds.BINDABLE_CODES.has(41));
  });
});

describe('keybinds: validateBindings (save requests)', () => {
  const rejects = (input, pattern) =>
    assert.throws(() => keybinds.validateBindings(input),
      (err) => err instanceof keybinds.KeybindValidationError && pattern.test(err.message));

  it('accepts a full valid map, including unbinding with null', () => {
    const input = { ...valid(), 'voice.cycleMode': null, 'voice.toggleMute': 50 };
    assert.deepStrictEqual(keybinds.validateBindings(input), input);
  });

  it('rejects non-objects, unknown and missing actions', () => {
    rejects(null, /object/);
    rejects([], /object/);
    rejects({ ...valid(), 'admin.ban': 30 }, /Unknown action/);
    const missing = valid(); delete missing['voice.cycleMode'];
    rejects(missing, /Missing action/);
  });

  it('rejects two actions on the same key', () => {
    rejects({ ...valid(), 'voice.toggleMute': 47 }, /same key/);
  });

  it('rejects Escape, console, mouse buttons, strings and fractions', () => {
    rejects({ ...valid(), 'panel.open': 1 }, /not allowed/);
    rejects({ ...valid(), 'panel.open': 41 }, /not allowed/);
    rejects({ ...valid(), 'panel.open': 256 }, /not allowed/);
    rejects({ ...valid(), 'panel.open': '60' }, /not allowed/);
    rejects({ ...valid(), 'panel.open': 60.5 }, /not allowed/);
  });
});

describe('keybinds: resolveStoredBindings (tolerant reload)', () => {
  it('missing/garbage rows fall back to defaults', () => {
    assert.deepStrictEqual(keybinds.resolveStoredBindings(null), valid());
    assert.deepStrictEqual(keybinds.resolveStoredBindings('x'), valid());
  });

  it('keeps valid choices, drops unknown actions, repairs invalid values', () => {
    const out = keybinds.resolveStoredBindings({
      'panel.open': 59, 'voice.pushToTalk': 1, 'old.action': 30
    });
    assert.strictEqual(out['panel.open'], 59);
    assert.strictEqual(out['voice.pushToTalk'], 47, 'invalid → default');
    assert.ok(!Object.hasOwn(out, 'old.action'));
  });

  it('an action added later starts unbound if its default key is already taken', () => {
    // Player moved push-to-talk to F11 before voice.cycleMode existed.
    const out = keybinds.resolveStoredBindings({ 'panel.open': 60, 'voice.pushToTalk': 87 });
    assert.strictEqual(out['voice.pushToTalk'], 87);
    assert.strictEqual(out['voice.cycleMode'], null);
  });

  it('never returns duplicate keys even from a corrupted row', () => {
    const out = keybinds.resolveStoredBindings({ 'panel.open': 47, 'voice.pushToTalk': 47 });
    const codes = Object.values(out).filter(v => v !== null);
    assert.strictEqual(new Set(codes).size, codes.length);
  });
});

describe('keybinds: persistence', () => {
  function fakeDb(rows = []) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => { calls.push({ sql, params }); return /^\s*SELECT/i.test(sql) ? rows : { affectedRows: 1 }; }
    };
  }

  it('load: no row = defaults; row = parsed and resolved', async () => {
    assert.deepStrictEqual(await keybinds.loadAccountBindings(fakeDb([]), 7), valid());
    const db = fakeDb([{ bindings_json: JSON.stringify({ ...valid(), 'panel.open': 59 }) }]);
    const out = await keybinds.loadAccountBindings(db, 7);
    assert.strictEqual(out['panel.open'], 59);
    assert.deepStrictEqual(db.calls[0].params, [7]);
  });

  it('load: unparseable JSON falls back to defaults instead of throwing', async () => {
    assert.deepStrictEqual(await keybinds.loadAccountBindings(fakeDb([{ bindings_json: '{oops' }]), 7), valid());
  });

  it('save upserts by account; reset deletes the row', async () => {
    const db = fakeDb();
    await keybinds.saveAccountBindings(db, 7, valid());
    assert.match(db.calls[0].sql, /INSERT INTO account_keybinds \(account_id, bindings_json\)/);
    assert.match(db.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
    assert.deepStrictEqual(db.calls[0].params, [7, JSON.stringify(valid())]);

    const defaults = await keybinds.resetAccountBindings(db, 7);
    assert.match(db.calls[1].sql, /DELETE FROM account_keybinds WHERE account_id = \?/);
    assert.deepStrictEqual(defaults, valid());
  });
});

describe('migration-v30-account-keybinds.sql', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  it('creates account_keybinds keyed by account, with the columns the code uses', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `account_keybinds`/);
    assert.match(sql, /`account_id` INT NOT NULL/);
    assert.match(sql, /`bindings_json` VARCHAR\(2000\) NOT NULL/);
    assert.match(sql, /PRIMARY KEY \(`account_id`\)/, 'ON DUPLICATE KEY UPDATE relies on this key');
  });

  it('cascades with the account and targets skymp_rp', () => {
    assert.match(sql, /REFERENCES `accounts` \(`id`\) ON DELETE CASCADE/);
    assert.match(sql, /USE `skymp_rp`;/);
  });
});
