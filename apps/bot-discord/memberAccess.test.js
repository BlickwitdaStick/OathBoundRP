const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseStaffRoleMap, staffRoleMapFromEnv, whitelistRoleIdsFromEnv, accessFor } = require('./memberAccess');

// OATHBOUND's Discord roles.
const FOUNDER = '1573723345122238676';
const COUNCILOR = '1574603287737401414';
const STAFF = '1549808495216566322';
const MODERATOR = '1574603516217925843';
const ADVISOR = '1574603402141241535';
const TESTER = '1574603579744845824';
const SKYRIM_CITIZEN = '1574603661164679218';
const BRUMA_CITIZEN = '1574603775191027763';

const ENV = {
  STAFF_ROLE_MAP: `${FOUNDER}:owner,${COUNCILOR}:admin,${STAFF}:admin,${MODERATOR}:moderator`,
  WHITELIST_ROLE_IDS: `${SKYRIM_CITIZEN},${ADVISOR},${TESTER}`
};
const config = { staffRoleMap: staffRoleMapFromEnv(ENV).map, whitelistRoleIds: whitelistRoleIdsFromEnv(ENV).ids };

test('the staff role map reads roleId:role pairs and refuses unknown roles or bad ids', () => {
  const { map, errors } = parseStaffRoleMap(`${FOUNDER}:owner, ${MODERATOR}:moderator, ${STAFF}:god, nope:admin`);
  assert.deepEqual([...map], [[FOUNDER, 'owner'], [MODERATOR, 'moderator']]);
  assert.equal(errors.length, 2);
});

test('fallbacks: STAFF_ROLE_ID grants moderator, WHITELIST_ROLE_ID whitelists', () => {
  assert.deepEqual([...staffRoleMapFromEnv({ STAFF_ROLE_ID: MODERATOR }).map], [[MODERATOR, 'moderator']]);
  assert.equal(staffRoleMapFromEnv({}).map.size, 0);
  assert.deepEqual([...whitelistRoleIdsFromEnv({ WHITELIST_ROLE_ID: SKYRIM_CITIZEN }).ids], [SKYRIM_CITIZEN]);
  assert.deepEqual([...whitelistRoleIdsFromEnv({ WHITELIST_ROLE_ID: SKYRIM_CITIZEN, WHITELIST_ROLE_IDS: TESTER }).ids], [TESTER]);
});

test('OATHBOUND roles: Founder owner, Councilor and Staff admin, Moderator moderator', () => {
  assert.deepEqual(accessFor([FOUNDER], config), { whitelisted: true, staffRole: 'owner' });
  assert.deepEqual(accessFor([COUNCILOR], config), { whitelisted: true, staffRole: 'admin' });
  assert.deepEqual(accessFor([STAFF], config), { whitelisted: true, staffRole: 'admin' });
  assert.deepEqual(accessFor([MODERATOR], config), { whitelisted: true, staffRole: 'moderator' });
  assert.deepEqual(accessFor([MODERATOR, COUNCILOR, FOUNDER], config), { whitelisted: true, staffRole: 'owner' }, 'strongest wins');
});

test('OATHBOUND roles: Advisor, Tester and Skyrim Citizen play; Bruma Citizen does not', () => {
  for (const role of [ADVISOR, TESTER, SKYRIM_CITIZEN]) assert.deepEqual(accessFor([role], config), { whitelisted: true, staffRole: null });
  assert.deepEqual(accessFor([BRUMA_CITIZEN], config), { whitelisted: false, staffRole: null });
  assert.deepEqual(accessFor([], config), { whitelisted: false, staffRole: null });
});
