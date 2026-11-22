/**
 * look-keys-service.js — keys that act on what you look at
 *
 * Replaces chat commands with keys shown next to the crosshair:
 *
 *   another player:  E  Trade        I  Introduce yourself   G  Group up
 *   a door:          E  Open/close   G  Lock/unlock (parcel access only)
 *
 * The client sends what is under the crosshair and which key was pressed;
 * the server decides everything (who the target is, range, parcel access)
 * and answers with the prompt the CEF draws (`window.handleLookKeys`).
 *
 * Doors open and close with Skyrim's own E (holdstone-service still blocks
 * locked parcels); this service only labels it and adds G for players who
 * have access to the parcel the door belongs to.
 *
 * Groups (core/groups.js) also feed the compass: every second each grouped
 * player gets the members within COMPASS_RANGE, and the client draws a gold
 * diamond per member on the compass (`window.handleGroupCompass`).
 */

'use strict';

const commands = require('./commands');
const espm = require('./core/espm');
const rangeUtils = require('./core/range-utils');
const { createGroups } = require('./core/groups');

const MODULE_ID = 'look-keys';
const PROMPT_PROPERTY = 'lookKeys';
const COMPASS_PROPERTY = 'groupCompass';
const EVENT_SOURCE = '_lookKeysEvent';

/** DirectInput scan codes. */
const KEY_CODES = Object.freeze({ E: 18, I: 23, G: 34 });
/** Players must stand this close (game units, ~4 m) to trade, introduce or group. */
const PLAYER_RANGE = 300;
/** ~100 m: group members farther than this are not on the compass. */
const COMPASS_RANGE = 7000;
const COMPASS_TICK_MS = 1000;

let _groups = createGroups();
let _deps = null;
let _timer = null;
let _unsubscribeRemoved = null;
let _active = false;

function configure(deps = {}) {
  _deps = {
    trade: deps.trade || require('./trade-service'),
    holdstones: deps.holdstones || null,
    isStaff: deps.isStaff || (() => false),
    logger: deps.logger || console
  };
  return _deps;
}

function deps() {
  return _deps || configure();
}

// ─────────────────────────────────────────────────────────────────────────────
// Client snippets
// ─────────────────────────────────────────────────────────────────────────────

/** Event source: crosshair target + E/I/G presses while looking at something. */
const SOURCE_SNIPPET = `
  ctx.state.lookKeys = ctx.state.lookKeys || { target: 0, closeInventoryUntil: 0 };
  var st = ctx.state.lookKeys;
  var menus = ['BarterMenu','Book Menu','Console','ContainerMenu','Crafting Menu','Dialogue Menu',
    'FavoritesMenu','GiftMenu','InventoryMenu','Journal Menu','Loading Menu','Lockpicking Menu',
    'MagicMenu','MapMenu','RaceSex Menu','Sleep/Wait Menu','StatsMenu','Training Menu','TweenMenu'];
  var blocked = function () {
    try { if (ctx.sp.Ui.isTextInputEnabled()) return true; } catch (e) {}
    for (var i = 0; i < menus.length; i++) { try { if (ctx.sp.Ui.isMenuOpen(menus[i])) return true; } catch (e) {} }
    try { var br = ctx.sp.browser; if (br && typeof br.isFocused === 'function' && br.isFocused()) return true; } catch (e) {}
    return false;
  };
  var send = function (id) {
    id = id || 0;
    if (id === st.target) return;
    st.target = id;
    ctx.sendEvent({ kind: 'target', targetFormId: id });
  };
  var current = function () {
    try {
      var r = ctx.sp.Game.getCurrentCrosshairRef();
      return r ? (ctx.getFormIdInServerFormat(r.getFormID()) || 0) : 0;
    } catch (e) { return 0; }
  };
  ctx.sp.once('update', function () { send(blocked() ? 0 : current()); });
  ctx.sp.on('crosshairRefChanged', function () { send(blocked() ? 0 : current()); });
  ctx.sp.on('menuOpen', function (e) {
    // I opens Skyrim's inventory; while looking at a player it means Introduce.
    if (e && e.name === 'InventoryMenu' && Date.now() < st.closeInventoryUntil) {
      st.closeInventoryUntil = 0;
      try { ctx.sp.Input.tapKey(1); } catch (err) {}
      return;
    }
    send(0);
  });
  ctx.sp.on('menuClose', function () { ctx.sp.once('update', function () { send(blocked() ? 0 : current()); }); });
  ctx.sp.on('buttonEvent', function (e) {
    if (!e || e.device !== 0 || !e.isDown || !st.target) return;
    var key = e.code === ${KEY_CODES.E} ? 'E' : e.code === ${KEY_CODES.I} ? 'I' : e.code === ${KEY_CODES.G} ? 'G' : null;
    if (!key) return;
    if (key === 'I' && st.isPlayer) st.closeInventoryUntil = Date.now() + 1500;
    if (blocked() && key !== 'I') return;
    ctx.sendEvent({ kind: 'key', key: key, targetFormId: st.target });
  });
`;

