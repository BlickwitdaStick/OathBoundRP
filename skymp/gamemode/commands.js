const db = require('./database');
const identity = require('./identity-service');
const { createRpChatService } = require('./rp-chat-service');
const commandRegistry = require('./core/command-registry');
const characterState = require('./core/character-state');
const inventoryService = require('./inventory-service');

// In-memory cache of the characters active on the server
// Key: actorId (number), Value: { characterId, firstName, lastName, accountId, profileId }
const activeCharacters = new Map();

function registerActiveCharacter(actorId, character, accountId, profileId) {
  activeCharacters.set(actorId, {
    characterId: character.id,
    firstName: character.first_name,
    lastName: character.last_name,
    accountId: accountId,
    profileId: profileId
  });
  console.log(`[commands] Cached character name for actor ${actorId.toString(16)}: ${character.first_name} ${character.last_name}`);
  identity.loadKnownIdentities(character.id);
}

function getActiveCharacterData(actorId) {
  return activeCharacters.get(actorId) || null;
}

/**
 * actorIds with a loaded character, right now.
 *
 * `death-service` answers the same question by sweeping up to 50 profileIds with
 * `mp.getActorsByProfileId` — which costs one API call per profileId and also returns
 * whoever has no character. This map already knows the exact answer for free:
 * it is written on login and cleared in `removeActiveCharacter`.
 *
 * Returns a copy: whoever iterates must not hold a reference to the internal Map, which
 * is mutated by login and logout in the middle of any loop.
 */
function listActiveActorIds() {
  return [...activeCharacters.keys()];
}

function getActiveActorByCharacterId(characterId) {
  for (const [actorId, character] of activeCharacters.entries()) {
    if (character.characterId === characterId) {
      return actorId;
    }
  }
  return null;
}

function removeActiveCharacter(actorId) {
  if (activeCharacters.has(actorId)) {
    const char = activeCharacters.get(actorId);
    console.log(`[commands] Removed cached character for actor ${actorId.toString(16)}: ${char.firstName} ${char.lastName}`);
    identity.forgetKnownIdentities(char.characterId);
    characterState.cleanup(char.characterId);
    inventoryService.clearSyncCache(char.characterId);

    // admin-service's staffCache is keyed by actorId, not by account — and
    // SkyMP reuses actorIds across sessions. Without clearing it here, the role stayed
    // stuck to the slot: whoever later took the same actorId inherited `ban`,
    // `set_gold` and `retire_character` from an admin who had already left.
    // `registerStaffRole` is only called on login (whitelist.js), so nothing
    // rewrote the stale entry for a regular player.
    //
    // Lazy require for the same reason as the staff handlers below:
    // admin-service requires this module at the top, so importing it up there
    // would close the cycle.
    require('./admin-service').removeStaffRole(actorId);

    // Same class of problem, same reason for the lazy require
    // (death-service requires this module at the top): `_lastHealth` keeps the last
    // health reading per actorId, and the reused slot made the next player's first tick
    // become a fake `damage_spike` in the death context —
    // RDM evidence against someone who never took a hit. See the full
    // explanation in death-service.cleanup().
    require('./death-service').cleanup(actorId);

    // The cached soul is keyed by characterId, so it does not suffer from
    // slot reuse — but a cache that only grows is a leak, and rereading it on the
    // next login costs one query. Behind isEnabled because soul-service
    // throws at boot when SOUL_SECRET is missing: with the flag off, not even the
    // require happens.
    if (require('./core/module-registry').isEnabled('soul')) {
      require('./soul-service').cleanup(char.characterId);
    }

    activeCharacters.delete(actorId);

    // Subscribers registered by modules that may be turned off.
    //
    // The lazy `require`s above are the old way, and it works because
    // those five modules are either core or have `isEnabled` to check. A
    // `lab` module without that treatment — `trade` is the first — cannot go into
    // that list: `commands.js` would come to know by fixed name a service
    // the `module-registry` may not have turned on, which is the coupling
    // `governance-service` cites as the worst possible idea.
    //
    // Here the arrow is reversed, for the same reason as the Interaction Framework: whoever
    // needs to know about disconnects subscribes in `initialize()` and is removed in
    // `shutdown()`. `commands.js` does not know who they are.
    for (const assinante of _characterRemovedSubscribers) {
      try {
        assinante(actorId, char);
      } catch (err) {
        console.error('[commands] Disconnect subscriber failed:', err.message);
      }
    }
  }
}

