'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseRpName, UNNAMED_LAST_NAME } = require('./commands');

describe('/rpname: naming a character', () => {
  it('takes a first and a last name and capitalises them', () => {
    assert.deepEqual(parseRpName(['hrolf', "stone-fist"]), { first: 'Hrolf', last: 'Stone-fist' });
    assert.deepEqual(parseRpName(['Ysolda', "O'Brien"]), { first: 'Ysolda', last: "O'Brien" });
  });

  it('refuses one word, three words, digits, symbols and the placeholder name', () => {
    assert.ok(parseRpName(['Hrolf']).error);
    assert.ok(parseRpName(['A', 'B', 'C']).error);
    assert.ok(parseRpName(['Hrolf2', 'Stone']).error);
    assert.ok(parseRpName(['<b>', 'Stone']).error);
    assert.ok(parseRpName(['Hrolf', UNNAMED_LAST_NAME.toLowerCase()]).error);
  });
});