/** Prompt property: hands the server's prompt to the CEF, once per change. */
const PROMPT_UPDATE_OWNER = `
  ctx.state.lookKeysSentAt = ctx.state.lookKeysSentAt || null;
  if (ctx.value && ctx.value.sentAt !== ctx.state.lookKeysSentAt) {
    ctx.state.lookKeysSentAt = ctx.value.sentAt;
    if (ctx.state.lookKeys) ctx.state.lookKeys.isPlayer = ctx.value.kind === 'player';
    if (ctx.sp && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
      ctx.sp.browser.executeJavaScript('window.handleLookKeys && window.handleLookKeys(' + JSON.stringify(ctx.value) + ')');
    }
  }
`;

/**
 * Compass property: the server sends member positions about once a second;
 * here, ~10 times a second, each member becomes a bearing relative to where
 * the player faces (Skyrim angleZ: 0 = north/+Y, clockwise, degrees).
 */
const COMPASS_UPDATE_OWNER = `
  var cs = ctx.state.groupCompass = ctx.state.groupCompass || { at: 0, empty: true };
  var now = Date.now();
  if (now - cs.at < 100) return;
  cs.at = now;
  var br = ctx.sp && ctx.sp.browser;
  if (!br || !br.executeJavaScript) return;
  var list = (ctx.value && ctx.value.members) || [];
  if (!list.length) {
    if (!cs.empty) { cs.empty = true; br.executeJavaScript('window.handleGroupCompass && window.handleGroupCompass([])'); }
    return;
  }
  var pl = ctx.sp.Game.getPlayer();
  if (!pl) return;
  var px = pl.getPositionX(), py = pl.getPositionY();
  var heading = pl.getAngleZ();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    var dx = m.x - px, dy = m.y - py;
    var bearing = Math.atan2(dx, dy) * 180 / Math.PI;
    var rel = bearing - heading;
    while (rel > 180) rel -= 360;
    while (rel < -180) rel += 360;
    out.push({ name: m.name, rel: Math.round(rel * 10) / 10, dist: Math.round(Math.sqrt(dx * dx + dy * dy)) });
  }
  cs.empty = false;
  br.executeJavaScript('window.handleGroupCompass && window.handleGroupCompass(' + JSON.stringify(out) + ')');
`;

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

function _baseType(targetId) {
  if (typeof mp === 'undefined') return null;
  try {
    const baseDesc = mp.get(targetId, 'baseDesc');
    if (!baseDesc) return null;
    return espm.lookup(mp.getIdFromDesc(baseDesc)).type || null;
  } catch (_) {
    return null;
  }
}

function _actor(actorId) {
  const ch = commands.getActiveCharacterData(actorId);
  return { actorId, characterId: ch ? ch.characterId : null, isStaff: Boolean(deps().isStaff(actorId)) };
}

/** The parcel a door belongs to, and whether `actorId` may lock/unlock it. */
function doorAccess(actorId, targetId) {
  const hs = deps().holdstones;
  if (!hs || typeof hs.getIndex !== 'function') return null;
  const index = hs.getIndex();
  const object = index && index.objectsById && index.objectsById.get(targetId);
  if (!object || object.kind !== 'door') return null;
  const parcel = index.parcels.get(object.parcelId);
  if (!parcel) return null;
  const parcelLocks = require('./core/parcel-locks');
  const actor = _actor(actorId);
  // "Access" = could open it while locked: owner, rank at or above the
  // parcel's minimum, hold leaders, staff.
  const access = parcelLocks.canOpenParcel(index, { ...parcel, locked: true }, actor).allowed ||
    parcelLocks.canLockParcel(index, parcel, actor);
  return { parcel, access };
}