/** @type {Set<(actorId: number, character: object) => void>} */
const _characterRemovedSubscribers = new Set();

/**
 * Subscribes to a character leaving. Returns the unsubscribe function.
 * @param {(actorId: number, character: object) => void} fn
 */
function onCharacterRemoved(fn) {
  if (typeof fn !== 'function') throw new Error('[commands] invalid subscriber');
  _characterRemovedSubscribers.add(fn);
  return () => _characterRemovedSubscribers.delete(fn);
}

function getCharacterName(actorId) {
  if (activeCharacters.has(actorId)) {
    const char = activeCharacters.get(actorId);
    return `${char.firstName} ${char.lastName}`;
  }
  return `Player_${actorId.toString(16)}`;
}

function getDisplayNameForObserver(sourceActorId, observerActorId) {
  const sourceCharacter = getActiveCharacterData(sourceActorId);
  const observerCharacter = getActiveCharacterData(observerActorId);
  return identity.getDisplayName(observerCharacter, sourceCharacter);
}

async function logRpChatEvent(event) {
  const details = JSON.stringify({
    type: event.type,
    actorId: `0x${event.actorId.toString(16)}`,
    characterId: event.characterId || null,
    message: event.message,
    radius: event.radius
  });

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [`rp_chat:${event.type}`, event.accountId || null, null, details]
    );
  } catch (err) {
    console.log(`[rp-chat-log] ${details}`);
  }
}

// Sends a PRIVATE notification (only the actorId's own screen) through the
// browserModal channel (isVisibleByOwner=true, isVisibleByNeighbors=false — see
// phase0-basic.js). Before this it used the 'global' Debug.Notification, which the
// engine broadcasts to ALL connected clients — leaking criminal records,
// searched inventories and staff messages onto everyone's
// screen. Rendered as a toast by the UI (index.html: handleServerModal).
function sendNotification(actorId, message) {
  if (typeof mp === 'undefined') return;
  try {
    mp.set(actorId, 'browserModal', { type: 'toast', data: { message }, sentAt: Date.now() });
  } catch (err) {
    console.error(`[commands] Failed to send notification to actor ${actorId.toString(16)}:`, err.message);
  }
}

/**
 * A binary-choice notification (accept/refuse), the same `browserModal` channel
 * the toast already uses — PLAYER_ACTION_SHORTCUTS_PLAN.md Phase 5. This file only
 * delivers the invitation for the CEF to draw the two buttons; what "accept" means
 * belongs to the caller (the payload's `acceptEvent`/`denyEvent` is the `uiEvent.type`
 * the CEF sends back on click, and registering a handler for
 * that prefix in `core/ui-event-router.js` is the job of the module that called this, never
 * `commands.js`).
 * @param {number} actorId
 * @param {{title: string, message: string, acceptLabel: string, denyLabel: string, acceptEvent: string, denyEvent: string, eventData?: object}} payload
 */
function sendChoice(actorId, payload) {
  if (typeof mp === 'undefined') return;
  try {
    mp.set(actorId, 'browserModal', { type: 'choice', data: payload, sentAt: Date.now() });
  } catch (err) {
    console.error(`[commands] Failed to send choice to actor ${actorId.toString(16)}:`, err.message);
  }
}

// Broadcasts the message to the author and neighbors within a proximity radius
function renderMessageForRecipient(message, recipientActorId) {
  return typeof message === 'function' ? message(recipientActorId) : message;
}

