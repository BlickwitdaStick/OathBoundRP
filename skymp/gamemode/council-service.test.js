'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const council = require('./council-service');

const STAFF = 0xff000001;
const ADVISOR = 0xff000002;
const PLAYER = 0xff000003;

function setup() {
  const t = { summons: [], shouts: [], nextId: 1 };
  const notes = [];
  const discord = [];
  const sets = [];
  const locs = new Map([
    [STAFF, { cellOrWorldDesc: '3c:Skyrim.esm', pos: [100, 200, 300], rot: [0, 0, 0] }],
    [ADVISOR, { cellOrWorldDesc: 'abc:Skyrim.esm', pos: [10, 20, 30], rot: [0, 0, 90] }]
  ]);
  const chars = new Map([
    [STAFF, { characterId: 1, firstName: 'Staff', lastName: 'One', accountId: 11 }],
    [ADVISOR, { characterId: 2, firstName: 'Ada', lastName: 'Visor', accountId: 12 }],
    [PLAYER, { characterId: 3, firstName: 'Pia', lastName: 'Player', accountId: 13 }]
  ]);
  const sql = (s) => s.replace(/\s+/g, ' ').trim();
  const db = {
    async query(raw, p = []) {
      const s = sql(raw);
      if (s.startsWith("SELECT id FROM council_summons WHERE character_id")) return t.summons.filter((r) => r.character_id === p[0] && r.status === 'open');
      if (s.startsWith('INSERT INTO council_summons')) {
        const row = { id: t.nextId++, character_id: p[0], org_id: p[1], reason: p[2], status: 'open' };
        t.summons.push(row);
        return { insertId: row.id };
      }
      if (s.startsWith("SELECT character_id FROM council_summons WHERE id")) return t.summons.filter((r) => r.id === p[0] && r.status === 'open');
      if (s.startsWith("UPDATE council_summons SET status = 'unanswered'")) { t.summons.find((r) => r.id === p[0]).status = 'unanswered'; return {}; }
      if (s.startsWith('SELECT id, character_id, reason FROM council_summons')) return t.summons.filter((r) => r.id === p[0] && r.status === 'open');
      if (s.startsWith("UPDATE council_summons SET status = 'answered'")) {
        Object.assign(t.summons.find((r) => r.id === p[1]), { status: 'answered', answered_by_account_id: p[0] });
        return {};
      }
      if (s.startsWith('UPDATE council_summons SET outcome')) {
        const row = t.summons.find((r) => r.status === 'answered' && r.answered_by_account_id === p[1] && !r.outcome);
        if (row) row.outcome = p[0];
        return {};
      }
      if (s.startsWith('INSERT INTO character_shouts')) {
        if (!t.shouts.some((r) => r.character_id === p[0] && r.word_desc === p[1])) t.shouts.push({ character_id: p[0], word_desc: p[1], shout_desc: p[2] });
        return {};
      }
      if (s.startsWith('DELETE FROM character_shouts')) { t.shouts = t.shouts.filter((r) => !(r.character_id === p[0] && r.shout_desc === p[1])); return {}; }
      if (s.startsWith('SELECT word_desc, shout_desc FROM character_shouts')) return t.shouts.filter((r) => r.character_id === p[0]);
      throw new Error(`fake db: unhandled SQL: ${s}`);
    }
  };
  council.configure({
    db,
    commands: {
      sendNotification: (actorId, text) => notes.push({ actorId, text }),
      listActiveActorIds: () => [...chars.keys()],
      getActiveCharacterData: (id) => chars.get(id) || null,
      getActiveActorByCharacterId: (cid) => [...chars].find(([, c]) => c.characterId === cid)?.[0] || null
    },
    isStaff: (id) => id === STAFF,
    titlesOf: (cid) => (cid === 2 ? ['Advisor of Whiterun'] : []),
    notifyDiscord: (e) => discord.push(e),
    mp: {
      get: (id, prop) => (prop === 'locationalData' ? locs.get(id) : undefined),
      set: (id, prop, v) => { sets.push({ id, prop, v }); if (prop === 'locationalData') locs.set(id, v); },
      getIdFromDesc: (desc) => parseInt(desc.split(':')[0], 16)
    },
    now: () => 1000,
    logger: { log() {}, error() {} }
  });
  return { t, notes, discord, sets, locs };
}

