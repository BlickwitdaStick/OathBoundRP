/**
 * council-service.js — the Council of High Hrothgar (OATHBOUND RP Design, phase 1)
 *
 * The Council is the staff. Their ancient magic is tied to the stones:
 *
 * - Summons: an Advisor uses the High Hrothgar stone ("Summon the Council",
 *   holdstone-service.js) with a reason. Every online Councilor is alerted in
 *   game, and the staff Discord when the bot is configured. A Councilor
 *   answers with /answer <id> and appears at the stone, beside the Advisor;
 *   /return takes them back to where they were. A summons nobody answers in
 *   15 minutes is marked unanswered and the Advisor is told.
 * - Shouts: only the Council grants them (/grantshout). SkyMP does not save
 *   learned words of power, so they are kept in `character_shouts` and taught
 *   again to the player's game at every login (the `councilShouts` property).
 *
 * Tables: migration-v42-council-advisors-shouts.sql.
 */

'use strict';

const path = require('path');

const MODULE_ID = 'council';
const SUMMONS_TTL_MS = 15 * 60 * 1000;
const SHOUTS_PROPERTY = 'councilShouts';
const COUNCILOR_TITLE = 'Councilor of the Ancients';
const LOGIN_SWEEP_MS = 3000;

let _deps = null;
let _shouts = null;
const _returnPoints = new Map(); // staff actorId → locationalData before answering
const _expiry = new Map(); // summons id → timer
const _shoutsSent = new Map(); // actorId → characterId the shouts were sent for
let _sweep = null;

function _defaultDeps() {
  return {
    db: require('./database'),
    commands: require('./commands'),
    isStaff: (actorId) => {
      try { return Boolean(require('./admin-service').getRole(actorId)); } catch { return false; }
    },
    titlesOf: (characterId) => {
      try { return require('./holdstone-service').titlesOf(characterId); } catch { return []; }
    },
    notifyDiscord: (event) => {
      try { require('./core/moderation-log').notify(event); } catch { /* optional */ }
    },
    mp: typeof mp !== 'undefined' ? mp : null,
    now: () => Date.now(),
    logger: console
  };
}

function configure(overrides = {}) {
  _deps = { ...(_deps || _defaultDeps()), ...overrides };
  return _deps;
}

function deps() {
  return _deps || configure();
}

function say(actorId, text) {
  try { deps().commands.sendNotification(actorId, text); } catch { /* player gone */ }
}

const ok = (message, extra = {}) => ({ ok: true, message, ...extra });
const no = (message) => ({ ok: false, message });

function displayName(characterId, fallback) {
  const titles = deps().titlesOf(characterId);
  return titles.length ? `${fallback}, ${titles[0]}` : fallback;
}

