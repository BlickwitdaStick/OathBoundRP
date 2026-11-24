const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseStaffRoleMap, staffRoleMapFromEnv, accessFor } = require('./memberAccess');

const WL = '100000000000000001';
const MOD = '200000000000000002';
const ADMIN = '300000000000000003';

test('the staff role map reads roleId:role pairs and refuses owner or bad ids', () => {
  const { map, errors } = parseStaffRoleMap(`${ADMIN}:admin, ${MOD}:moderator, ${MOD}1:owner, nope:admin`);
  assert.deepEqual([...map], [[ADMIN, 'admin'], [MOD, 'moderator']]);
  assert.equal(errors.length, 2);
  assert.match(errors.join(' '), /owner|staff role must be/);
});

test('without STAFF_ROLE_MAP, the existing STAFF_ROLE_ID grants moderator', () => {
  assert.deepEqual([...staffRoleMapFromEnv({ STAFF_ROLE_ID: MOD }).map], [[MOD, 'moderator']]);
  assert.deepEqual([...staffRoleMapFromEnv({ STAFF_ROLE_ID: MOD, STAFF_ROLE_MAP: `${ADMIN}:admin` }).map], [[ADMIN, 'admin']]);
  assert.equal(staffRoleMapFromEnv({}).map.size, 0);
});

test('access: the whitelist role whitelists; the strongest mapped staff role wins', () => {
  const staffRoleMap = new Map([[MOD, 'moderator'], [ADMIN, 'admin']]);
  assert.deepEqual(accessFor([WL], { whitelistRoleId: WL, staffRoleMap }), { whitelisted: true, staffRole: null });
  assert.deepEqual(accessFor([ADMIN, MOD], { whitelistRoleId: WL, staffRoleMap }), { whitelisted: false, staffRole: 'admin' });
  assert.deepEqual(accessFor([MOD, WL], { whitelistRoleId: WL, staffRoleMap }), { whitelisted: true, staffRole: 'moderator' });
  assert.deepEqual(accessFor([], { whitelistRoleId: WL, staffRoleMap }), { whitelisted: false, staffRole: null });
  assert.deepEqual(accessFor([WL], { whitelistRoleId: null, staffRoleMap }), { whitelisted: false, staffRole: null });
});
