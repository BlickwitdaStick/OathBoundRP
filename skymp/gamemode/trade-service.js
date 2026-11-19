/**
 * trade-service.js — trading between players, authoritative on the server
 *
 * ─── What existed before ────────────────────────────────────────────────────
 *
 * 90 lines that negotiated the **invitation** and kept `{initiatorId, targetId,
 * status}` in a `Map`. There was no offer, confirmation, revalidation, transaction,
 * timeout or cleanup on disconnect — and the header itself said the
 * transfer "was never written". See
 * `docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md` §12.
 *
 * ─── The rule that organizes this file ──────────────────────────────────────
 *
 * > **A confirmation is about a specific offer, not about the session.**
 *
 * Every change to an offer increments the session's `version` and drops both
 * confirmations. Without that there is the classic scam: A confirms seeing offer X,
 * B swaps the offer for Y and confirms, and A is led to close a deal they never
 * saw. It is the same reason `canSee` authorizes nothing in the Interaction
 * Framework — what was shown at an earlier instant does not count as
 * authorization now.
 *
 * The commit **revalidates everything from scratch** (distance, state, ownership) and moves both
 * sides in a single `inventory.exchange`. A trade where only one leg commits is a
 * donation.
 *
 * ─── Status: PARKED ─────────────────────────────────────────────────────────
 *
 * This module has a descriptor in `phase0-basic.js` behind
 * `ENABLE_TRADE_SERVICE`, which starts `false`. It has no CEF UI: the chat
 * commands below are the whole interface, and `trade.request` is the only
 * registered interaction. None of this ran in a real session — the same weight that sentence
 * carries in `INTERACTION_FRAMEWORK.md`.
 *
 * ─── Gold ───────────────────────────────────────────────────────────────────
 *
 * §11 of the request: gold in trades **is possible and not done**. When it comes in,
 * it comes through the `tx.*` primitives of `core/transaction-service` inside the same
 * transaction as the `exchange` — which `core/inventory.js` does not expose today, because
 * exposing "touch gold too" in an item API is how `economy-service`
 * started. See `docs/gameplay/TRADE_SYSTEM.md` §7.
 */

const commands = require('./commands');
const inventory = require('./core/inventory');
const rangeUtils = require('./core/range-utils');
const actionPolicy = require('./core/action-policy');
const interactionRegistry = require('./core/interaction-registry');

const MODULE = 'trade';

/**
 * Trade range, in Skyrim units.
 *
 * The same as normal speech, for the same reason as `market-stalls`: whoever can
 * talk can trade. Inventing a number here would repeat the defect that
 * `core/proximity-ranges.js` exists for having fixed.
 */
const TRADE_RANGE = require('./core/proximity-ranges').RANGES.say;

/** A stalled trade dies. §12 of the request: a timeout is mandatory. */
const SESSION_TTL_MS = 3 * 60 * 1000;

/** An unaccepted invitation expires before the session: it is just a tap on the shoulder. */
const INVITE_TTL_MS = 45 * 1000;

/** Cap per side. `core/inventory` has its own (32 in total across both legs). */
const MAX_ITEMS_PER_SIDE = 12;

/**
 * The state machine.
 *
 * `COMMITTING` exists and is not decorative: it is what stops a second
 * `/tradeconfirm`, arriving while the transaction runs, from entering the `exchange`
 * again. `core/inventory`'s idempotency would already protect the DB — this state
 * protects the **session**, which is memory, where the `requestId` does not reach.
 */
const STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  ACTIVE: 'ACTIVE',
  COMMITTING: 'COMMITTING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
});

// ─────────────────────────────────────────────────────────────────────────────
// Session registry
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} sessionId → session */
const _sessions = new Map();

/** @type {Map<number, string>} actorId → sessionId. An index, not an authority. */
const _byActor = new Map();

function now() {
  return Date.now();
}

function notify(actorId, message) {
  commands.sendNotification(actorId, message);
}

/**
 * An actor's live session, already expiring whatever is past its deadline.
 *
 * Expiry happens **on read**, not in a `setInterval`. A timer would have
 * to be turned off in the module's `shutdown` and is one more thing that survives
 * shutdown; lazy expiry has no lifecycle of its own. The cost is
 * that an abandoned session takes up memory until someone touches it — and that is what
 * `sweep()` is for, called on `shutdown`.
 *
 * @param {number} actorId
 * @returns {object|null}
 */