/** The prompt for `actorId` looking at `targetId`, or null for nothing. */
function promptFor(actorId, targetId) {
  if (!targetId || targetId === actorId) return null;

  if (commands.getActiveCharacterData(targetId)) {
    const grouped = _groups.sameGroup(actorId, targetId);
    const invitedMe = _groups.hasInvite(actorId, targetId);
    return {
      kind: 'player',
      targetId,
      keys: [
        { key: 'E', label: 'Trade' },
        { key: 'I', label: 'Introduce yourself' },
        { key: 'G', label: grouped ? 'In your group' : invitedMe ? 'Join group' : 'Group up' }
      ]
    };
  }

  if (_baseType(targetId) === 'DOOR') {
    const keys = [{ key: 'E', label: 'Open / close' }];
    const door = doorAccess(actorId, targetId);
    if (door && door.access) keys.push({ key: 'G', label: door.parcel.locked ? 'Unlock' : 'Lock' });
    return { kind: 'door', targetId, keys };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

function say(actorId, message) {
  commands.sendNotification(actorId, message);
}

function nameFor(observerId, actorId) {
  try { return commands.getDisplayNameForObserver(actorId, observerId) || 'someone'; } catch (_) { return 'someone'; }
}

async function pressPlayerKey(actorId, targetId, key) {
  const range = rangeUtils.assertRange(actorId, targetId, PLAYER_RANGE);
  if (!range.ok) return say(actorId, 'Get closer first.');

  if (key === 'E') {
    const trade = deps().trade;
    const s = trade._sessionOf ? trade._sessionOf(actorId) : null;
    if (s && s.state === trade.STATES.REQUESTED && s.b.actorId === actorId && s.a.actorId === targetId) {
      return trade.acceptTrade(actorId);
    }
    return trade.requestTrade(actorId, targetId);
  }

  if (key === 'I') {
    return commands.handleIntroduceCommand(actorId, `0x${targetId.toString(16)}`);
  }

  if (key === 'G') {
    const r = _groups.pressGroup(actorId, targetId);
    if (r.result === 'already') return say(actorId, `You are already in a group with ${nameFor(actorId, targetId)}. /group leave to leave.`);
    if (r.result === 'full') return say(actorId, 'That group is full.');
    if (r.result === 'invited') {
      say(actorId, `You asked ${nameFor(actorId, targetId)} to group up.`);
      say(targetId, `${nameFor(targetId, actorId)} wants to group up. Look at them and press G to join.`);
      return;
    }
    say(actorId, `You joined ${nameFor(actorId, targetId)}'s group.`);
    for (const m of r.members) if (m !== actorId) say(m, `${nameFor(m, actorId)} joined your group.`);
    pushCompassNow();
  }
}

async function pressDoorKey(actorId, targetId, key) {
  if (key !== 'G') return; // E is Skyrim's own activation
  const door = doorAccess(actorId, targetId);
  if (!door || !door.access) return;
  const result = await deps().holdstones.setParcelLocked(door.parcel.id, !door.parcel.locked);
  say(actorId, result && result.message ? result.message : 'Done.');
  publishPrompt(actorId, targetId);
}

async function handleKey(actorId, key, rawTarget) {
  const targetId = Number(rawTarget) >>> 0;
  if (!targetId || !['E', 'I', 'G'].includes(key)) return;
  const prompt = promptFor(actorId, targetId);
  if (!prompt || !prompt.keys.some((k) => k.key === key)) return;
  if (prompt.kind === 'player') await pressPlayerKey(actorId, targetId, key);
  else await pressDoorKey(actorId, targetId, key);
  if (prompt.kind === 'player') publishPrompt(actorId, targetId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Publishing
// ─────────────────────────────────────────────────────────────────────────────

const _lastTarget = new Map();

function publishPrompt(actorId, targetId) {
  _lastTarget.set(actorId, targetId || 0);
  const prompt = promptFor(actorId, targetId) || { kind: null, keys: [] };
  if (typeof mp === 'undefined') return prompt;
  try { mp.set(actorId, PROMPT_PROPERTY, { ...prompt, sentAt: Date.now() }); } catch (_) {}
  return prompt;
}

function compassFor(actorId) {
  const members = _groups.membersOf(actorId).filter((m) => m !== actorId);
  const out = [];
  for (const m of members) {
    const d = rangeUtils.distanceBetween(actorId, m);
    if (d === null || d > COMPASS_RANGE) continue;
    const pos = rangeUtils.getPos(rangeUtils.getLoc(m));
    if (!pos) continue;
    out.push({ name: nameFor(actorId, m), x: Math.round(pos[0]), y: Math.round(pos[1]) });
  }
  return out;
}

const _lastCompass = new Map();

function pushCompassNow() {
  if (typeof mp === 'undefined') return;
  const grouped = new Set(_groups.allGrouped());
  for (const actorId of new Set([...grouped, ..._lastCompass.keys()])) {
    const members = grouped.has(actorId) ? compassFor(actorId) : [];
    const key = JSON.stringify(members);
    if (_lastCompass.get(actorId) === key) continue;
    _lastCompass.set(actorId, key);
    if (!members.length && !grouped.has(actorId)) _lastCompass.delete(actorId);
    try { mp.set(actorId, COMPASS_PROPERTY, { members }); } catch (_) {}
  }
}

function leaveGroup(actorId) {
  const rest = _groups.leave(actorId);
  for (const m of rest) say(m, `${nameFor(m, actorId)} left your group.`);
  pushCompassNow();
  return rest;
}

function commandDefs() {
  return [{
    name: '/group',
    description: 'Your group: /group lists members, /group leave leaves it. Invite by looking at someone and pressing G.',
    usage: '/group [leave]',
    handler: (actorId, args) => {
      if (String(args || '').trim().toLowerCase() === 'leave') {
        if (!_groups.membersOf(actorId).length) return say(actorId, 'You are not in a group.');
        leaveGroup(actorId);
        return say(actorId, 'You left your group.');
      }
      const members = _groups.membersOf(actorId).filter((m) => m !== actorId);
      if (!members.length) return say(actorId, 'You are not in a group. Look at someone and press G to group up.');
      say(actorId, `Your group: ${members.map((m) => nameFor(actorId, m)).join(', ')}.`);
    }
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function initialize() {
  if (typeof mp === 'undefined') return;
  mp.makeProperty(PROMPT_PROPERTY, { isVisibleByOwner: true, isVisibleByNeighbors: false, updateOwner: PROMPT_UPDATE_OWNER, updateNeighbor: '' });
  mp.makeProperty(COMPASS_PROPERTY, { isVisibleByOwner: true, isVisibleByNeighbors: false, updateOwner: COMPASS_UPDATE_OWNER, updateNeighbor: '' });
  mp.makeEventSource(EVENT_SOURCE, SOURCE_SNIPPET);
  mp[EVENT_SOURCE] = (actorId, payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'target') { publishPrompt(actorId, Number(payload.targetFormId) >>> 0); return; }
    if (payload.kind === 'key') {
      handleKey(actorId, payload.key, payload.targetFormId).catch((err) => deps().logger.error('[look-keys] key failed:', err.message));
    }
  };
  if (typeof commands.onCharacterRemoved === 'function') {
    _unsubscribeRemoved = commands.onCharacterRemoved((actorId) => {
      const rest = _groups.forget(actorId);
      for (const m of rest) say(m, 'A member of your group left.');
      _lastTarget.delete(actorId);
      _lastCompass.delete(actorId);
    });
  }
  _timer = setInterval(() => { try { pushCompassNow(); } catch (err) { deps().logger.error('[look-keys] compass:', err.message); } }, COMPASS_TICK_MS);
  if (_timer.unref) _timer.unref();
  _active = true;
  deps().logger.log('[look-keys] E/I/G on players and doors, group compass active.');
}

function shutdown() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _active = false;
  if (_unsubscribeRemoved) _unsubscribeRemoved();
  _unsubscribeRemoved = null;
  if (typeof mp !== 'undefined') mp[EVENT_SOURCE] = () => {};
}

/** True while this module runs: interaction-prompt then leaves players to it. */
function isActive() { return _active; }
function setActive(v) { _active = Boolean(v); }

function _resetForTest() {
  _groups = createGroups();
  _lastTarget.clear();
  _lastCompass.clear();
}

module.exports = {
  MODULE_ID, PROMPT_PROPERTY, COMPASS_PROPERTY, EVENT_SOURCE, KEY_CODES, PLAYER_RANGE, COMPASS_RANGE,
  SOURCE_SNIPPET, PROMPT_UPDATE_OWNER, COMPASS_UPDATE_OWNER,
  configure, promptFor, doorAccess, handleKey, publishPrompt, compassFor, pushCompassNow, leaveGroup,
  commandDefs, initialize, shutdown, isActive, setActive,
  get groups() { return _groups; },
  _resetForTest
};