describe('council-service: summons', () => {
  let env;
  beforeEach(() => { env = setup(); });
  afterEach(() => council._resetForTest());

  it('an Advisor summons: staff are alerted in game and on Discord', async () => {
    const r = await council.summon({ actorId: ADVISOR, characterId: 2, advisedOrgId: 'whiterun', reason: 'The Jarl has fallen' });
    assert.equal(r.ok, true);
    assert.ok(env.notes.some((n) => n.actorId === STAFF && /Summons #1: Ada Visor, Advisor of Whiterun .*The Jarl has fallen.*\/answer 1/.test(n.text)));
    assert.equal(env.discord[0].kind, 'council_summons');
  });

  it('only Advisors (or staff) can summon, with a reason, one open summons at a time', async () => {
    assert.equal((await council.summon({ actorId: PLAYER, characterId: 3, advisedOrgId: null, reason: 'hello there' })).ok, false);
    assert.equal((await council.summon({ actorId: ADVISOR, characterId: 2, advisedOrgId: 'whiterun', reason: 'x' })).ok, false);
    await council.summon({ actorId: ADVISOR, characterId: 2, advisedOrgId: 'whiterun', reason: 'first' });
    const again = await council.summon({ actorId: ADVISOR, characterId: 2, advisedOrgId: 'whiterun', reason: 'second' });
    assert.match(again.message, /still waits/);
  });

  it('answering moves the Councilor beside the Advisor, /return brings them back with the outcome', async () => {
    await council.summon({ actorId: ADVISOR, characterId: 2, advisedOrgId: 'whiterun', reason: 'Help' });
    const r = await council.answer(STAFF, 1);
    assert.equal(r.ok, true);
    assert.deepEqual(env.locs.get(STAFF).pos, [90, 100, 30]);
    assert.equal(env.locs.get(STAFF).cellOrWorldDesc, 'abc:Skyrim.esm');
    assert.equal(env.t.summons[0].status, 'answered');
    assert.ok(env.notes.some((n) => n.actorId === ADVISOR && /Councilor of the Ancients answers/.test(n.text)));
    const back = await council.returnFromSummons(STAFF, 'Steward named regent');
    assert.equal(back.ok, true);
    assert.deepEqual(env.locs.get(STAFF).pos, [100, 200, 300]);
    assert.equal(env.t.summons[0].outcome, 'Steward named regent');
  });

  it('non-staff cannot answer; an unanswered summons expires and tells the Advisor', async () => {
    await council.summon({ actorId: ADVISOR, characterId: 2, advisedOrgId: 'whiterun', reason: 'Help' });
    assert.equal((await council.answer(PLAYER, 1)).ok, false);
    assert.equal(await council.expire(1), true);
    assert.equal(env.t.summons[0].status, 'unanswered');
    assert.ok(env.notes.some((n) => n.actorId === ADVISOR && /went unanswered/.test(n.text)));
  });
});

describe('council-service: shouts', () => {
  let env;
  beforeEach(() => { env = setup(); });
  afterEach(() => council._resetForTest());

  it('the catalog holds player shouts and no dragon shouts', () => {
    const keys = [...council.shoutCatalog().keys()];
    assert.ok(keys.includes('unrelenting_force'));
    assert.ok(keys.includes('dragon_aspect'));
    for (const banned of ['call_dragon', 'dragonrend', 'summon_durnehviir']) assert.ok(!keys.includes(banned), banned);
    for (const s of council.shoutCatalog().values()) assert.equal(s.words.length, 3, s.key);
  });

  it('granting words saves them and sends them to the player', async () => {
    const r = await council.grantShout(11, 3, 'Unrelenting Force', 2, 'Saved the Jarl');
    assert.equal(r.ok, true);
    assert.equal(env.t.shouts.length, 2);
    const sent = env.sets.find((s) => s.id === PLAYER && s.prop === council.SHOUTS_PROPERTY);
    assert.equal(sent.v.shouts.length, 1);
    assert.equal(sent.v.shouts[0].words.length, 2);
  });

  it('unknown shouts are refused; revoking removes every word', async () => {
    assert.equal((await council.grantShout(11, 3, 'Call Dragon', 3)).ok, false);
    await council.grantShout(11, 3, 'ice_form', 3);
    await council.revokeShout(3, 'ice form');
    assert.equal(env.t.shouts.length, 0);
  });

  it('the client snippet teaches, unlocks and adds the shout, and removes one no longer granted', () => {
    const calls = [];
    const word = { kind: 'word' };
    const shout = { kind: 'shout' };
    const player = {
      hasSpell: () => false,
      addShout: (s) => calls.push(['add', s]),
      removeShout: (s) => calls.push(['remove', s])
    };
    const ctx = {
      state: {},
      value: { sentAt: 1, shouts: [{ shout: 500, words: [501, 502] }] },
      sp: {
        Game: { getPlayer: () => player, getFormEx: (id) => id, teachWord: (w) => calls.push(['teach', w]), unlockWord: (w) => calls.push(['unlock', w]) },
        WordOfPower: { from: () => word },
        Shout: { from: () => shout }
      }
    };
    const run = new Function('ctx', council.SHOUTS_UPDATE_OWNER);
    run(ctx);
    assert.deepEqual(calls.map((c) => c[0]), ['teach', 'unlock', 'teach', 'unlock', 'add']);
    calls.length = 0;
    run(ctx);
    assert.equal(calls.length, 0, 'same value: nothing again');
    ctx.value = { sentAt: 2, shouts: [] };
    run(ctx);
    assert.deepEqual(calls.map((c) => c[0]), ['remove']);
  });
});
