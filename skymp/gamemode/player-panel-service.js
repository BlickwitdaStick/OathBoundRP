/**
 * player-panel-service.js
 *
 * Player panel: aggregates data from other services (vital status, governance,
 * economy/market, social) and sends it to the UI through the `panelData` property.
 *
 * It does not duplicate business logic — it only reads. Every action still goes through the
 * original services (governance-service, market-stalls-service) via the existing
 * interaction menu.
 *
 * Flow:
 *   - The /panel command (or the 'panel:open' event) opens the panel and sends a snapshot
 *     of each section.
 *   - While the panel is open, a 2s poll updates the Status tab
 *     (health/magicka/stamina/gold/RP state), only resending when the value changes.
 *   - Governance/Economy/Social are updated on demand via 'panel:refresh:<section>'.
 */

const db = require('./database');
const commands = require('./commands');
const characterState = require('./core/character-state');
const transactionService = require('./core/transaction-service');
const governance = require('./governance-service');
const marketStalls = require('./market-stalls-service');
const identity = require('./identity-service');
const professionService = require('./profession-service');
const professionRegistry = require('./core/profession-registry');
const soulService = require('./soul-service');
const panelRefreshBus = require('./core/panel-refresh-bus');
// Same reason as death-service: the shape of `self` has a single place.
const { actorRef } = require('./core/papyrus');

const VITALS_POLL_INTERVAL_MS = 2000;
const MAX_PANEL_ALIAS_INPUT_LENGTH = 128;

let initialized = false;
let _vitalsTimer = null;

// actorIds with the panel currently open
const _openPanelActors = new Set();
// actorId -> last serialized status snapshot (for diffing in the poll)
const _lastStatusJson = new Map();

/**
 * actorId -> tab visible right now ('status' | 'governance' | 'economy' | 'social').
 *
 * It exists because of cost, not functionality. Reading health/magicka/stamina
 * costs **three** Papyrus round trips, and each one costs tens of milliseconds —
 * the Red House RP server measured 13–35 ms per call
 * (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1). Before this the loop read all three
 * for **every** open panel every 2 s, even for someone looking at the
 * Social tab: with 10 open panels that is 30 calls per window, ~450 ms
 * spent updating a number nobody is looking at.
 *
 * The information to avoid that was already arriving and being discarded: `player-panel.js`
 * sends `panel:refresh:<tab>` every time the player switches tabs
 * (`switchTab`). The server only needed to remember which one was last.
 */
const _activeTab = new Map();

/** Tab the panel shows when it opens — see `renderTab` in skymp/ui/player-panel.js. */
const ABA_INICIAL = 'status';

// ─────────────────────────────────────────────────────────────────────────────
// Reading data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads current health/magicka/stamina via Papyrus (same pattern as death-service.js).
 * @param {number} actorId
 */
function readVitals(actorId) {
  if (typeof mp === 'undefined') return { health: 0, magicka: 0, stamina: 0 };
  try {
    const self = actorRef(actorId);
    // `Actor.GetActorValue` NÃO existe neste SkyMP (core/skymp-adapter/
    // papyrus-catalog.js) e devolvia null. GetActorValuePercentage existe e
    // devolve 0..1 — exatamente a escala 0..100 que as barras do painel usam.
    const pct = (av) => {
      const v = mp.callPapyrusFunction('method', 'Actor', 'GetActorValuePercentage', self, [av]);
      return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 100) : 0;
    };
    return { health: pct('Health'), magicka: pct('Magicka'), stamina: pct('Stamina') };
  } catch (err) {
    console.error('[player-panel] Failed to read vitals:', err.message);
    return { health: 0, magicka: 0, stamina: 0 };
  }
}

async function buildStatusSnapshot(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) return null;

  const gold = await transactionService.getGold(character.characterId);
  const state = characterState.get(character.characterId);
  const metadata = characterState.getMetadata(character.characterId);

  return {
    name: `${character.firstName} ${character.lastName}`,
    gold,
    state,
    metadata,
    vitals: readVitals(actorId)
  };
}

