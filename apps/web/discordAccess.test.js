const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DISCORD_NOTE, fetchMemberAccess, applyMemberAccess, syncDiscordAccess } = require('./discordAccess');

/** In-memory stand-in for the three tables the sync touches. */
function fakeDb({ approved = false, staff = null } = {}) {
  const t = { apps: approved ? [{ status: 'approved' }] : [], staff, audit: [] };
  const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
  return {
    t,
    db: async (sql) => {
      const s = norm(sql);
      if (s.startsWith('SELECT id FROM whitelist_applications')) return t.apps.filter((a) => a.status === 'approved').map((_, i) => ({ id: i + 1 }));
      if (s.startsWith('SELECT role, notes FROM staff_roles')) return t.staff ? [t.staff] : [];
      throw new Error('unexpected read: ' + s);
    },
    execute: async (sql, p) => {
      const s = norm(sql);
      if (s.startsWith('INSERT INTO whitelist_applications')) { t.apps.push({ status: 'approved', reviewed_by: 'discord' }); return [{}]; }
      if (s.startsWith('INSERT INTO staff_roles')) { t.staff = { role: p[1], notes: p[2] }; return [{}]; }
      if (s.startsWith('UPDATE staff_roles SET role')) { t.staff.role = p[0]; return [{}]; }
      if (s.startsWith('DELETE FROM staff_roles')) { t.staff = null; return [{}]; }
      if (s.startsWith('INSERT INTO audit_logs')) { t.audit.push(p[0]); return [{}]; }
      throw new Error('unexpected write: ' + s);
    }
  };
}

const access = (o) => ({ inGuild: true, whitelisted: false, staffRole: null, ...o });

test('the Discord whitelist role approves the account once, and says so in the audit log', async () => {
  const f = fakeDb();
  const r = await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: access({ whitelisted: true }) });
  assert.deepEqual(r.changes, ['whitelisted']);
  assert.equal(f.t.apps.length, 1);
  assert.deepEqual(f.t.audit, ['whitelist:discord_grant']);
  const again = await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: access({ whitelisted: true }) });
  assert.deepEqual(again.changes, []);
});

test('losing the whitelist role does not take the whitelist away', async () => {
  const f = fakeDb({ approved: true });
  await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: access({ whitelisted: false }) });
  assert.equal(f.t.apps.length, 1);
});

test('a Discord staff role grants, changes and removes only rows the sync made', async () => {
  const f = fakeDb();
  await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: access({ staffRole: 'moderator' }) });
  assert.deepEqual(f.t.staff, { role: 'moderator', notes: DISCORD_NOTE });
  await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: access({ staffRole: 'admin' }) });
  assert.equal(f.t.staff.role, 'admin');
  await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: access({ staffRole: null }) });
  assert.equal(f.t.staff, null);
  assert.deepEqual(f.t.audit, ['staff:discord_grant', 'staff:discord_change', 'staff:discord_revoke']);
});

test('leaving the Discord server removes a Discord-granted staff role', async () => {
  const f = fakeDb({ staff: { role: 'admin', notes: DISCORD_NOTE } });
  await applyMemberAccess({ db: f.db, execute: f.execute, accountId: 5, access: { inGuild: false, whitelisted: false, staffRole: 'admin' } });
  assert.equal(f.t.staff, null);
});

test('hand-set roles and owners are never touched', async () => {
  const manual = fakeDb({ staff: { role: 'moderator', notes: null } });
  await applyMemberAccess({ db: manual.db, execute: manual.execute, accountId: 5, access: access({ staffRole: null }) });
  await applyMemberAccess({ db: manual.db, execute: manual.execute, accountId: 5, access: access({ staffRole: 'admin' }) });
  assert.deepEqual(manual.t.staff, { role: 'moderator', notes: null });

  const owner = fakeDb({ staff: { role: 'owner', notes: DISCORD_NOTE } });
  await applyMemberAccess({ db: owner.db, execute: owner.execute, accountId: 1, access: { inGuild: false, whitelisted: false, staffRole: null } });
  assert.equal(owner.t.staff.role, 'owner');
  assert.deepEqual([...manual.t.audit, ...owner.t.audit], []);
});

test('bot unreachable or answering nonsense: nothing changes and sign-in carries on', async () => {
  const f = fakeDb({ staff: { role: 'admin', notes: DISCORD_NOTE } });
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const r = await syncDiscordAccess({ db: f.db, execute: f.execute, accountId: 5, discordId: '123456789012345678', botUrl: 'http://bot', secret: 's', fetchImpl: down, logger: { log() {}, error() {} } });
  assert.deepEqual(r, { synced: false, changes: [] });
  assert.deepEqual(f.t.staff, { role: 'admin', notes: DISCORD_NOTE });

  const weird = async () => ({ ok: true, json: async () => ({ staffRole: 'owner' }) });
  assert.equal(await fetchMemberAccess({ botUrl: 'http://bot', secret: 's', discordId: '1', fetchImpl: weird }), null);
  const ownerClaim = async () => ({ ok: true, json: async () => ({ inGuild: true, whitelisted: true, staffRole: 'owner' }) });
  assert.deepEqual(await fetchMemberAccess({ botUrl: 'http://bot', secret: 's', discordId: '1', fetchImpl: ownerClaim }),
    { inGuild: true, whitelisted: true, staffRole: null }, 'owner can never come from Discord');
});

test('the request to the bot carries the internal secret and the id in the body', async () => {
  let seen = null;
  const spy = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ inGuild: true, whitelisted: false, staffRole: 'moderator' }) }; };
  const r = await fetchMemberAccess({ botUrl: 'http://bot:3002', secret: 'sekret', discordId: '123456789012345678', fetchImpl: spy });
  assert.equal(r.staffRole, 'moderator');
  assert.equal(seen.url, 'http://bot:3002/api/member-access');
  assert.equal(seen.init.headers['X-Internal-Secret'], 'sekret');
  assert.deepEqual(JSON.parse(seen.init.body), { discord_id: '123456789012345678' });
});
