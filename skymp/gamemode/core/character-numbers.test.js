const { describe, it } = require('node:test');
const assert = require('node:assert');
const cn = require('./character-numbers');

describe('character numbers: parsing', () => {
  it('accepts 12 and #12, rejects anything else', () => {
    assert.equal(cn.parseCharacterNumber('12'), 12);
    assert.equal(cn.parseCharacterNumber('#12'), 12);
    assert.equal(cn.parseCharacterNumber('5000'), 5000);
    for (const bad of ['0', '5001', 'ff', '0x12', '-1', '1.5', '', 'abc']) {
      assert.equal(cn.parseCharacterNumber(bad), null, bad);
    }
  });

  it('lowest free number fills gaps first', () => {
    assert.equal(cn.lowestFree([]), 1);
    assert.equal(cn.lowestFree([1, 2, 4]), 3);
    assert.equal(cn.lowestFree([2, 3]), 1);
  });
});

describe('character numbers: command arguments', () => {
  const online = new Map([[12, 0xff000a3c], [7, 0xff000001]]);
  const byNumber = (n) => online.get(n) || null;

  it('rewrites player slots to 0x actorIds and leaves the rest alone', () => {
    const r = cn.resolveTargetArgs('/fine <player#> <amount> <reason>', '#12 50 theft of 7 apples', byNumber);
    assert.equal(r.args, '0xff000a3c 50 theft of 7 apples');
  });

  it('keeps a raw 0x actorId (staff copying from a log)', () => {
    const r = cn.resolveTargetArgs('/tp <player#>', '0xff000abc', byNumber);
    assert.equal(r.args, '0xff000abc');
  });

  it('treats the legacy <actorId> slot name as a player slot', () => {
    const r = cn.resolveTargetArgs('/record <actorId>', '7', byNumber);
    assert.equal(r.args, '0xff000001');
  });

  it('explains an offline number and a non-number', () => {
    assert.match(cn.resolveTargetArgs('/tp <player#>', '99', byNumber).error, /No one with number #99 is online/);
    assert.match(cn.resolveTargetArgs('/tp <player#>', 'Merric', byNumber).error, /not a character number/);
  });

  it('only touches player slots, even when other slots are numeric', () => {
    const r = cn.resolveTargetArgs('/shopregister <cityId> <shopId> <owner#> <name>', '3 4 12 The Mare', byNumber);
    assert.equal(r.args, '3 4 0xff000a3c The Mare');
  });
});

describe('character numbers: assignment', () => {
  function fakeDb(rows) {
    return {
      rows,
      async query(sql, params) {
        if (sql.startsWith('SELECT char_number FROM characters WHERE char_number')) {
          return this.rows.filter((r) => r.char_number != null).map((r) => ({ char_number: r.char_number }));
        }
        if (sql.startsWith('UPDATE characters SET char_number = ? WHERE id = ? AND')) {
          const [n, id] = params;
          if (this.rows.some((r) => r.char_number === n)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
          const row = this.rows.find((r) => r.id === id && r.char_number == null);
          if (!row) return { affectedRows: 0 };
          row.char_number = n;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE characters SET char_number = NULL')) {
          this.rows.find((r) => r.id === params[0]).char_number = null;
          return { affectedRows: 1 };
        }
        throw new Error('unexpected ' + sql);
      }
    };
  }

  it('keeps an existing number', async () => {
    assert.equal(await cn.ensureNumber(fakeDb([]), 1, 33), 33);
  });

  it('assigns the lowest free number, and a released number is reused', async () => {
    const db = fakeDb([{ id: 1, char_number: 1 }, { id: 2, char_number: 2 }, { id: 3, char_number: null }]);
    assert.equal(await cn.ensureNumber(db, 3, null), 3);
    await cn.releaseNumber(db, 1);
    db.rows.push({ id: 4, char_number: null });
    assert.equal(await cn.ensureNumber(db, 4, null), 1);
  });
});