function sessionOf(actorId) {
  const id = _byActor.get(actorId);
  if (!id) return null;

  const session = _sessions.get(id);
  if (!session) {
    _byActor.delete(actorId);
    return null;
  }

  const prazo = session.state === STATES.REQUESTED ? INVITE_TTL_MS : SESSION_TTL_MS;
  if (now() - session.touchedAt > prazo) {
    finish(session, STATES.EXPIRED);
    notify(session.a.actorId, 'The trade expired.');
    notify(session.b.actorId, 'The trade expired.');
    return null;
  }
  return session;
}

/** Ends the session and releases both indexes. */
function finish(session, state) {
  session.state = state;
  _sessions.delete(session.id);
  if (_byActor.get(session.a.actorId) === session.id) _byActor.delete(session.a.actorId);
  if (_byActor.get(session.b.actorId) === session.id) _byActor.delete(session.b.actorId);
}

/** The session side that belongs to this actor, and the other one. */
function sidesOf(session, actorId) {
  return session.a.actorId === actorId
    ? { eu: session.a, outro: session.b }
    : { eu: session.b, outro: session.a };
}

/**
 * Any change to an offer invalidates both confirmations. §10 of the request.
 *
 * The `version` also goes into the commit's `requestId`: if someone managed to
 * fire two commits for different versions, they would have different
 * idempotency keys — and that is why the `COMMITTING` state exists.
 */