async function buildSocialSnapshot(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) return null;

  const known = await db.query(
    `SELECT target_character_id, display_name, source, updated_at
     FROM character_known_identities
     WHERE observer_character_id = ?
     ORDER BY updated_at DESC LIMIT 20`,
    [character.characterId]
  ).catch(() => []);

  return {
    knownPeople: known.map(k => ({
      characterId: k.target_character_id,
      name: k.display_name,
      source: k.source,
      at: k.updated_at
    })),
    hint: 'Use the interaction menu on another player to trade, introduce yourself or form a group.'
  };
}

/**
 * PLAYER_ACTION_SHORTCUTS_PLAN.md Phase 4: `/professions` as a tab, not just a
 * command. Same read the command already does (`getCharacterProfessions` +
 * `professionRegistry` for the label) — it does not duplicate logic, it just reuses it.
 */
async function buildProfessionsSnapshot(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) return null;

  const estados = await professionService.getCharacterProfessions(character.characterId);
  return {
    professions: estados.map((estado) => {
      const prof = professionRegistry.get(estado.professionCode);
      return {
        code: estado.professionCode,
        label: prof ? prof.label : estado.professionCode,
        status: estado.status,
        rank: estado.rank,
        xp: estado.xp
      };
    })
  };
}

/**
 * PLAYER_ACTION_SHORTCUTS_PLAN.md Phase 4: `/soul` as a tab. `buildPanelPayload`
 * already existed in `soul-service.js` — the name already said "panel", it just never had
 * a real panel calling it. Zero new logic here.
 */
async function buildSoulSnapshot(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) return null;
  return soulService.buildPanelPayload(character.characterId);
}

/**
 * Renames (gives a nickname to) an already known person directly from the panel's Social tab.
 * It does not require the target to be online — `character_known_identities` is indexed
 * by characterId, so this works even with the target disconnected — BUT it requires
 * a prior known entry (an earlier introduction/nickname) for that
 * target, otherwise any characterId (1..N) could be swept to break the
 * anonymity/disguise system. See identity-service.getKnownDisplayName.
 * @param {number} actorId
 * @param {number} targetCharacterId
 * @param {string} alias
 * @returns {Promise<boolean>}
 */
