/**
 * core/action-policy.js
 *
 * Central action policy — the single source of truth about
 * "who can do what in which state".
 *
 * EVERY gameplay action MUST be validated here before running.
 * No individual service should implement its own state checks.
 *
 * Usage:
 *   const { allowed, reason } = actionPolicy.canPerform(characterId, 'woodcutting');
 *   if (!allowed) { sendNotification(actorId, reason); return; }
 */

const characterState = require('./character-state');
// Touches `mp` (guarded) and reads config from disk; that is why it lives in its own module
// instead of inside this one, which must stay testable without a server.
const safeZones = require('./safe-zones');
const { STATES } = characterState;

// ─────────────────────────────────────────────────────────────────────────────
// State restriction definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of states → list of action categories BLOCKED in that state.
 * An action can belong to several categories.
 */
const STATE_RESTRICTIONS = {
  [STATES.RESTRAINED]: {
    blocked: ['gameplay', 'combat', 'trade', 'craft', 'gather', 'move', 'use_item'],
    message: 'You are restrained and cannot do that.'
  },
  [STATES.IMPRISONED]: {
    blocked: ['trade', 'craft', 'gather', 'work', 'combat', 'move_world', 'sell'],
    message: 'You are imprisoned and cannot do that.'
  },
  [STATES.DOWNED]: {
    blocked: ['gameplay', 'combat', 'trade', 'craft', 'gather', 'move', 'use_item', 'speak_rp'],
    message: 'You are downed and cannot act. Wait for help.'
  },
  [STATES.DEAD]: {
    blocked: ['gameplay', 'combat', 'trade', 'craft', 'gather', 'move', 'use_item', 'speak_rp'],
    message: 'You are dead.'
  },
  [STATES.IN_TRADE]: {
    blocked: ['gather', 'work', 'craft', 'combat', 'move_world'],
    message: 'You are in a trade. Cancel it before doing that.'
  },
  [STATES.IN_CRAFT]: {
    blocked: ['gather', 'work', 'trade', 'combat', 'move_world'],
    message: 'You are crafting an item. Finish or cancel it first.'
  },
  [STATES.IN_DIALOG]: {
    blocked: ['gather', 'work', 'trade', 'craft', 'combat'],
    message: 'You are in a conversation. Finish it first.'
  },
  [STATES.BUSY]: {
    blocked: ['gather', 'work', 'craft', 'trade', 'combat'],
    message: 'You are busy with something else.'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Action registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central registry of actions and their categories.
 * Each action belongs to one or more of the categories used in the restrictions above.
 *
 * Shape: actionId → { categories: string[], label: string }
 */
const _actions = new Map();

/**
 * Registers an action in the policy.
 * Called by modules when they initialize via module-registry.
 *
 * @param {string} actionId - Unique action identifier (e.g. 'woodcutting')
 * @param {string[]} categories - Action categories (e.g. ['gameplay', 'gather'])
 * @param {string} label - Human-readable name for error messages
 */
function registerAction(actionId, categories, label) {
  _actions.set(actionId, { categories, label });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-registered CORE actions (always available)
// ─────────────────────────────────────────────────────────────────────────────
registerAction('speak',       ['speak_rp'],           'Speak');
registerAction('whisper',     ['speak_rp'],           'Whisper');
registerAction('shout',       ['speak_rp'],           'Shout');
registerAction('me',          ['speak_rp'],           '/me');
registerAction('do',          ['speak_rp'],           '/do');
registerAction('try',         ['speak_rp'],           '/try');
registerAction('introduce',   ['speak_rp'],           'Introduce yourself');
registerAction('alias',       ['speak_rp'],           'Give a nickname');
registerAction('woodcutting', ['gameplay', 'gather'], 'Chop wood');
registerAction('mining',      ['gameplay', 'gather'], 'Mine');
registerAction('fishing',     ['gameplay', 'gather'], 'Fish');
registerAction('craft',       ['gameplay', 'craft'],  'Craft');
registerAction('trade',       ['gameplay', 'trade'],  'Trade');
registerAction('sell',        ['gameplay', 'sell'],   'Sell');
registerAction('buy',         ['gameplay', 'sell'],   'Buy');
registerAction('move_world',  ['move', 'move_world'], 'Move between cells');
registerAction('use_item',    ['use_item'],            'Use item');
registerAction('eat',         ['use_item'],            'Eat');
registerAction('drink',       ['use_item'],            'Drink');
registerAction('sleep',       ['use_item'],            'Sleep');
registerAction('public_work', ['gameplay', 'work'],    'Public work');

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a character can perform an action.
 *
 * Two dimensions, in this order:
 *
 *   1. The character's **state** — restrained, downed, imprisoned. Always checked.
 *   2. The **place** they are in — safe zone. Only checked when the caller
 *      passes `context.actorId`, because location belongs to the actor and this function
 *      receives `characterId`.
 *
 * State comes first on purpose: "you are restrained" is a better explanation
 * than "this is a safe zone" for someone restrained inside one.
 *
 * @param {number} characterId
 * @param {string} actionId - ID of the registered action
 * @param {object} [context]
 * @param {number} [context.actorId] - enables the place check
 * @param {number} [context.targetActorId] - checks both sides (see safe-zones.blocksBetween)
 * @returns {{ allowed: boolean, reason: string }}
 */
function canPerform(characterId, actionId, context = {}) {
  const action = _actions.get(actionId);
  if (!action) {
    // Unregistered action — block it for safety
    return { allowed: false, reason: `Unknown action: ${actionId}` };
  }

  const currentState = characterState.get(characterId);
  const restrictions = STATE_RESTRICTIONS[currentState];

  if (restrictions) {
    // Check whether any of the action's categories is blocked by the current state
    const isBlocked = action.categories.some(cat => restrictions.blocked.includes(cat));
    if (isBlocked) {
      return { allowed: false, reason: restrictions.message };
    }
  }

  // Place. Only applies when the caller passes the actorId — all older callers
  // keep working exactly as before, without a place check.
  if (context.actorId !== undefined && context.actorId !== null) {
    for (const categoria of action.categories) {
      const veredito = context.targetActorId !== undefined && context.targetActorId !== null
        ? safeZones.blocksBetween(context.actorId, context.targetActorId, categoria)
        : safeZones.blocksCategory(context.actorId, categoria);

      if (veredito.blocked) {
        // The message says whose protection it is when it is not the actor's —
        // without this, attacking someone protected would return "you are in a safe
        // zone", which is confusing and looks like a bug.
        const onde = veredito.zone.label;
        return {
          allowed: false,
          reason: veredito.side === 'target'
            ? `Your target is under the protection of ${onde}.`
            : `You are in ${onde} and can't do that here.`
        };
      }
    }
  }

  return { allowed: true, reason: '' };
}

/**
 * Checks an action and throws if it is not allowed.
 * Useful for code that prefers exceptions.
 *
 * @param {number} characterId
 * @param {string} actionId
 * @param {object} [context]
 * @throws {Error} If the action is not allowed
 */
function assertCanPerform(characterId, actionId, context = {}) {
  const result = canPerform(characterId, actionId, context);
  if (!result.allowed) throw new Error(result.reason);
}

/**
 * Returns every registered action (for debug/staff).
 */
function listActions() {
  return Array.from(_actions.entries()).map(([id, info]) => ({ id, ...info }));
}

module.exports = { canPerform, assertCanPerform, registerAction, listActions };