function touch(session) {
  session.version += 1;
  session.a.confirmedVersion = null;
  session.b.confirmedVersion = null;
  session.touchedAt = now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fluxo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A asks B to trade.
 *
 * @param {number} actorId
 * @param {number} targetActorId
 */
function requestTrade(actorId, targetActorId) {
  const eu = commands.getActiveCharacterData(actorId);
  if (!eu) return false;

  if (!Number.isSafeInteger(targetActorId) || targetActorId <= 0 || targetActorId === actorId) {
    notify(actorId, 'Invalid target.');
    return false;
  }

  const alvo = commands.getActiveCharacterData(targetActorId);
  if (!alvo) {
    notify(actorId, 'That person is not available.');
    return false;
  }

  if (sessionOf(actorId)) {
    notify(actorId, 'You are already in a trade.');
    return false;
  }
  if (sessionOf(targetActorId)) {
    notify(actorId, 'That person is already in a trade.');
    return false;
  }

  const alcance = rangeUtils.assertRange(actorId, targetActorId, TRADE_RANGE);
  if (!alcance.ok) {
    notify(actorId, alcance.reason || 'Target out of range.');
    return false;
  }

  const session = {
    id: `trade-${inventory.newRequestId('t').slice(2)}`,
    state: STATES.REQUESTED,
    version: 0,
    createdAt: now(),
    touchedAt: now(),
    a: { actorId, characterId: eu.characterId, items: new Map(), confirmedVersion: null },
    b: { actorId: targetActorId, characterId: alvo.characterId, items: new Map(), confirmedVersion: null }
  };

  _sessions.set(session.id, session);
  _byActor.set(actorId, session.id);
  _byActor.set(targetActorId, session.id);

  notify(actorId, 'Trade invitation sent.');
  notify(targetActorId, 'Someone wants to trade with you. Use /tradeaccept to open it.');
  commands.broadcastProximityMessage(actorId, '* Extends a hand, proposing a deal.', 500);
  console.log(`[trade] ${session.id}: ${eu.characterId} -> ${alvo.characterId}`);
  return true;
}

/** B aceita o convite. */
function acceptTrade(actorId) {
  const session = sessionOf(actorId);
  if (!session || session.state !== STATES.REQUESTED) {
    notify(actorId, 'No pending trade invitation.');
    return false;
  }
  // Whoever invited cannot accept their own invitation.
  if (session.a.actorId === actorId) {
    notify(actorId, 'Waiting for the other person to accept.');
    return false;
  }

  session.state = STATES.ACTIVE;
  session.touchedAt = now();
  notify(session.a.actorId, 'Trade opened. Use /tradeadd <baseId> <qty> to make an offer.');
  notify(session.b.actorId, 'Trade opened. Use /tradeadd <baseId> <qty> to make an offer.');
  return true;
}

/**
 * Adds (or removes, with a negative quantity) an item to/from one's own offer.
 *
 * Ownership **is not checked here as an authority** — it is checked at commit,
 * inside the transaction, by the `FOR UPDATE`. The check below exists only to give
 * the right message at the right time: offering what you do not have and finding out three
 * minutes later, at closing, is the kind of silence that makes players give up
 * on the system.
 */
async function addItem(actorId, baseId, quantity) {
  const session = sessionOf(actorId);
  if (!session || session.state !== STATES.ACTIVE) {
    notify(actorId, 'You are not in an open trade.');
    return false;
  }

  if (!Number.isSafeInteger(baseId) || baseId <= 0) {
    notify(actorId, 'Invalid FormID.');
    return false;
  }
  if (!Number.isSafeInteger(quantity) || quantity === 0) {
    notify(actorId, 'Invalid quantity.');
    return false;
  }

  const { eu } = sidesOf(session, actorId);
  const atual = eu.items.get(baseId) || 0;
  const novo = atual + quantity;

  if (novo < 0) {
    notify(actorId, 'You did not offer that quantity.');
    return false;
  }
  if (novo === 0) {
    eu.items.delete(baseId);
  } else {
    if (!eu.items.has(baseId) && eu.items.size >= MAX_ITEMS_PER_SIDE) {
      notify(actorId, `At most ${MAX_ITEMS_PER_SIDE} item types per side.`);
      return false;
    }
    const emMaos = await inventory.getStack(inventory.character(eu.characterId), baseId);
    if (emMaos < novo) {
      notify(actorId, `You have ${emMaos}, tried to offer ${novo}.`);
      return false;
    }
    eu.items.set(baseId, novo);
  }

  touch(session);
  descrever(session);
  return true;
}

/** Sends the current offer to both sides. It is the whole UI, for now. */
function descrever(session) {
  const linha = (lado) => lado.items.size === 0
    ? '(nothing)'
    : [...lado.items.entries()].map(([b, q]) => `0x${b.toString(16)}x${q}`).join(', ');

  const a = linha(session.a);
  const b = linha(session.b);
  notify(session.a.actorId, `Trade v${session.version} — you: ${a} | them: ${b}`);
  notify(session.b.actorId, `Trade v${session.version} — you: ${b} | them: ${a}`);
}

/**
 * Confirms the offer **for this version**.
 *
 * When both confirm the same version, the commit fires.
 */
async function confirmTrade(actorId) {
  const session = sessionOf(actorId);
  if (!session || session.state !== STATES.ACTIVE) {
    notify(actorId, 'You are not in an open trade.');
    return false;
  }

  const { eu, outro } = sidesOf(session, actorId);
  if (eu.items.size === 0 && outro.items.size === 0) {
    notify(actorId, 'There is nothing to trade.');
    return false;
  }

  eu.confirmedVersion = session.version;
  session.touchedAt = now();

  if (outro.confirmedVersion !== session.version) {
    notify(actorId, 'Confirmed. Waiting for the other party.');
    notify(outro.actorId, 'The other party confirmed. Use /tradeconfirm to close the deal.');
    return true;
  }

  return commitTrade(session);
}

/**
 * The closing. **Revalidates everything from scratch** and moves both legs in one transaction.
 *
 * What is revalidated, and why each one:
 *
 * | Revalidation | What happened between the confirmation and now |
 * |---|---|
 * | both still logged in | one dropped — `getActiveCharacterData` stops answering |
 * | same character | one switched characters on the same actor |
 * | distance | one walked away |
 * | state (restrained, jailed) | the guard arrived in the middle of the scene |
 * | ownership | sold it at a stall, dropped it, crafted with the item |
 *
 * The first four belong to this function. The fifth belongs to the `FOR UPDATE` inside
 * `exchange`, and it is the only one that has to — the others have no possible lock.
 */
async function commitTrade(session) {
  session.state = STATES.COMMITTING;

  const falhar = (motivo) => {
    finish(session, STATES.CANCELLED);
    notify(session.a.actorId, `Trade cancelled: ${motivo}`);
    notify(session.b.actorId, `Trade cancelled: ${motivo}`);
    return false;
  };

  for (const lado of [session.a, session.b]) {
    const vivo = commands.getActiveCharacterData(lado.actorId);
    if (!vivo || vivo.characterId !== lado.characterId) {
      return falhar('the other party left.');
    }
  }

  const alcance = rangeUtils.assertRange(session.a.actorId, session.b.actorId, TRADE_RANGE);
  if (!alcance.ok) return falhar(alcance.reason || 'you moved too far apart.');

  for (const lado of [session.a, session.b]) {
    // `core/action-policy` is the authority on "can this character trade
    // right now", and `trade` has been a registered action there since before this file.
    // Calling the policy instead of reading `character-state` directly is what makes
    // restrained, jailed, downed, dead and safe zones apply here without this
    // file needing to know any of the five.
    const veredito = actionPolicy.canPerform(lado.characterId, 'trade', {
      actorId: lado.actorId,
      targetActorId: lado === session.a ? session.b.actorId : session.a.actorId
    });
    if (!veredito.allowed) return falhar(veredito.reason.toLowerCase());
  }

  const legs = [];
  if (session.a.items.size > 0) {
    legs.push({
      from: inventory.character(session.a.characterId, session.a.actorId),
      to: inventory.character(session.b.characterId, session.b.actorId),
      items: [...session.a.items.entries()].map(([baseId, quantity]) => ({ baseId, quantity }))
    });
  }
  if (session.b.items.size > 0) {
    legs.push({
      from: inventory.character(session.b.characterId, session.b.actorId),
      to: inventory.character(session.a.characterId, session.a.actorId),
      items: [...session.b.items.entries()].map(([baseId, quantity]) => ({ baseId, quantity }))
    });
  }

  // The version goes into the key: a v3 commit and a v4 commit are different
  // requests, and must never deduplicate each other.
  const resultado = await inventory.exchange({
    legs,
    reason: 'trade',
    module: MODULE,
    requestId: `${session.id}.v${session.version}`
  });

  if (!resultado.ok) {
    return falhar(resultado.reason);
  }

  finish(session, STATES.COMPLETED);
  notify(session.a.actorId, 'Deal closed.');
  notify(session.b.actorId, 'Deal closed.');
  commands.broadcastProximityMessage(session.a.actorId, '* Shakes hands, sealing the deal.', 500);
  console.log(`[trade] ${session.id} concluida (transfer=${resultado.transferId})`);
  return true;
}

/** Either of the two cancels, at any moment before `COMMITTING`. */
function cancelTrade(actorId, motivo = 'the trade was cancelled.') {
  const session = sessionOf(actorId);
  if (!session) return false;
  if (session.state === STATES.COMMITTING) {
    notify(actorId, 'The trade is already being closed.');
    return false;
  }

  finish(session, STATES.CANCELLED);
  notify(session.a.actorId, motivo);
  notify(session.b.actorId, motivo);
  return true;
}

/**
 * Disconnect. **The item was never in custody**, so there is nothing to
 * return: the offers are intent in memory, and the trade only moves items on
 * commit. This is why the offer is not "deposited" into a session — a
 * custody model would need a table and a recovery path
 * for items stuck in a session that died with the server.
 *
 * Called by the module's `initialize()`, via `commands.removeActiveCharacter`.
 */
function onDisconnect(actorId) {
  const id = _byActor.get(actorId);
  if (!id) return;
  const session = _sessions.get(id);
  if (!session) {
    _byActor.delete(actorId);
    return;
  }
  if (session.state === STATES.COMMITTING) return; // deixa o commit terminar
  finish(session, STATES.CANCELLED);
  const { outro } = sidesOf(session, actorId);
  notify(outro.actorId, 'The other party left. Trade cancelled.');
}

/** Ends everything. Called on the module's `shutdown`. */
function sweep() {
  for (const session of [..._sessions.values()]) {
    finish(session, STATES.EXPIRED);
  }
  _byActor.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers `trade.request` in the Interaction Framework.
 *
 * Only the invitation is an interaction: the rest of the trade happens inside a session that
 * already has both sides, and a context menu about the other player is not the
 * place for "add an item to my offer".
 */
function registerInteractions() {
  interactionRegistry.register({
    id: 'trade.request',
    module: MODULE,
    target: interactionRegistry.TARGET_TYPES.PLAYER,
    label: 'Propose a trade',
    section: 'social',
    order: 20,
    distance: TRADE_RANGE,
    policyAction: 'trade',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    idempotent: false,
    // Disappears from the menu of whoever is already in a trade, on both sides. A button that only
    // answers "you are already in a trade" teaches the player to ignore the menu.
    canSee: async ctx => !sessionOf(ctx.actorId) && !sessionOf(ctx.target.actorId),
    execute: async ctx => {
      const ok = requestTrade(ctx.actorId, ctx.target.actorId);
      return { message: ok ? 'Invitation sent.' : 'Could not propose the trade.' };
    }
  });
}

/**
 * Bridge to the CEF's `trade-overlay` (`index.html`) — same shape as
 * `player-panel-service.js handleUiEvent`. Until 2026-08-22 the overlay's "Close"
 * button called `mp.trigger('cef::trade:cancel', {})`, which had
 * NO server-side listener (grep confirmed) — accept/confirm/cancel
 * depended 100% on typed `/tradeaccept`/`/tradeconfirm`/`/tradecancel`,
 * even with a UI on screen suggesting otherwise. See
 * `docs/technical/PLAYER_ACTION_SHORTCUTS_PLAN.md` Phase 1.
 *
 * The three functions (`acceptTrade`/`confirmTrade`/`cancelTrade`) already exist and
 * are already what the text commands call — this does not duplicate logic, it only
 * gives it a second caller.
 * @param {number} actorId
 * @param {{type?: string}} uiEvent
 * @returns {Promise<boolean>|boolean}
 */
function handleUiEvent(actorId, uiEvent) {
  if (!uiEvent || typeof uiEvent.type !== 'string') return false;

  switch (uiEvent.type) {
    case 'trade:accept':
      return acceptTrade(actorId);
    case 'trade:confirm':
      return confirmTrade(actorId);
    case 'trade:cancel':
      return cancelTrade(actorId);
    default:
      return false;
  }
}

function commandDefs() {
  return [
    {
      name: '/trade',
      description: '[Trade] Proposes a trade to someone',
      usage: '/trade <actorId>',
      handler: (actorId, args) => {
        const alvo = Number.parseInt(String(args).trim().replace(/^0x/i, ''), 16);
        if (!Number.isSafeInteger(alvo)) return notify(actorId, 'Usage: /trade <actorId>');
        requestTrade(actorId, alvo);
      }
    },
    {
      name: '/tradeaccept',
      description: '[Trade] Accepts the pending invitation',
      usage: '/tradeaccept',
      handler: (actorId) => acceptTrade(actorId)
    },
    {
      name: '/tradeadd',
      description: '[Trade] Adds an item to your offer (negative quantity removes)',
      usage: '/tradeadd <baseId> <qty>',
      handler: (actorId, args) => {
        const [bruto, qtd] = String(args).trim().split(/\s+/);
        const baseId = Number.parseInt(String(bruto || '').replace(/^0x/i, ''), 16);
        const quantity = Number.parseInt(qtd, 10);
        if (!Number.isSafeInteger(baseId) || !Number.isSafeInteger(quantity)) {
          return notify(actorId, 'Usage: /tradeadd <baseId> <qty>');
        }
        return addItem(actorId, baseId, quantity);
      }
    },
    {
      name: '/tradeconfirm',
      description: '[Trade] Confirms the current offer',
      usage: '/tradeconfirm',
      handler: (actorId) => confirmTrade(actorId)
    },
    {
      name: '/tradecancel',
      description: '[Trade] Cancels the trade',
      usage: '/tradecancel',
      handler: (actorId) => cancelTrade(actorId)
    }
  ];
}

module.exports = {
  STATES,
  SESSION_TTL_MS,
  INVITE_TTL_MS,
  TRADE_RANGE,
  MAX_ITEMS_PER_SIDE,

  requestTrade,
  acceptTrade,
  addItem,
  confirmTrade,
  cancelTrade,
  onDisconnect,
  sweep,

  registerInteractions,
  commandDefs,
  handleUiEvent,

  // Test only: the session is memory, and the test needs to age it without
  // waiting three minutes and to inspect the state without going through the UI.
  _sessions,
  _sessionOf: sessionOf
};