async function renameKnownPerson(actorId, targetCharacterId, alias) {
  const myCharacter = commands.getActiveCharacterData(actorId);
  if (!myCharacter) return false;

  const cleanAlias = identity.sanitizeDisplayName(alias);
  const parsedTargetId = Number(targetCharacterId);
  if (!cleanAlias || !Number.isFinite(parsedTargetId) || parsedTargetId <= 0) return false;

  const alreadyKnown = await db.query(
    'SELECT 1 FROM character_known_identities WHERE observer_character_id = ? AND target_character_id = ? LIMIT 1',
    [myCharacter.characterId, parsedTargetId]
  ).catch(() => []);
  if (alreadyKnown.length === 0) return false;

  await identity.upsertKnownIdentity(myCharacter.characterId, parsedTargetId, cleanAlias, 'alias');
  await identity.auditIdentityEvent(
    myCharacter.accountId,
    null,
    'identity:alias',
    `via_panel observerCharacterId=${myCharacter.characterId} targetCharacterId=${parsedTargetId} alias=${cleanAlias}`
  );

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sending to the UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * actorId -> { [channel]: data } — every section last sent to that player.
 *
 * Until 19/11/2026 each section was its own `mp.set(actorId, 'panelData',
 * { channel, data })`. `pushAllSections` fires six of those back to back, and a
 * SkyMP property only replicates its LATEST value, so the client typically saw
 * one section (often not Status: "No data received from the server yet" in
 * game). Now the property always carries every section, and a later set can
 * only add to what the client gets, never erase it.
 */
const _panelChannels = new Map();

/**
 * Plain-JSON copy of a section. Property values travel as JSON: a BigInt
 * would throw and fail the WHOLE panelData set (every section rides in one
 * value), Dates and other objects must become plain data. A section that
 * still cannot be serialized is dropped and named in the log.
 * @returns {{ok:true, value:any}|{ok:false, error:string}}
 */
function toPlainJson(data) {
  try {
    const json = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    return { ok: true, value: json === undefined ? null : JSON.parse(json) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendPanelData(actorId, channel, data) {
  if (typeof mp === 'undefined') return;
  const plain = toPlainJson(data);
  if (!plain.ok) {
    console.error(`[player-panel] Section '${channel}' for 0x${actorId.toString(16)} is not serializable, skipped: ${plain.error}`);
    return;
  }
  const channels = _panelChannels.get(actorId) || {};
  channels[channel] = plain.value;
  _panelChannels.set(actorId, channels);
  try {
    mp.set(actorId, 'panelData', { channels: { ...channels }, sentAt: Date.now() });
  } catch (err) {
    console.error(`[player-panel] Failed to send panelData (sections: ${Object.keys(channels).join(', ')}):`, err.message);
  }
}

async function pushStatus(actorId) {
  const snapshot = await buildStatusSnapshot(actorId);
  if (!snapshot) return;
  _lastStatusJson.set(actorId, JSON.stringify(snapshot));
  sendPanelData(actorId, 'status', snapshot);
}

async function pushGovernance(actorId) {
  const snapshot = await governance.getMyGovernanceSummary(actorId);
  if (!snapshot) return;
  sendPanelData(actorId, 'governance', snapshot);
}

async function pushEconomy(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) return;

  const [gold, marketSummary] = await Promise.all([
    transactionService.getGold(character.characterId),
    marketStalls.getMyEconomySummary(actorId)
  ]);

  sendPanelData(actorId, 'economy', { gold, ...(marketSummary || {}) });
}

async function pushSocial(actorId) {
  const snapshot = await buildSocialSnapshot(actorId);
  if (!snapshot) return;
  sendPanelData(actorId, 'social', snapshot);
}

async function pushProfessions(actorId) {
  const snapshot = await buildProfessionsSnapshot(actorId);
  if (!snapshot) return;
  sendPanelData(actorId, 'professions', snapshot);
}

async function pushSoul(actorId) {
  const snapshot = await buildSoulSnapshot(actorId);
  if (!snapshot) return;
  sendPanelData(actorId, 'soul', snapshot);
}

async function pushAllSections(actorId) {
  // allSettled: one failing section (a module query throwing) must not hide
  // the others, and each failure is named in the log.
  const sections = [
    ['status', pushStatus], ['governance', pushGovernance], ['economy', pushEconomy],
    ['social', pushSocial], ['professions', pushProfessions], ['soul', pushSoul]
  ];
  const results = await Promise.allSettled(sections.map(([, push]) => push(actorId)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[player-panel] Section '${sections[i][0]}' failed for 0x${actorId.toString(16)}:`, r.reason && r.reason.message);
    }
  });
}

const PUSH_BY_CHANNEL = {
  status: pushStatus,
  governance: pushGovernance,
  economy: pushEconomy,
  social: pushSocial,
  professions: pushProfessions,
  soul: pushSoul
};

/**
 * Reacts to panelRefreshBus.requestRefresh(actorId, channel) — fired by
 * other services (e.g. governance-service after a fine/arrest) when something
 * changes for a player. It only pushes data if their panel is open;
 * otherwise it does nothing (avoids forcing the panel open).
 * @param {number} actorId
 * @param {string} channel
 */
function handlePanelRefreshRequest(actorId, channel) {
  if (!_openPanelActors.has(actorId)) return;
  const push = PUSH_BY_CHANNEL[channel];
  if (!push) return;
  push(actorId).catch(err => console.error('[player-panel] Failed to react to a requested refresh:', err.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// Vitals polling (only for whoever has the panel open)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who the vitals loop needs to read on this tick.
 *
 * Only those **with the Status tab visible**. The diffing that already existed
 * (`_lastStatusJson`) avoids resending identical data, but the cost is not in sending
 * — it is in building the snapshot, which is three Papyrus calls plus a gold
 * query. Diffing after paying the cost does not save the cost.
 */
function _atoresQuePrecisamDeVitals() {
  const alvos = [];
  for (const actorId of _openPanelActors) {
    if ((_activeTab.get(actorId) || ABA_INICIAL) === 'status') alvos.push(actorId);
  }
  return alvos;
}

/**
 * One tick of the vitals loop. A named function (instead of the inline body of
 * `setInterval`) so the test can exercise a tick without waiting 2 real seconds
 * — and, above all, so it can COUNT the Papyrus calls it fires,
 * which is what the optimization changed.
 */
async function _tickVitals() {
  for (const actorId of _atoresQuePrecisamDeVitals()) {
    try {
      const snapshot = await buildStatusSnapshot(actorId);
      if (!snapshot) continue;
      const json = JSON.stringify(snapshot);
      if (_lastStatusJson.get(actorId) === json) continue;
      _lastStatusJson.set(actorId, json);
      sendPanelData(actorId, 'status', snapshot);
    } catch (err) {
      console.error('[player-panel] Status polling failed:', err.message);
    }
  }
}

function startVitalsLoop() {
  if (_vitalsTimer) return;
  _vitalsTimer = setInterval(() => {
    _tickVitals().catch(err => console.error('[player-panel] Vitals tick failed:', err.message));
  }, VITALS_POLL_INTERVAL_MS);
}

function stopVitalsLoop() {
  if (_vitalsTimer) clearInterval(_vitalsTimer);
  _vitalsTimer = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function openPanel(actorId) {
  if (typeof mp !== 'undefined') {
    mp.set(actorId, 'browserVisible', true);
    mp.set(actorId, 'browserFocused', true);
  }
  _openPanelActors.add(actorId);
  // The UI opens on Status; without recording that, the first tick would skip the panel
  // of whoever just opened it and health would stay frozen until the first tab switch.
  _activeTab.set(actorId, ABA_INICIAL);
  console.log(`[player-panel] open requested by 0x${actorId.toString(16)}`);
  pushAllSections(actorId)
    .then(() => {
      const sent = Object.keys(_panelChannels.get(actorId) || {});
      console.log(`[player-panel] sent to 0x${actorId.toString(16)}: ${sent.length ? sent.join(', ') : 'NOTHING (no active character?)'}`);
    })
    .catch(err => console.error('[player-panel] Failed to open panel:', err.message));
}

/**
 * Removes the actorId from panel tracking (call it when the player disconnects).
 * @param {number} actorId
 */
function cleanup(actorId) {
  _openPanelActors.delete(actorId);
  _lastStatusJson.delete(actorId);
  _activeTab.delete(actorId);
  _panelChannels.delete(actorId);
}

/**
 * Closing the panel must hand keyboard/mouse back to the game. `openPanel`
 * sets `browserFocused = true`, whose client snippet re-applies its value on
 * every update — nothing ever set it back, so after the first open the CEF
 * kept focus: game keys (F2 included, see player-shortcuts-service.js) were
 * ignored and the panel "sometimes" would not reopen.
 */
function closePanel(actorId) {
  cleanup(actorId);
  if (typeof mp !== 'undefined') {
    try { mp.set(actorId, 'browserFocused', false); } catch (err) {
      console.error('[player-panel] Failed to release browser focus:', err.message);
    }
  }
}

/**
 * The panel receives JSON from the CEF. Keeping the schema next to the handler prevents a
 * new UI field from accidentally becoming free input to the DB layer.
 * @param {unknown} data
 * @returns {{ok: true, targetCharacterId: number, alias: string}|{ok: false}}
 */
function validateRenamePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false };

  /** @type {{targetCharacterId?: unknown, alias?: unknown}} */
  const payload = /** @type {any} */ (data);
  const { targetCharacterId, alias } = payload;
  if (typeof targetCharacterId !== 'number' || !Number.isSafeInteger(targetCharacterId) || targetCharacterId <= 0) return { ok: false };
  if (typeof alias !== 'string' || alias.length > MAX_PANEL_ALIAS_INPUT_LENGTH) return { ok: false };

  const cleanAlias = identity.sanitizeDisplayName(alias);
  return cleanAlias ? { ok: true, targetCharacterId, alias: cleanAlias } : { ok: false };
}

/**
 * UI→server event handler for the 'panel' namespace.
 * Registered in core/ui-event-router.
 * @param {number} actorId
 * @param {{type: string, data?: object}} uiEvent
 * @returns {Promise<boolean>}
 */
async function handleUiEvent(actorId, uiEvent) {
  if (!uiEvent || typeof uiEvent.type !== 'string') return false;

  // `panel:refresh:<tab>` is sent by the UI's `switchTab` on every tab switch.
  // Remembering which one was last is what lets the vitals loop skip whoever is not
  // looking at Status — see `_activeTab`.
  const trocaDeAba = /^panel:refresh:(status|governance|economy|social|professions|soul)$/.exec(uiEvent.type);
  if (trocaDeAba) _activeTab.set(actorId, trocaDeAba[1]);

  switch (uiEvent.type) {
    case 'panel:open':
      openPanel(actorId);
      return true;
    case 'panel:close':
      closePanel(actorId);
      return true;
    case 'panel:refresh:status':
      await pushStatus(actorId);
      return true;
    case 'panel:refresh:governance':
      await pushGovernance(actorId);
      return true;
    case 'panel:refresh:economy':
      await pushEconomy(actorId);
      return true;
    case 'panel:refresh:social':
      await pushSocial(actorId);
      return true;
    case 'panel:refresh:professions':
      await pushProfessions(actorId);
      return true;
    case 'panel:refresh:soul':
      await pushSoul(actorId);
      return true;
    case 'panel:social:rename': {
      const payload = validateRenamePayload(uiEvent.data);
      if (!payload.ok) {
        commands.sendNotification(actorId, 'Invalid nickname.');
        return true;
      }
      const renamed = await renameKnownPerson(actorId, payload.targetCharacterId, payload.alias);
      if (renamed) await pushSocial(actorId);
      else commands.sendNotification(actorId, 'Could not change that nickname.');
      return true;
    }
    default:
      return false;
  }
}

function commandDefs() {
  return [
    {
      name: ['/panel', '/painel'],
      description: 'Opens the player panel (status, law, belongings, social)',
      usage: '/panel',
      handler: (actorId) => openPanel(actorId)
    }
  ];
}

async function initPlayerPanelService() {
  startVitalsLoop();
  panelRefreshBus.onRefresh(handlePanelRefreshRequest);
  initialized = true;
  console.log('[player-panel] Player panel service initialized.');
}

function shutdownPlayerPanelService() {
  stopVitalsLoop();
  panelRefreshBus.offRefresh(handlePanelRefreshRequest);
  _openPanelActors.clear();
  _lastStatusJson.clear();
  _activeTab.clear();
  initialized = false;
}

module.exports = {
  commandDefs,
  initPlayerPanelService,
  shutdownPlayerPanelService,
  handleUiEvent,
  openPanel,
  closePanel,
  cleanup,
  sendPanelData,
  buildStatusSnapshot,
  buildSocialSnapshot,
  buildProfessionsSnapshot,
  buildSoulSnapshot,
  renameKnownPerson,
  validateRenamePayload,
  handlePanelRefreshRequest,
  isInitialized: () => initialized,
  // Exposed only for tests: the cost optimization lives in selecting who goes into
  // the tick, and the only way to prove it works is to count the Papyrus
  // calls a tick fires.
  _tickVitals,
  _atoresQuePrecisamDeVitals
};