function broadcastProximityMessage(sourceActorId, message, radius = 1500) {
  const logMessage = typeof message === 'function' ? message(sourceActorId) : message;
  console.log(`[chat-log] Broadcast: "${logMessage}"`);
  
  // 1. Show it to the author themselves
  sendNotification(sourceActorId, renderMessageForRecipient(message, sourceActorId));

  if (typeof mp === 'undefined') return;

  // 2. Show it to the neighbors
  try {
    const neighbors = mp.get(sourceActorId, 'neighbors') || [];
    const sourceLoc = mp.get(sourceActorId, 'locationalData');
    if (!sourceLoc || !sourceLoc.pos) return;
    
    const sourcePos = sourceLoc.pos;
    const sourceCell = sourceLoc.cellOrWorldSpaceId || sourceLoc.cellId || sourceLoc.worldOrCell;

    for (const neighborId of neighbors) {
      if (mp.get(neighborId, 'type') === 'MpActor' && neighborId !== sourceActorId) {
        const neighborLoc = mp.get(neighborId, 'locationalData');
        if (neighborLoc && neighborLoc.pos) {
          const neighborCell = neighborLoc.cellOrWorldSpaceId || neighborLoc.cellId || neighborLoc.worldOrCell;
          if (sourceCell && neighborCell && sourceCell !== neighborCell) {
            continue;
          }

          const neighborPos = neighborLoc.pos;
          
          // 3D Euclidean distance
          const dx = sourcePos[0] - neighborPos[0];
          const dy = sourcePos[1] - neighborPos[1];
          const dz = sourcePos[2] - neighborPos[2];
          const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
          
          if (distance <= radius) {
            sendNotification(neighborId, renderMessageForRecipient(message, neighborId));
          }
        }
      }
    }
  } catch (err) {
    console.error(`[commands] Failed to broadcast message:`, err.message);
  }
}

const rpChat = createRpChatService({
  getCharacterName,
  getDisplayName: getDisplayNameForObserver,
  getCharacterData: getActiveCharacterData,
  sendNotification,
  broadcastProximityMessage,
  logEvent: logRpChatEvent
});