function onlineStaff() {
  const { commands, isStaff } = deps();
  return commands.listActiveActorIds().filter((id) => isStaff(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Summons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An Advisor (or staff) calls the Council from the High Hrothgar stone.
 * @returns {Promise<{ok:boolean, message:string, id?:number}>}
 */
async function summon({ actorId, characterId, advisedOrgId, reason }) {
  const d = deps();
  const text = String(reason || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  if (text.length < 3) return no('Say why you summon the Council.');
  if (!advisedOrgId && !d.isStaff(actorId)) return no('Only an Advisor can summon the Council.');
  const open = await d.db.query("SELECT id FROM council_summons WHERE character_id = ? AND status = 'open'", [characterId]);
  if (open.length) return no(`Your summons #${open[0].id} still waits for an answer.`);

  const res = await d.db.query(
    'INSERT INTO council_summons (character_id, org_id, reason) VALUES (?, ?, ?)',
    [characterId, advisedOrgId || null, text]
  );
  const id = Number(res.insertId);
  const ch = d.commands.getActiveCharacterData(actorId);
  const who = displayName(characterId, ch ? `${ch.firstName} ${ch.lastName}` : `character ${characterId}`);

  const staff = onlineStaff();
  for (const s of staff) say(s, `[Council] Summons #${id}: ${who} calls the Council at High Hrothgar: "${text}". /answer ${id}`);
  d.notifyDiscord({ kind: 'council_summons', target: who, reason: `#${id}: ${text}` });

  const timer = setTimeout(() => { expire(id).catch((err) => d.logger.error('[council] expire failed:', err.message)); }, SUMMONS_TTL_MS);
  if (timer.unref) timer.unref();
  _expiry.set(id, timer);
  d.logger.log(`[council] summons #${id} by character ${characterId} (${advisedOrgId || 'staff'}): ${text}`);
  return ok(staff.length
    ? 'The stone hums. The Council has heard you.'
    : 'The stone hums, but no Councilor answers now. Your summons is recorded.', { id });
}

async function expire(id) {
  const d = deps();
  _expiry.delete(id);
  const rows = await d.db.query("SELECT character_id FROM council_summons WHERE id = ? AND status = 'open'", [id]);
  if (!rows.length) return false;
  await d.db.query("UPDATE council_summons SET status = 'unanswered' WHERE id = ?", [id]);
  const actor = d.commands.getActiveActorByCharacterId(Number(rows[0].character_id));
  if (actor) say(actor, `[Council] Your summons #${id} went unanswered. Try again later, or bring a petition.`);
  return true;
}

/** A Councilor answers: saves where they stand, then appears beside the summoner at the stone. */
async function answer(staffActorId, id) {
  const d = deps();
  if (!d.isStaff(staffActorId)) return no('Only the Council answers summons.');
  const rows = await d.db.query("SELECT id, character_id, reason FROM council_summons WHERE id = ? AND status = 'open'", [id]);
  if (!rows.length) return no(`No open summons #${id}. (/summons lists them.)`);
  const summoner = d.commands.getActiveActorByCharacterId(Number(rows[0].character_id));
  if (!summoner) return no(`The one who summoned (#${id}) is no longer here.`);
  const api = d.mp;
  if (!api) return no('The world is not loaded.');
  let there;
  let here;
  try {
    there = api.get(summoner, 'locationalData');
    here = api.get(staffActorId, 'locationalData');
  } catch (err) {
    return no(`Could not reach them: ${err.message}`);
  }
  if (!there || !there.cellOrWorldDesc) return no('Could not find where they stand.');
  if (!_returnPoints.has(staffActorId) && here) _returnPoints.set(staffActorId, here);
  api.set(staffActorId, 'locationalData', {
    cellOrWorldDesc: there.cellOrWorldDesc,
    pos: [there.pos[0] + 80, there.pos[1] + 80, there.pos[2]],
    rot: there.rot || [0, 0, 0]
  });
  const staffChar = d.commands.getActiveCharacterData(staffActorId);
  await d.db.query(
    "UPDATE council_summons SET status = 'answered', answered_by_account_id = ?, answered_at = NOW() WHERE id = ?",
    [staffChar ? staffChar.accountId : null, id]
  );
  const timer = _expiry.get(id);
  if (timer) clearTimeout(timer);
  _expiry.delete(id);
  say(summoner, '[Council] The air bends. A Councilor of the Ancients answers your summons.');
  for (const s of onlineStaff()) if (s !== staffActorId) say(s, `[Council] Summons #${id} was answered.`);
  d.notifyDiscord({ kind: 'council_answered', target: `Summons #${id}`, moderator: staffChar ? `${staffChar.firstName} ${staffChar.lastName}` : null, reason: rows[0].reason });
  return ok(`You answer summons #${id}. /return takes you back when you are done.`);
}

/** Takes a Councilor back to where they stood before answering, and records the outcome. */
async function returnFromSummons(staffActorId, outcome) {
  const d = deps();
  const back = _returnPoints.get(staffActorId);
  if (!back) return no('You have nowhere to return to.');
  _returnPoints.delete(staffActorId);
  d.mp.set(staffActorId, 'locationalData', back);
  const text = String(outcome || '').trim().slice(0, 255);
  if (text) {
    const staffChar = d.commands.getActiveCharacterData(staffActorId);
    await d.db.query(
      "UPDATE council_summons SET outcome = ? WHERE answered_by_account_id = ? AND status = 'answered' AND outcome IS NULL ORDER BY answered_at DESC LIMIT 1",
      [text, staffChar ? staffChar.accountId : null]
    );
  }
  return ok('You return to where you were.');
}

async function openSummons() {
  return deps().db.query(
    `SELECT s.id, s.reason, s.created_at, c.first_name, c.last_name FROM council_summons s
       JOIN characters c ON c.id = s.character_id WHERE s.status = 'open' ORDER BY s.id`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shouts
// ─────────────────────────────────────────────────────────────────────────────

function shoutCatalog() {
  if (!_shouts) {
    const file = require(path.join(__dirname, 'data', 'shouts.json'));
    _shouts = new Map(file.shouts.map((s) => [s.key, s]));
  }
  return _shouts;
}

function findShout(text) {
  const key = String(text || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return shoutCatalog().get(key) || null;
}

/** Grants a character the first `words` (1-3) words of a shout. */
async function grantShout(staffAccountId, characterId, shoutKey, words, reason) {
  const d = deps();
  const shout = findShout(shoutKey);
  if (!shout) return no(`Unknown shout "${shoutKey}". Shouts: ${[...shoutCatalog().keys()].join(', ')}`);
  const count = Math.max(1, Math.min(3, Number(words) || 1));
  for (const word of shout.words.slice(0, count)) {
    await d.db.query(
      `INSERT INTO character_shouts (character_id, word_desc, shout_desc, granted_by_account_id, reason)
       VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE granted_by_account_id = VALUES(granted_by_account_id), reason = VALUES(reason)`,
      [characterId, word, shout.shout, staffAccountId || null, String(reason || '').slice(0, 255) || null]
    );
  }
  await pushShouts(characterId);
  return ok(`${shout.name}: ${count} word${count === 1 ? '' : 's'} granted.`, { shout, count });
}

async function revokeShout(characterId, shoutKey) {
  const d = deps();
  const shout = findShout(shoutKey);
  if (!shout) return no(`Unknown shout "${shoutKey}".`);
  await d.db.query('DELETE FROM character_shouts WHERE character_id = ? AND shout_desc = ?', [characterId, shout.shout]);
  await pushShouts(characterId);
  return ok(`${shout.name} taken away.`);
}

/** [{shout, words:[...]}] as FormDescs, from the database. */
async function shoutsOf(characterId) {
  const rows = await deps().db.query('SELECT word_desc, shout_desc FROM character_shouts WHERE character_id = ?', [characterId]);
  const byShout = new Map();
  for (const r of rows) {
    const k = String(r.shout_desc);
    if (!byShout.has(k)) byShout.set(k, []);
    byShout.get(k).push(String(r.word_desc));
  }
  return [...byShout].map(([shout, words]) => ({ shout, words }));
}

/** Sends a character's granted shouts to their game (if online). */
async function pushShouts(characterId) {
  const d = deps();
  const actorId = d.commands.getActiveActorByCharacterId(characterId);
  if (!actorId || !d.mp) return false;
  const toId = (desc) => {
    try { return d.mp.getIdFromDesc(desc); } catch { return null; }
  };
  const shouts = (await shoutsOf(characterId))
    .map((s) => ({ shout: toId(s.shout), words: s.words.map(toId).filter(Boolean) }))
    .filter((s) => s.shout);
  d.mp.set(actorId, SHOUTS_PROPERTY, { sentAt: d.now(), shouts });
  _shoutsSent.set(actorId, characterId);
  return true;
}

/**
 * Client: teaches and unlocks each granted word and adds its shout, once per
 * new value; a shout no longer granted is removed.
 */
const SHOUTS_UPDATE_OWNER = `
  if (!ctx.value || ctx.value.sentAt === ctx.state.councilShoutsAt) return;
  ctx.state.councilShoutsAt = ctx.value.sentAt;
  var g = ctx.sp.Game;
  var pl = g.getPlayer();
  if (!pl) { ctx.state.councilShoutsAt = null; return; }
  var now = {};
  var list = ctx.value.shouts || [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    now[s.shout] = true;
    for (var w = 0; w < s.words.length; w++) {
      try {
        var word = ctx.sp.WordOfPower.from(g.getFormEx(s.words[w]));
        if (word) { g.teachWord(word); g.unlockWord(word); }
      } catch (e) {}
    }
    try {
      var shout = ctx.sp.Shout.from(g.getFormEx(s.shout));
      if (shout && !pl.hasSpell(shout)) pl.addShout(shout);
    } catch (e) {}
  }
  var before = ctx.state.councilShoutIds || [];
  for (var j = 0; j < before.length; j++) {
    if (now[before[j]]) continue;
    try { var old = ctx.sp.Shout.from(g.getFormEx(before[j])); if (old) pl.removeShout(old); } catch (e) {}
  }
  ctx.state.councilShoutIds = Object.keys(now).map(Number);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function characterByNumber(number) {
  const n = Number(String(number || '').replace(/^#/, ''));
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const rows = await deps().db.query(
    "SELECT id, first_name, last_name FROM characters WHERE char_number = ? AND status = 'approved'", [n]);
  return rows.length ? { id: Number(rows[0].id), name: `${rows[0].first_name} ${rows[0].last_name}` } : null;
}

function staffOnly(fn) {
  return async (actorId, args) => {
    if (!deps().isStaff(actorId)) return say(actorId, 'Only the Council can do that.');
    return fn(actorId, args);
  };
}

function commandDefs() {
  const wrap = (fn) => (actorId, args) => Promise.resolve(fn(actorId, args)).catch((err) => {
    deps().logger.error('[council] command failed:', err.message);
    say(actorId, 'Could not complete that. Check the server log.');
  });
  return [
    {
      name: '/summons',
      description: '[Council] Open summons from the Advisors',
      usage: '/summons',
      handler: wrap(staffOnly(async (actorId) => {
        const rows = await openSummons();
        say(actorId, rows.length
          ? `[Council] ${rows.map((r) => `#${r.id} ${r.first_name} ${r.last_name}: "${r.reason}"`).join(' · ')}`
          : '[Council] No open summons.');
      }))
    },
    {
      name: '/answer',
      description: '[Council] Answer a summons: appear beside the Advisor at High Hrothgar',
      usage: '/answer <id>',
      handler: wrap(staffOnly(async (actorId, args) => {
        const r = await answer(actorId, Number(String(args || '').trim().replace(/^#/, '')));
        say(actorId, `[Council] ${r.message}`);
      }))
    },
    {
      name: '/return',
      description: '[Council] Return to where you were before answering a summons (optional: the outcome)',
      usage: '/return [outcome]',
      handler: wrap(staffOnly(async (actorId, args) => {
        const r = await returnFromSummons(actorId, args);
        say(actorId, `[Council] ${r.message}`);
      }))
    },
    {
      name: '/grantshout',
      description: '[Council] Teach a character a shout (1-3 words)',
      usage: '/grantshout <player#> <shout> <words 1-3> <reason>',
      handler: wrap(staffOnly(async (actorId, args) => {
        const parts = String(args || '').trim().split(/\s+/);
        const character = await characterByNumber(parts[0]);
        if (!character || !parts[1]) return say(actorId, 'Usage: /grantshout <player#> <shout> <words 1-3> <reason> (/shouts lists shouts)');
        const staffChar = deps().commands.getActiveCharacterData(actorId);
        const r = await grantShout(staffChar ? staffChar.accountId : null, character.id, parts[1], parts[2], parts.slice(3).join(' '));
        say(actorId, `[Council] ${character.name}: ${r.message}`);
        const target = deps().commands.getActiveActorByCharacterId(character.id);
        if (r.ok && target) say(target, `The Greybeards teach you ${r.count === 1 ? 'a word' : 'words'} of power: ${r.shout.name}.`);
      }))
    },
    {
      name: '/revokeshout',
      description: '[Council] Take a shout away from a character',
      usage: '/revokeshout <player#> <shout>',
      handler: wrap(staffOnly(async (actorId, args) => {
        const parts = String(args || '').trim().split(/\s+/);
        const character = await characterByNumber(parts[0]);
        if (!character || !parts[1]) return say(actorId, 'Usage: /revokeshout <player#> <shout>');
        const r = await revokeShout(character.id, parts[1]);
        say(actorId, `[Council] ${character.name}: ${r.message}`);
      }))
    },
    {
      name: '/shouts',
      description: 'The shouts you know (staff: a player\'s, or every shout the Council can grant)',
      usage: '/shouts [player#|all]',
      handler: wrap(async (actorId, args) => {
        const arg = String(args || '').trim();
        const d = deps();
        if (arg === 'all') return say(actorId, `Shouts: ${[...shoutCatalog().values()].map((s) => s.key).join(', ')}`);
        let characterId;
        if (arg) {
          if (!d.isStaff(actorId)) return say(actorId, 'Only the Council sees what others know.');
          const c = await characterByNumber(arg);
          if (!c) return say(actorId, `No character #${arg}.`);
          characterId = c.id;
        } else {
          const me = d.commands.getActiveCharacterData(actorId);
          characterId = me ? me.characterId : null;
        }
        const names = new Map([...shoutCatalog().values()].map((s) => [s.shout, s.name]));
        const list = characterId ? await shoutsOf(characterId) : [];
        say(actorId, list.length
          ? `Shouts: ${list.map((s) => `${names.get(s.shout) || s.shout} (${s.words.length}/3)`).join(', ')}`
          : 'No shouts. Only the Council teaches them.');
      })
    }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Sends granted shouts to everyone who logged in since the last sweep. */
async function sweepLogins() {
  const { commands } = deps();
  const active = new Set(commands.listActiveActorIds());
  for (const actorId of [..._shoutsSent.keys()]) if (!active.has(actorId)) _shoutsSent.delete(actorId);
  for (const actorId of active) {
    const ch = commands.getActiveCharacterData(actorId);
    if (!ch || _shoutsSent.get(actorId) === ch.characterId) continue;
    await pushShouts(ch.characterId);
  }
}

async function initialize(overrides = {}) {
  configure(overrides);
  const d = deps();
  shoutCatalog();
  if (d.mp && typeof d.mp.makeProperty === 'function') {
    d.mp.makeProperty(SHOUTS_PROPERTY, { isVisibleByOwner: true, isVisibleByNeighbors: false, updateOwner: SHOUTS_UPDATE_OWNER, updateNeighbor: '' });
  }
  if (!_sweep) {
    _sweep = setInterval(() => { sweepLogins().catch((err) => d.logger.error('[council] shouts at login failed:', err.message)); }, LOGIN_SWEEP_MS);
    if (_sweep.unref) _sweep.unref();
  }
  d.logger.log(`[council] summons and Council shouts active (${shoutCatalog().size} shouts).`);
}

function shutdown() {
  if (_sweep) clearInterval(_sweep);
  _sweep = null;
  for (const t of _expiry.values()) clearTimeout(t);
  _expiry.clear();
}

function _resetForTest() {
  shutdown();
  _returnPoints.clear();
  _shoutsSent.clear();
  _deps = null;
}

module.exports = {
  MODULE_ID, SUMMONS_TTL_MS, SHOUTS_PROPERTY, SHOUTS_UPDATE_OWNER, COUNCILOR_TITLE,
  configure, summon, expire, answer, returnFromSummons, openSummons,
  shoutCatalog, findShout, grantShout, revokeShout, shoutsOf, pushShouts, sweepLogins,
  commandDefs, initialize, shutdown, _resetForTest
};
