/**
 * admin-panel-service.js — the F8 staff panel (server side)
 *
 * Four tabs, all staff-only:
 *   Characters  every character (online and offline): #number, name, account,
 *               status, online flag; search; retire with a required reason.
 *   Items       search the item records of the loaded plugins; give N to
 *               yourself or to a player by #number.
 *   Creatures   search NPC/creature records; place one in front of you;
 *               remove the ones placed from this panel.
 *   Players     who is online, by #number; go to, bring here, set gold, kick.
 *
 * The panel is only a faster way to reach powers staff already have. Every
 * action is checked HERE with admin-service.hasPermission, never trusted from
 * the UI, and every action writes audit_logs (through admin-service, which
 * owns the staff actions and their audit lines; spawning lives here because
 * it needs the record index and the world API).
 *
 * Client → server: UI events with the `admin:` prefix (core/ui-event-router).
 * Server → client: the `adminPanelData` property, `{ channels, sentAt }`,
 * carrying every channel last sent (a SkyMP property only replicates its
 * latest value; see the same fix in player-panel-service.sendPanelData).
 * The page handles it in skymp/ui/admin-panel.js (`window.handleAdminPanelData`).
 *
 * F8 (rebindable, `admin.open` in core/keybinds.js) is handled by the client
 * snippet in core/player-shortcuts-service.js, which only opens the panel for
 * players the server marked as staff — non-staff pressing F8 get nothing.
 *
 * Flag: ENABLE_ADMIN_PANEL. Defaults to true when not set (see
 * applyDefaultFlag); set it to false to switch the panel off.
 */

'use strict';

const PROPERTY = 'adminPanelData';
const FLAG = 'ENABLE_ADMIN_PANEL';

const MAX_CHARACTER_ROWS = 100;
const MAX_QUERY_LENGTH = 64;
const MAX_GIVE_COUNT = 1000;
/**
 * Gives from one staff member closer together than this are dropped. A held
 * Enter/Space on the focused Give button clicks it on every key repeat (~35 a
 * second): on 2026-11-21 that gave 1460 Mysticism spell tomes in 41 seconds.
 */
const GIVE_MIN_INTERVAL_MS = 300;
const MAX_REASON_LENGTH = 500;
const MAX_LIVE_SPAWNS = 50;
const SPAWN_DISTANCE = 150;

/** Client snippet for the property: forward each NEW value to the page once. */
// The property keeps its last value with the character, so at login the
// client would see the last session's panel as "new" and open it. The first
// run only records what is already there; later values open the panel.
const UPDATE_OWNER_SNIPPET = `
  if (!ctx.state.adminPanelSeen) {
    ctx.state.adminPanelSeen = true;
    if (ctx.value) { ctx.state.adminPanelSentAt = ctx.value.sentAt; return; }
  }
  if (ctx.value && ctx.value.sentAt !== ctx.state.adminPanelSentAt && ctx.sp && ctx.sp.browser && ctx.sp.browser.executeJavaScript) {
    ctx.state.adminPanelSentAt = ctx.value.sentAt;
    ctx.sp.browser.executeJavaScript('window.handleAdminPanelData && window.handleAdminPanelData(' + JSON.stringify(ctx.value) + ')');
  }
`;