function parseActorId(raw) {
  if (!raw) return NaN;
  const normalized = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
  return Number.parseInt(normalized, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE commands (always active, regardless of modules)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Range of an introduction, in Skyrim units.
 *
 * The same as the `broadcastProximityMessage` that announces the scene right below, and
 * it has to stay that way: introducing yourself from a distance at which nobody reads
 * `* so-and-so introduces themselves` would be an introduction without a scene.
 */
const INTRODUCE_RANGE = 450;

async function handleIntroduceCommand(actorId, args) {
  const targetActorId = parseActorId(args);
  const sourceCharacter = getActiveCharacterData(actorId);
  const targetCharacter = getActiveCharacterData(targetActorId);

  if (!sourceCharacter) {
    sendNotification(actorId, 'Your character is not loaded yet.');
    return;
  }
  if (!targetCharacter || targetActorId === actorId) {
    sendNotification(actorId, 'Usage: /introduce <actorId>');
    return;
  }

  const realName = identity.getCharacterFullName(sourceCharacter);
  await identity.upsertKnownIdentity(
    targetCharacter.characterId,
    sourceCharacter.characterId,
    realName,
    'introduced'
  );
  await identity.auditIdentityEvent(
    sourceCharacter.accountId,
    targetCharacter.accountId,
    'identity:introduce',
    `sourceCharacterId=${sourceCharacter.characterId} targetCharacterId=${targetCharacter.characterId}`
  );

  sendNotification(actorId, `You introduced yourself to ${getDisplayNameForObserver(targetActorId, actorId)}.`);
  sendNotification(targetActorId, `${realName} introduced themselves to you.`);
  broadcastProximityMessage(
    actorId,
    (observerActorId) => `* ${getDisplayNameForObserver(actorId, observerActorId)} introduces themselves.`,
    INTRODUCE_RANGE
  );
}

async function handleAliasCommand(actorId, args) {
  const parts = args.split(' ');
  const targetActorId = parseActorId(parts[0]);
  const alias = identity.sanitizeDisplayName(parts.slice(1).join(' '));
  const sourceCharacter = getActiveCharacterData(actorId);
  const targetCharacter = getActiveCharacterData(targetActorId);

  if (!sourceCharacter || !targetCharacter || targetActorId === actorId || !alias) {
    sendNotification(actorId, 'Usage: /alias <actorId> <known name>');
    return;
  }

  await identity.upsertKnownIdentity(
    sourceCharacter.characterId,
    targetCharacter.characterId,
    alias,
    'alias'
  );
  await identity.auditIdentityEvent(
    sourceCharacter.accountId,
    targetCharacter.accountId,
    'identity:alias',
    `observerCharacterId=${sourceCharacter.characterId} targetCharacterId=${targetCharacter.characterId} alias=${alias}`
  );

  sendNotification(actorId, `You will now recognize this person as: ${alias}.`);
}

/**
 * `identity.introduce` in the Interaction Framework.
 *
 * ─── Why this interaction exists ────────────────────────────────────────────
 *
 * Until 2026-08-13 "Introduce yourself" was a button the **CEF** made up:
 * `DEFAULT_INTERACTION_SECTIONS` in `skymp/ui/index.html` added three
 * actions to the server's, unconditionally, for every target. Two of them were
 * dead buttons (`/trade` and `/groupinvite`, which did not exist) and were removed;
 * this was the only live one, and it was still an action that showed up without the
 * server having authorized anything.
 *
 * By registering it here, the menu list comes **entirely** from the server — which
 * is the condition for `canSee` to mean anything. See
 * `docs/research/CORE_FRAMEWORK_AUDIT.md` §7.
 *
 * ─── What `canSee` hides, and why ───────────────────────────────────────────
 *
 * The action disappears when the target **already knows** the character. Introducing yourself twice
 * is neither an error nor an exploit — `upsertKnownIdentity` is idempotent —, but it is
 * a button that does nothing, and an RP menu that offers empty gestures teaches the
 * player to ignore it.
 *
 * The range is the same as the `broadcastProximityMessage` the command already uses to
 * announce the scene (450). Both numbers must be the same: introducing yourself from
 * a distance at which nobody sees `* so-and-so introduces themselves` would be an
 * introduction without a scene.
 */
function registerIdentityInteractions() {
  const interactionRegistry = require('./core/interaction-registry');

  interactionRegistry.unregisterModule('identity');

  interactionRegistry.register({
    id: 'identity.introduce',
    module: 'identity',
    target: interactionRegistry.TARGET_TYPES.PLAYER,
    section: 'social',
    label: 'Introduce yourself',
    order: 10,
    distance: INTRODUCE_RANGE,
    // Introducing yourself is speech: whoever is restrained, downed or dead does not do it.
    // `action-policy` already answers that through the `introduce` action, registered there
    // since forever — reusing it is what avoids a second state table.
    policyAction: 'introduce',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    // Synchronous and free: reads the observer's in-memory cache, loaded at their
    // login. A `canSee` that went to the DB would cost one query per action
    // per aim — exactly what §22 of the request says not to do.
    canSee: ctx => !identity.getKnownDisplayName(ctx.target.characterId, ctx.characterId),
    execute: async ctx => {
      await handleIntroduceCommand(ctx.actorId, `0x${ctx.target.actorId.toString(16)}`);
      return { message: null };
    }
  });
}

// Staff commands (CORE — available regardless of modules)
function registerCoreCommands() {
  registerIdentityInteractions();

  commandRegistry.register(['/introduce', '/apresentar'], (actorId, args) => {
    handleIntroduceCommand(actorId, args).catch(err => {
      console.error('[identity] Failed to introduce character:', err.message);
      sendNotification(actorId, 'Could not record the introduction.');
    });
  }, {
    module: 'identity', phase: 'core',
    description: 'Introduces your character to someone else', usage: '/introduce <actorId>',
    // Task 11 (Legacy Command Cleanup): redundant since it became
    // `identity.introduce` in the Interaction Framework (earlier in this
    // file) — it disappears from the interaction menu when the target already knows the
    // character, and the `[E]` prompt lands in the same place. The command stays
    // registered (bad-network/staff fallback), it just does not show up in a future /help
    // that passes `playerFacing: true`.
    hidden: true
  });

  commandRegistry.register(['/alias', '/apelido'], (actorId, args) => {
    handleAliasCommand(actorId, args).catch(err => {
      console.error('[identity] Failed to set alias:', err.message);
      sendNotification(actorId, 'Could not save the nickname.');
    });
  }, { module: 'identity', phase: 'core', description: 'Sets the name you know someone by', usage: '/alias <actorId> <name>' });

  commandRegistry.register('/anim', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const adminService = require('./admin-service');
      adminService.playAnimation(actorId, parseInt(parts[0], 16), parts[1] || 'IdleStop');
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Plays an animation on an actor', usage: '/anim <actorId> <animName>' });

  commandRegistry.register('/additem', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').giveItemAdmin(actorId, parseInt(parts[0], 16), parseInt(parts[1], 16), parseInt(parts[2]) || 1);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Gives an item to a player', usage: '/additem <actorId> <baseId> <count>' });

  commandRegistry.register('/tp', (actorId, args) => {
    if (args) require('./admin-service').teleportTo(actorId, parseInt(args, 16));
  }, { module: 'admin', phase: 'core', description: '[Staff] Teleports to a player', usage: '/tp <actorId>' });

  commandRegistry.register('/kick', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const reason = parts.slice(1).join(' ') || 'No reason given';
      require('./admin-service').kickPlayer(actorId, parseInt(parts[0], 16), reason);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Kicks a player', usage: '/kick <actorId> <reason>' });

  commandRegistry.register('/permakill', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const reason = parts.slice(1).join(' ');
      require('./admin-service').retireCharacter(actorId, parseInt(parts[0], 16), reason);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Permanently retires a character (soft-delete)', usage: '/permakill <actorId> <reason>' });

  commandRegistry.register('/setgold', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').setGold(actorId, parseInt(parts[0], 16), parseInt(parts[1]));
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Sets a player\'s gold', usage: '/setgold <actorId> <amount>' });

  // The English name comes first, the Portuguese one is kept as an alias.
  // `parseActorId` (and not `parseInt(args, 16)` like the other staff ones) because
  // this is the command staff type by copying an id from a log or the panel,
  // where it shows up with the `0x` prefix.
  commandRegistry.register(['/revealidentity', '/revelaridentidade'], (actorId, args) => {
    const targetActorId = parseActorId(args);
    if (!Number.isFinite(targetActorId)) {
      sendNotification(actorId, 'Usage: /revealidentity <actorId>');
      return;
    }
    require('./admin-service').revealIdentity(actorId, targetActorId).catch(err => {
      console.error('[identity] Failed to reveal identity:', err.message);
      sendNotification(actorId, '[Staff] Could not reveal the identity.');
    });
  }, { module: 'admin', phase: 'core', description: '[Staff] Reveals a character\'s real name (audited)', usage: '/revealidentity <actorId>' });

  // /status — character state diagnostics (staff)
  commandRegistry.register('/status', (actorId, args) => {
    const charData = getActiveCharacterData(actorId);
    if (!charData) return;
    const state = characterState.get(charData.characterId);
    const meta = characterState.getMetadata(charData.characterId);
    sendNotification(actorId, `[Staff] State: ${state} | ${JSON.stringify(meta)}`);
  }, { module: 'admin', phase: 'core', description: '[Staff] Shows the character\'s current state', usage: '/status' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chat input handler
// ─────────────────────────────────────────────────────────────────────────────

function handleChatInput(actorId, text) {
  if (!text || typeof text !== 'string') return;

  // 1. Try rp-chat-service (/say, /me, /do commands, etc.)
  if (rpChat.handleChatInput(actorId, text)) {
    return;
  }

  // 2. Try the command-registry (module commands)
  if (text.startsWith('/')) {
    const parts = text.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const handled = commandRegistry.dispatch(actorId, command, args);
    if (!handled) {
      sendNotification(actorId, `Unknown command: ${command}`);
    }
    return;
  }

  // 3. Default chat (local speech)
  const charName = getCharacterName(actorId);
  broadcastProximityMessage(actorId, `${charName} says: ${text}`, 1200);
}

// Register the CORE commands when the module loads
registerCoreCommands();

module.exports = {
  registerActiveCharacter,
  removeActiveCharacter,
  getActiveCharacterData,

  // An alias of `getActiveCharacterData`, not decoration: `phase0-basic.js`
  // passes `commands.getCharacterData` to `createTargetResolvers` and to
  // `createInteractionService` since 2026-08-13, and the name was never on this
  // object. `createTargetResolvers` throws when it receives `undefined`, and the
  // throw happens in the module body — meaning **the server did not start**,
  // and no test caught it because none of them loads `phase0-basic.js`.
  //
  // The alias, and not a rename: `getActiveCharacterData` is the name used by
  // a dozen callers and several tests, and the core prefers `getCharacter`
  // because for it there is no "active" — there is "the server knows who it is".
  getCharacterData: getActiveCharacterData,

  getActiveActorByCharacterId,
  listActiveActorIds,
  handleChatInput,
  broadcastProximityMessage,
  sendNotification,
  sendChoice,
  onCharacterRemoved
};