/** `ENABLE_ADMIN_PANEL` unset → 'true'. An explicit value is left alone. */
function applyDefaultFlag(env = process.env) {
  if (env[FLAG] === undefined || env[FLAG] === '') env[FLAG] = 'true';
  return env[FLAG];
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * @param {object} deps
 * @param {{query: Function}} deps.db
 * @param {object} deps.commands      - getActiveCharacterData, listActiveActorIds, getActorByCharacterNumber, getActiveActorByCharacterId, sendNotification, onCharacterRemoved
 * @param {object} deps.admin         - admin-service
 * @param {object} deps.characterNumbers
 * @param {object} deps.recordIndex   - core/plugin-record-index createRecordIndex()
 * @param {object} deps.espm          - core/espm (fallback record lookup)
 * @param {() => any} [deps.mpApi]
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 */
function createAdminPanel(deps) {
  const { db, commands, admin, characterNumbers, recordIndex, espm } = deps;
  const mpApi = deps.mpApi || (() => (typeof mp !== 'undefined' ? mp : null));
  const log = deps.log || console;

  /** actorId -> { [channel]: data } */
  const channels = new Map();
  /** formId -> { baseId, name, byActorId, at } — NPCs placed from this panel */
  const spawned = new Map();
  let resultSeq = 0;
  let openSeq = 0;
  const now = deps.now || (() => Date.now());
  /** actorId -> time of the last give accepted from that staff member */
  const lastGiveAt = new Map();

  // ── permissions ──────────────────────────────────────────────────────────
  function isStaff(actorId) {
    return Boolean(admin.getRole(actorId));
  }

  function capabilities(actorId) {
    return {
      retire: admin.hasPermission(actorId, 'retire_character'),
      giveItem: admin.hasPermission(actorId, 'add_item'),
      spawnNpc: admin.hasPermission(actorId, 'spawn_npc'),
      teleport: admin.hasPermission(actorId, 'teleport'),
      setGold: admin.hasPermission(actorId, 'set_gold'),
      kick: admin.hasPermission(actorId, 'kick')
    };
  }

  // ── transport ────────────────────────────────────────────────────────────
  function send(actorId, channel, data) {
    const mine = channels.get(actorId) || {};
    mine[channel] = data;
    channels.set(actorId, mine);
    const api = mpApi();
    if (!api) return;
    try {
      api.set(actorId, PROPERTY, JSON.parse(JSON.stringify({ channels: mine, sentAt: Date.now() + Math.random() })));
    } catch (err) {
      log.error(`[admin-panel] Failed to send '${channel}' to 0x${actorId.toString(16)}:`, err.message);
    }
  }

  function result(actorId, ok, message) {
    resultSeq += 1;
    send(actorId, 'result', { ok, message, seq: resultSeq });
    return ok;
  }

  // ── targets ──────────────────────────────────────────────────────────────
  /**
   * '#12' / '12' / 12 → online actorId, or an error message.
   * @returns {{actorId: number} | {error: string}}
   */
  function resolvePlayer(target) {
    const n = characterNumbers.parseCharacterNumber(String(target ?? ''));
    if (n === null) return { error: `"${String(target ?? '').slice(0, 12)}" is not a character number (e.g. 12 or #12).` };
    const actorId = commands.getActorByCharacterNumber(n);
    if (!actorId) return { error: `No one with number #${n} is online.` };
    return { actorId };
  }

  // ── snapshots ────────────────────────────────────────────────────────────
  function npcSpawnAvailability() {
    const api = mpApi();
    if (!api || typeof api.place !== 'function' || typeof api.set !== 'function') {
      return { available: false, reason: 'Spawning is unavailable: this server build does not expose mp.place.' };
    }
    let settings = {};
    try { settings = typeof api.getServerSettings === 'function' ? (api.getServerSettings() || {}) : {}; } catch { settings = {}; }
    // SkyMP treats a missing npcEnabled as false ("Disabling NPCs by default",
    // ScampServer.cpp), so only an explicit true counts as on.
    if (settings.npcEnabled !== true) {
      const why = settings.npcEnabled === false ? 'npcEnabled is false' : 'npcEnabled is not set, which SkyMP treats as off';
      return {
        available: false,
        reason: `NPCs are disabled on this server (${why} in server-settings.json). Creature spawning stays off until NPC support is turned on.`
      };
    }
    return { available: true, reason: null };
  }

  function metaSnapshot(actorId) {
    return {
      role: admin.getRole(actorId),
      can: capabilities(actorId),
      npcSpawn: npcSpawnAvailability(),
      index: recordIndex.status()
    };
  }

  function playersSnapshot() {
    const rows = [];
    for (const actorId of commands.listActiveActorIds()) {
      const c = commands.getActiveCharacterData(actorId);
      if (!c) continue;
      rows.push({
        number: c.charNumber || null,
        name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        characterId: c.characterId,
        accountId: c.accountId,
        staffRole: admin.getRole(actorId) || null
      });
    }
    rows.sort((a, b) => (a.number || 1e9) - (b.number || 1e9));
    return { players: rows, at: Date.now() };
  }

  /**
   * Every character, online or offline, filtered by an optional query:
   * a number matches #number, character id or account id; text matches the
   * character name or the account's Discord name.
   */
  async function searchCharacters({ query, includeRetired } = {}) {
    const q = cleanText(query, MAX_QUERY_LENGTH).replace(/^#/, '');
    const where = [];
    const params = [];
    if (!includeRetired) where.push("c.status <> 'retired'");
    if (/^\d{1,9}$/.test(q)) {
      const n = Number(q);
      where.push('(c.char_number = ? OR c.id = ? OR c.account_id = ?)');
      params.push(n, n, n);
    } else if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push("(CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR d.username LIKE ?)");
      params.push(like, like);
    }
    const sql =
      'SELECT c.id, c.char_number, c.first_name, c.last_name, c.status, c.account_id, d.username AS account_name ' +
      'FROM characters c ' +
      'LEFT JOIN (SELECT account_id, MIN(username) AS username FROM discord_identities GROUP BY account_id) d ON d.account_id = c.account_id ' +
      (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
      'ORDER BY c.char_number IS NULL, c.char_number, c.id ' +
      `LIMIT ${MAX_CHARACTER_ROWS + 1}`;
    const rows = await db.query(sql, params);
    const list = (rows || []).slice(0, MAX_CHARACTER_ROWS).map((r) => ({
      characterId: r.id,
      number: r.char_number === null || r.char_number === undefined ? null : Number(r.char_number),
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      status: r.status,
      accountId: r.account_id,
      accountName: r.account_name || null,
      online: Boolean(commands.getActiveActorByCharacterId(r.id))
    }));
    return { query: q, includeRetired: Boolean(includeRetired), characters: list, more: (rows || []).length > MAX_CHARACTER_ROWS };
  }

  // ── actions ──────────────────────────────────────────────────────────────
  async function open(actorId) {
    if (!isStaff(actorId)) {
      commands.sendNotification(actorId, 'Staff only.');
      send(actorId, 'meta', { denied: true });
      const api = mpApi();
      if (api) { try { api.set(actorId, 'browserFocused', false); } catch { /* ignore */ } }
      return false;
    }
    // `openSeq` tells the page "open now" (F8 already opened it locally;
    // /adminpanel relies on this). Later meta updates keep the same value, so
    // they never reopen a panel the staff member closed.
    openSeq += 1;
    const seq = openSeq;
    send(actorId, 'meta', { ...metaSnapshot(actorId), openSeq: seq });
    send(actorId, 'players', playersSnapshot());
    send(actorId, 'spawned', spawnedSnapshot());
    send(actorId, 'characters', await searchCharacters({}));
    // Build the record index in the background; tell the page when it is ready.
    if (recordIndex.status().status === 'idle') {
      recordIndex.get().then(() => {
        if (channels.has(actorId)) send(actorId, 'meta', { ...metaSnapshot(actorId), openSeq: seq });
      }).catch(() => {});
    }
    return true;
  }

  function close(actorId) {
    channels.delete(actorId);
    const api = mpApi();
    if (api) {
      try { api.set(actorId, 'browserFocused', false); } catch (err) {
        log.error('[admin-panel] Failed to release browser focus:', err.message);
      }
    }
  }

  async function retire(actorId, data) {
    if (!admin.hasPermission(actorId, 'retire_character')) {
      return result(actorId, false, 'Permission denied: retiring characters needs admin.');
    }
    const reason = cleanText(data && data.reason, MAX_REASON_LENGTH);
    if (!reason) return result(actorId, false, 'A reason is required to retire a character.');
    const out = await admin.retireCharacterById(actorId, data && data.characterId, reason);
    if (!out.ok) return result(actorId, false, out.error);
    send(actorId, 'characters', await searchCharacters(data && data.list ? data.list : {}));
    return result(actorId, true, `${out.name} was retired${out.wasOnline ? ' and will be kicked' : ''}.`);
  }

  async function searchRecords(actorId, data, kind) {
    const permission = kind === 'items' ? 'add_item' : 'spawn_npc';
    if (!admin.hasPermission(actorId, permission)) {
      return result(actorId, false, 'Permission denied.');
    }
    const query = cleanText(data && data.query, MAX_QUERY_LENGTH);
    const allTypes = kind === 'items' ? require('./core/plugin-record-index').ITEM_TYPES : require('./core/plugin-record-index').NPC_TYPES;
    const wanted = data && typeof data.type === 'string' && allTypes.includes(data.type) ? [data.type] : allTypes;
    const offset = Number.isSafeInteger(Number(data && data.offset)) && Number(data.offset) > 0 ? Number(data.offset) : 0;
    const page = await recordIndex.searchPage({ query, types: wanted, offset });
    let results = page ? page.results : null;
    let note = null;
    if (results === null) {
      // No index (plugins unreadable): a hex FormID still works through espm.
      results = [];
      const st = recordIndex.status();
      note = `Search by name is unavailable (${st.error || st.status}). You can still type a FormID like 0x00012eb7.`;
      const hex = /^(0x)?([0-9a-f]{1,8})$/i.exec(query);
      if (hex) {
        const baseId = parseInt(hex[2], 16);
        const rec = espm.lookup(baseId);
        if (rec.existe && wanted.includes(rec.type)) {
          results.push({ baseId, idHex: `0x${baseId.toString(16).padStart(8, '0')}`, type: rec.type, name: rec.editorId || query, editorId: rec.editorId, plugin: null });
        }
      }
    }
    send(actorId, kind, {
      query,
      type: wanted.length === 1 ? wanted[0] : 'all',
      results,
      total: page ? page.total : results.length,
      offset: page ? page.offset : 0,
      pageSize: page ? page.limit : Math.max(results.length, 1),
      note
    });
    return true;
  }

  async function giveItem(actorId, data) {
    if (!admin.hasPermission(actorId, 'add_item')) {
      return result(actorId, false, 'Permission denied: giving items needs admin.');
    }
    const baseId = Number(data && data.baseId);
    if (!Number.isSafeInteger(baseId) || baseId <= 0 || baseId > 0xffffffff) return result(actorId, false, 'Invalid item.');
    const count = Number(data && data.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_GIVE_COUNT) {
      return result(actorId, false, `Count must be a whole number from 1 to ${MAX_GIVE_COUNT}.`);
    }
    let targetActorId = actorId;
    const target = data && data.target;
    if (target !== undefined && target !== null && target !== '' && target !== 'self') {
      const r = resolvePlayer(target);
      if (r.error) return result(actorId, false, r.error);
      targetActorId = r.actorId;
    }
    const t = now();
    const prev = lastGiveAt.get(actorId);
    if (prev !== undefined && t - prev < GIVE_MIN_INTERVAL_MS) {
      // No result banner: a repeat flood would only replace the real one.
      return false;
    }
    lastGiveAt.set(actorId, t);
    const ok = await admin.giveItemAdmin(actorId, targetActorId, baseId, count);
    const who = targetActorId === actorId ? 'you' : `#${commands.getActiveCharacterData(targetActorId)?.charNumber ?? '?'}`;
    return result(actorId, Boolean(ok), ok ? `Gave ${count} × 0x${baseId.toString(16)} to ${who}.` : 'The item was not given (see the notice).');
  }

  async function spawnNpc(actorId, data) {
    if (!admin.hasPermission(actorId, 'spawn_npc')) {
      return result(actorId, false, 'Permission denied: spawning creatures needs admin.');
    }
    const availability = npcSpawnAvailability();
    if (!availability.available) return result(actorId, false, availability.reason);
    if (spawned.size >= MAX_LIVE_SPAWNS) {
      return result(actorId, false, `There are already ${MAX_LIVE_SPAWNS} spawned creatures. Remove some first.`);
    }
    const baseId = Number(data && data.baseId);
    if (!Number.isSafeInteger(baseId) || baseId <= 0 || baseId > 0xffffffff) return result(actorId, false, 'Invalid creature.');

    // Only an NPC_ record can be placed as an actor. Confirmed by the index or
    // by the espm lookup; "cannot tell" refuses (placing a wrong record type
    // creates a stray object, not a creature).
    const indexed = await recordIndex.findById(baseId);
    const rec = indexed ? { type: indexed.type, name: indexed.name } : (() => {
      const r = espm.lookup(baseId);
      return r.existe ? { type: r.type, name: r.editorId } : null;
    })();
    if (!rec) return result(actorId, false, `0x${baseId.toString(16)} is not a record in the loaded plugins.`);
    if (rec.type !== 'NPC_') return result(actorId, false, `0x${baseId.toString(16)} is a ${rec.type}, not an NPC or creature.`);

    const api = mpApi();
    const loc = api.get(actorId, 'locationalData');
    if (!loc || !Array.isArray(loc.pos)) return result(actorId, false, 'Could not read your position.');
    const angle = Array.isArray(loc.rot) ? Number(loc.rot[2]) || 0 : 0;
    const rad = (angle * Math.PI) / 180;
    const pos = [loc.pos[0] + Math.sin(rad) * SPAWN_DISTANCE, loc.pos[1] + Math.cos(rad) * SPAWN_DISTANCE, loc.pos[2]];

    let formId;
    try {
      const placed = api.place(baseId);
      formId = typeof placed === 'number' ? placed : (placed && placed.desc && typeof api.getIdFromDesc === 'function' ? api.getIdFromDesc(placed.desc) : null);
      if (!Number.isInteger(formId)) throw new Error('mp.place returned no form id');
      api.set(formId, 'locationalData', { pos, rot: [0, 0, (angle + 180) % 360], cellOrWorldDesc: loc.cellOrWorldDesc });
    } catch (err) {
      log.error(`[admin-panel] Spawn of 0x${baseId.toString(16)} failed:`, err.message);
      return result(actorId, false, `Spawning failed: ${err.message}`);
    }

    spawned.set(formId, { baseId, name: rec.name, byActorId: actorId, at: Date.now() });
    const me = commands.getActiveCharacterData(actorId);
    await admin.auditLog(me?.accountId, null, 'staff:spawnNpc',
      `role=${admin.getRole(actorId)} baseId=0x${baseId.toString(16)} formId=0x${formId.toString(16)} cell=${loc.cellOrWorldDesc} pos=${pos.map((v) => Math.round(v)).join(',')}`);
    log.log(`[admin-panel] ${actorId.toString(16)} (${admin.getRole(actorId)}) spawned 0x${baseId.toString(16)} as 0x${formId.toString(16)}`);
    send(actorId, 'spawned', spawnedSnapshot());
    return result(actorId, true, `Spawned ${rec.name || `0x${baseId.toString(16)}`} in front of you.`);
  }

  function spawnedSnapshot() {
    return {
      list: [...spawned.entries()].map(([formId, s]) => ({
        formId, formIdHex: `0x${formId.toString(16)}`, baseIdHex: `0x${s.baseId.toString(16)}`, name: s.name || null, at: s.at
      }))
    };
  }

  async function despawnNpc(actorId, data) {
    if (!admin.hasPermission(actorId, 'spawn_npc')) {
      return result(actorId, false, 'Permission denied.');
    }
    const formId = Number(data && data.formId);
    const entry = spawned.get(formId);
    if (!entry) return result(actorId, false, 'Only creatures spawned from this panel can be removed here.');
    const api = mpApi();
    try {
      api.destroyActor(formId);
    } catch (err) {
      return result(actorId, false, `Could not remove it: ${err.message}`);
    }
    spawned.delete(formId);
    const me = commands.getActiveCharacterData(actorId);
    await admin.auditLog(me?.accountId, null, 'staff:despawnNpc',
      `role=${admin.getRole(actorId)} baseId=0x${entry.baseId.toString(16)} formId=0x${formId.toString(16)}`);
    send(actorId, 'spawned', spawnedSnapshot());
    return result(actorId, true, 'Removed.');
  }

  async function playerAction(actorId, type, data) {
    const r = resolvePlayer(data && data.number);
    if (r.error) return result(actorId, false, r.error);
    const target = r.actorId;
    const label = `#${commands.getActiveCharacterData(target)?.charNumber ?? '?'}`;
    let ok;
    switch (type) {
      case 'admin:players:goto':
        if (target === actorId) return result(actorId, false, 'That is you.');
        ok = await admin.teleportTo(actorId, target);
        return result(actorId, Boolean(ok), ok ? `Went to ${label}.` : 'Permission denied.');
      case 'admin:players:bring':
        if (target === actorId) return result(actorId, false, 'That is you.');
        ok = await admin.bringPlayer(actorId, target);
        return result(actorId, Boolean(ok), ok ? `Brought ${label} to you.` : 'Permission denied.');
      case 'admin:players:setgold': {
        const amount = Number(data && data.amount);
        if (!Number.isSafeInteger(amount) || amount < 0) return result(actorId, false, 'Gold must be a whole number, 0 or more.');
        ok = await admin.setGold(actorId, target, amount);
        return result(actorId, Boolean(ok), ok ? `${label} now has ${amount} gold.` : 'Gold was not changed.');
      }
      case 'admin:players:kick': {
        const reason = cleanText(data && data.reason, MAX_REASON_LENGTH);
        if (!reason) return result(actorId, false, 'A reason is required to kick.');
        if (target === actorId) return result(actorId, false, 'That is you.');
        ok = await admin.kickPlayer(actorId, target, reason);
        return result(actorId, Boolean(ok), ok ? `${label} will be kicked.` : 'Permission denied.');
      }
      default:
        return false;
    }
  }

  // ── router ───────────────────────────────────────────────────────────────
  /**
   * UI events with the `admin:` prefix. Non-staff are refused before any
   * data is read; each action then checks its own permission.
   */
  async function handleUiEvent(actorId, uiEvent) {
    if (!uiEvent || typeof uiEvent.type !== 'string' || !uiEvent.type.startsWith('admin:')) return false;
    const data = uiEvent.data && typeof uiEvent.data === 'object' && !Array.isArray(uiEvent.data) ? uiEvent.data : {};

    if (uiEvent.type === 'admin:close') { close(actorId); return true; }
    if (uiEvent.type === 'admin:open') { await open(actorId); return true; }
    if (!isStaff(actorId)) {
      commands.sendNotification(actorId, 'Staff only.');
      return true;
    }

    switch (uiEvent.type) {
      case 'admin:refresh':
        send(actorId, 'meta', { ...metaSnapshot(actorId), openSeq: channels.get(actorId)?.meta?.openSeq ?? null });
        send(actorId, 'players', playersSnapshot());
        send(actorId, 'spawned', spawnedSnapshot());
        return true;
      case 'admin:characters:search':
        send(actorId, 'characters', await searchCharacters(data));
        return true;
      case 'admin:characters:retire':
        await retire(actorId, data);
        return true;
      case 'admin:items:search':
        await searchRecords(actorId, data, 'items');
        return true;
      case 'admin:items:give':
        await giveItem(actorId, data);
        return true;
      case 'admin:creatures:search':
        await searchRecords(actorId, data, 'creatures');
        return true;
      case 'admin:creatures:spawn':
        await spawnNpc(actorId, data);
        return true;
      case 'admin:creatures:despawn':
        await despawnNpc(actorId, data);
        return true;
      case 'admin:players:refresh':
        send(actorId, 'players', playersSnapshot());
        return true;
      case 'admin:players:goto':
      case 'admin:players:bring':
      case 'admin:players:setgold':
      case 'admin:players:kick':
        await playerAction(actorId, uiEvent.type, data);
        return true;
      default:
        return false;
    }
  }

  function forget(actorId) {
    channels.delete(actorId);
  }

  return {
    handleUiEvent,
    open,
    close,
    forget,
    searchCharacters,
    resolvePlayer,
    npcSpawnAvailability,
    playersSnapshot,
    _channels: channels,
    _spawned: spawned
  };
}

let _instance = null;

/** The live instance, wired to the real services (lazy: they need the world). */
function getInstance() {
  if (!_instance) {
    const commands = require('./commands');
    _instance = createAdminPanel({
      db: require('./database'),
      commands,
      admin: require('./admin-service'),
      characterNumbers: require('./core/character-numbers'),
      recordIndex: require('./core/plugin-record-index').createRecordIndex(),
      espm: require('./core/espm')
    });
  }
  return _instance;
}

let _unsubscribe = null;

function initAdminPanelService() {
  const instance = getInstance();
  const commands = require('./commands');
  if (!_unsubscribe && typeof commands.onCharacterRemoved === 'function') {
    _unsubscribe = commands.onCharacterRemoved((actorId) => instance.forget(actorId));
  }
  console.log('[admin-panel] F8 admin panel ready (staff only).');
}

function shutdownAdminPanelService() {
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = null;
}

function commandDefs() {
  return [
    {
      name: ['/adminpanel', '/f8'],
      description: '[Staff] Opens the admin panel (same as F8)',
      usage: '/adminpanel',
      handler: (actorId) => {
        const api = typeof mp !== 'undefined' ? mp : null;
        const admin = require('./admin-service');
        if (api && admin.getRole(actorId)) {
          try { api.set(actorId, 'browserVisible', true); api.set(actorId, 'browserFocused', true); } catch { /* ignore */ }
        }
        return getInstance().open(actorId);
      }
    }
  ];
}

module.exports = {
  PROPERTY,
  FLAG,
  UPDATE_OWNER_SNIPPET,
  MAX_GIVE_COUNT,
  MAX_LIVE_SPAWNS,
  applyDefaultFlag,
  createAdminPanel,
  getInstance,
  initAdminPanelService,
  shutdownAdminPanelService,
  commandDefs,
  handleUiEvent: (actorId, uiEvent) => getInstance().handleUiEvent(actorId, uiEvent)
};
